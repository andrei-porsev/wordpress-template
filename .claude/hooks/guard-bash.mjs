/**
 * PreToolUse (Bash, PowerShell): запись в файлы через оболочку не должна обходить guard-paths.
 * Смотрит сегменты цепочки и конвейера: если сегмент пишет (>, tee, sed -i, cp, mv, rm, touch,
 * Set-Content, Remove-Item…) и целью оказывается запрещённый путь (ядро WP, чужой пакет, wp-config,
 * хуки и настройки агента, .git) — блокирует.
 * Свой код (тема, плагины из project.json) — только Edit / Write: запись через оболочку и разовым скриптом (node -e, heredoc),
 * которая пишет в wp-content, обходит хук post-edit (линтер, копия с сервера, заливка, откат) — блокирует (решение 048).
 * Разовые скрипты на Python (python -c, python -, heredoc) — блокирует; запуск готового .py (скиллы) — нет.
 * Сборка (assets/css/, build/, .map), бинарные файлы (картинки, шрифты), rm, mkdir — можно.
 * Не видит записи внутри готовых скриптов (node script.mjs, npm run build): это ограничение, а не защита.
 * Команды на сервере (ssh-exec.mjs) разбирает guard-wpcli.
 */
import { audit, firstWord, loadProject, packageOf, pathViolation, projectSlugs, readInput, redirectTargets, repoRoot, safe, segmentsOf, toRel, unquoted } from './lib.mjs';

const BASH_WRITE = new Set( [ 'tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'truncate', 'dd', 'install' ] );
const PS_WRITE = new Set( [
	'set-content', 'add-content', 'out-file', 'clear-content', 'remove-item', 'move-item', 'copy-item',
	'new-item', 'rename-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'move', 'mv', 'copy', 'cp',
	'ren', 'mkdir', 'md', 'ni', 'sc', 'ac',
] );

// Текстовый код пакета: его правка должна пройти через хук post-edit.
const CODE_EXT = /\.(php|scss|sass|css|js|mjs|cjs|ts|tsx|jsx|json|html|twig|txt|md|xml)$/i;
// Результат сборки пишет компилятор.
const BUILD = /\/(build|dist)\/|\/assets\/css\/|\.map$/i;
// Команды, которые пишут в цель (rm, mkdir — нет: удалить файл или создать папку через Edit нельзя).
const CODE_WRITE = new Set( [ 'tee', 'cp', 'mv', 'touch', 'truncate', 'dd', 'install', 'set-content', 'add-content', 'out-file', 'clear-content', 'copy-item', 'move-item', 'new-item', 'rename-item', 'move', 'copy', 'ren', 'ni', 'sc', 'ac' ] );
// У cp / mv свой код — только цель (последний аргумент): копировать из темы можно.
const TARGET_LAST = new Set( [ 'cp', 'mv', 'install', 'copy', 'move', 'copy-item', 'move-item' ] );
// Разовый скрипт: код в аргументе или со стандартного ввода.
const INLINE = /^(node|python|python3|py)(\.exe)?$/;
const INLINE_FLAG = /\s(-e|--eval|-p|--print|-c|-)(\s|$)|<</;
const WRITE_API = /writeFile|appendFile|renameSync|copyFile|unlink|rmSync|createWriteStream|write_text|write_bytes|shutil\.|open\([^)]*['"][wa]/;
const EDIT_HINT = 'Свой код — только Edit / Write (массовая замена — серией Edit): иначе хук post-edit не проверит линтером, не сохранит копию с сервера, не зальёт и не откатит.';

function ownCode( root, rel ) {
	const pkg = packageOf( rel );
	if ( ! pkg || ! CODE_EXT.test( rel ) || BUILD.test( rel ) ) {
		return false;
	}
	return projectSlugs( loadProject( root ), pkg.kind ).includes( pkg.slug );
}

function stripQuotes( token ) {
	return token.replace( /^["']|["']$/g, '' );
}

function deny( root, reason, command ) {
	audit( root, 'guard-bash-deny', { reason, command: command.slice( 0, 200 ) } );
	process.stdout.write( JSON.stringify( {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: `Заблокировано: запись через оболочку. ${ reason }`,
		},
	} ) );
	process.exit( 0 );
}

await safe( () => {
	const input = readInput();
	const command = String( input.tool_input?.command || '' );
	if ( ! command.trim() ) {
		return;
	}
	const root = repoRoot( input );
	const checkTarget = ( token ) => {
		const t = stripQuotes( token );
		if ( ! t || t.startsWith( '-' ) || t.startsWith( '$' ) ) {
			return;
		}
		const why = pathViolation( root, toRel( root, t ) );
		if ( why ) {
			deny( root, why, command );
		}
	};

	const dev = process.env.CLAUDE_TEMPLATE_DEV === '1';
	const checkOwn = ( token ) => {
		const t = stripQuotes( token );
		if ( ! dev && t && ! t.startsWith( '-' ) && ! t.startsWith( '$' ) && ownCode( root, toRel( root, t ) ) ) {
			deny( root, `${ toRel( root, t ) } — ${ EDIT_HINT }`, command );
		}
	};

	// Цели перенаправлений: echo x > wp-config.php.
	for ( const target of redirectTargets( command ) ) {
		checkTarget( target );
		checkOwn( target );
	}

	// Разовые скрипты: Python — нет совсем, node — не в wp-content.
	for ( const segment of segmentsOf( command ) ) {
		const word = firstWord( unquoted( segment ) ).replace( /^.*[\\/]/, '' ).toLowerCase();
		if ( dev || ! INLINE.test( word ) || ! INLINE_FLAG.test( unquoted( segment ) ) ) {
			continue;
		}
		if ( word.startsWith( 'py' ) ) {
			deny( root, 'Разовые скрипты на Python не используем: правка кода — Edit / Write, разовая обработка — node (готовый .py скилла запускать можно).', command );
		}
		if ( command.includes( 'wp-content/' ) && WRITE_API.test( command ) ) {
			deny( root, `разовый скрипт пишет в wp-content. ${ EDIT_HINT }`, command );
		}
	}

	for ( const segment of segmentsOf( command ) ) {
		const word = firstWord( unquoted( segment ) ).replace( /^.*[\\/]/, '' ).toLowerCase();
		const isSedI = word === 'sed' && /\s-[A-Za-z]*i/.test( segment );
		if ( ! BASH_WRITE.has( word ) && ! PS_WRITE.has( word ) && ! isSedI ) {
			continue;
		}
		const tokens = segment.trim().split( /\s+/ ).slice( 1 );
		for ( const token of tokens ) {
			checkTarget( token );
		}
		if ( isSedI || CODE_WRITE.has( word ) ) {
			( TARGET_LAST.has( word ) ? tokens.slice( -1 ) : tokens ).forEach( checkOwn );
		}
	}
} );
