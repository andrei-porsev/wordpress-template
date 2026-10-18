/**
 * PreToolUse (Bash): охранник команд, которые идут на сервер через ssh-exec.mjs.
 * Код правится только локально (заливает хук post-edit), поэтому на сервере запись в файлы запрещена.
 *  - deny: запись в файлы (>, tee, sed -i, cp, mv, rm…), чтение секретов (wp-config, .env, ключи),
 *          разрушающие WP-CLI (db drop/reset/clean, site empty/delete, DROP/TRUNCATE), sudo;
 *  - allow: чтение логов и каталогов (tail, cat, ls, grep… и их конвейер |), php -v/-l;
 *  - ask: WP-CLI, меняющий сайт или БД (search-replace без --dry-run, db import, update/delete…);
 *    на stage (--stage) — allow после автодампа, кроме db import и произвольного кода; local-exec.mjs — разбирается так же,
 *         eval, составные команды (; && ||), прочие команды;
 *  - без решения: чтение WP-CLI — дальше permissions.allow.
 * allow: wp post create с единственным --post_status=draft (черновик публикует человек); сброс кеша плагинов (CACHE_PURGE).
 * Перед первым ask по WP-CLI за сессию хук сам делает дамп БД (ssh-exec.mjs dump → ../claude-backup/<время>.sql, права 600).
 * Решения (кроме allow) пишутся в журнал .claude/.state/audit.log.
 * Сбой хука: exit 0. Поэтому 'allow' даём только самим хуком, а в permissions.allow — точечные команды чтения.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { audit, firstWord, hasFileRedirect, loadState, readInput, repoRoot, safe, saveState, unquoted } from './lib.mjs';

const READ_VERBS = new Set( [
	'list', 'get', 'status', 'version', 'is-active', 'is-installed', 'exists', 'check', 'info',
	'search', 'path', 'count', 'verify-checksums', 'check-update', 'structure', 'tables', 'size',
	'export', 'flush',
] );

// Сброс кеша страниц и минификации (project-ops → cache.md): контент и код не меняются.
const CACHE_PURGE = new Set( [ 'litespeed-purge all', 'w3-total-cache flush', 'super-cache flush', 'sg purge', 'rocket clean' ] );

// Команды оболочки, которые только читают.
const READ_CMDS = new Set( [ 'tail', 'head', 'cat', 'ls', 'wc', 'grep', 'pwd', 'date', 'df', 'du', 'stat', 'sort', 'uniq', 'cut' ] );

// Команды, которые пишут в файлы или ставят что-то на сервер.
const WRITE_CMDS = new Set( [
	'tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'truncate', 'dd', 'install',
	'vi', 'vim', 'nano', 'ed', 'wget', 'unzip', 'tar', 'zip', 'git', 'composer', 'npm', 'pip',
] );

const SECRETS = /wp-config|\.env\b|\.ssh|id_rsa|id_ed25519|\.pem\b|\.htpasswd/i;
const DUMP_HINT = 'Перед изменением БД сделай дамп: wp db export.';

// Контекст текущего вызова: нужен для журнала и автодампа.
// local — local-exec.mjs (дамп делает сам скрипт); stage — --stage; strict — подтверждение и на stage;
// foreign — скрипт другого проекта (абсолютный путь вне корня): автодамп хука ушёл бы не на тот сервер.
const ctx = { root: process.cwd(), input: {}, command: '', remote: '', wp: false, local: false, stage: false, strict: false, foreign: false, script: '' };
const norm = ( p ) => p.replaceAll( '\\', '/' ).replace( /^\/([a-z])\//i, '$1:/' ).toLowerCase();

const state = () => loadState( ctx.root, ctx.input.session_id );

// Дамп БД на сервере перед первой изменяющей командой WP-CLI за сессию (отдельно для прода и stage).
function dumpOnce() {
	const { root, input, command } = ctx;
	const st = state();
	const key = ctx.stage ? 'dumpedStage' : 'dumped';
	if ( st[ key ] ) {
		return `Дамп в этой сессии уже сделан: ${ st[ key ] }.`;
	}
	const script = join( root, '.claude', 'skills', 'project-ops', 'scripts', 'ssh-exec.mjs' );
	const flag = command.includes( ' --stage' ) ? [ '--stage' ] : [];
	const r = spawnSync( process.execPath, [ script, ...flag, 'dump' ], { cwd: root, encoding: 'utf8', timeout: 120000 } );
	const file = ( ( r.stdout || '' ).match( /^DUMP (\S+)/m ) || [] )[ 1 ];
	if ( r.status === 0 && file ) {
		st[ key ] = file;
		saveState( root, input.session_id, st );
		audit( root, 'db-dump', { file } );
		return `Дамп БД сделан автоматически: ${ file } (на сервере, на уровень выше каталога сайта).`;
	}
	audit( root, 'db-dump-failed', { out: `${ r.stdout || '' }${ r.stderr || '' }`.slice( 0, 200 ) } );
	return 'Автодамп НЕ удался — сделай дамп вручную (wp db export) до подтверждения.';
}

function decide( decision, reason ) {
	let text = reason;
	if ( decision === 'ask' && ctx.wp && ! ctx.local ) {
		text = `${ reason } ${ ctx.foreign ? 'Скрипт другого проекта: автодамп не сделан — дамп вручную (wp db export) в том проекте до подтверждения.' : dumpOnce() }`;
		// Stage — копия для правок: меняющее WP-CLI без подтверждения, но после дампа; разрушающее и произвольный код — как на проде.
		if ( ctx.stage && ! ctx.strict && state().dumpedStage ) {
			decision = 'allow';
			text = `Stage: ${ text }`;
		}
	}
	if ( decision === 'ask' && ctx.local ) {
		text = `${ reason } Локальный сайт: local-exec.mjs сам сделает дамп перед изменением (нужен --yes после «да» пользователя).`;
	}
	if ( decision !== 'allow' ) {
		audit( ctx.root, `wpcli-${ decision }`, { remote: ctx.remote.slice( 0, 200 ) } );
	}
	process.stdout.write( JSON.stringify( {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: decision,
			permissionDecisionReason: text,
		},
	} ) );
	process.exit( 0 );
}
// Команда на сервере: всё после « -- » у ssh-exec.mjs (или local-exec.mjs — локальный сайт), без внешних кавычек.
function remoteCommand( command ) {
	// Только реальный вызов «node …ssh-exec.mjs» в начале команды или после && ; ||; путь — и в кавычках, с пробелами.
	// Упоминание в тексте (heredoc, echo, документация) не считается.
	let call = null;
	for ( const m of command.matchAll( /(?:^|&&|;|\|\|)\s*node\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g ) ) {
		const script = m[ 1 ] ?? m[ 2 ] ?? m[ 3 ];
		const kind = /(ssh|local)-exec\.mjs$/.exec( script );
		if ( kind ) {
			call = { index: m.index, kind: kind[ 1 ], script };
			break;
		}
	}
	if ( ! call ) {
		return null;
	}
	ctx.local = call.kind === 'local';
	ctx.script = call.script;
	const dash = command.indexOf( ' -- ', call.index );
	if ( dash < 0 ) {
		return null;
	}
	let rest = command.slice( dash + 4 ).trim();
	const q = rest[ 0 ];
	if ( ( q === '"' || q === "'" ) && rest.endsWith( q ) ) {
		rest = rest.slice( 1, -1 );
	}
	return rest;
}

// Запись в файл на сервере: одна из сегментов конвейера/цепочки пишет.
function findWrite( remote ) {
	if ( hasFileRedirect( remote ) ) {
		return 'перенаправление вывода в файл (>)';
	}
	for ( const segment of unquoted( remote ).split( /&&|\|\||;|\||\n/ ) ) {
		const word = firstWord( segment ).replace( /^.*\//, '' );
		if ( WRITE_CMDS.has( word ) ) {
			return word;
		}
		if ( word === 'sed' && /\s-[A-Za-z]*i/.test( segment ) ) {
			return 'sed -i';
		}
		if ( word === 'curl' && /\s(-[A-Za-z]*[oO]\b|--output|--remote-name)/.test( segment ) ) {
			return 'curl -o';
		}
		if ( word === 'find' && /\s-(delete|exec|ok|fprint)/.test( segment ) ) {
			return 'find -delete/-exec';
		}
	}
	return null;
}

// Конвейер только из команд чтения (php -v/-l считаются чтением).
function isReadPipeline( remote ) {
	if ( /&&|\|\||;|\n|`|\$\(/.test( unquoted( remote ) ) ) {
		return false;
	}
	return unquoted( remote ).split( '|' ).every( ( seg ) => {
		const words = seg.trim().split( /\s+/ );
		const word = firstWord( seg );
		if ( word === 'php' ) {
			return [ '-v', '--version', '-l', '-m' ].includes( words[ words.indexOf( 'php' ) + 1 ] );
		}
		return READ_CMDS.has( word );
	} );
}

await safe( () => {
	const input = readInput();
	const command = String( input.tool_input?.command || '' );
	const remote = remoteCommand( command );
	if ( remote === null ) {
		return;
	}
	ctx.root = repoRoot( input );
	ctx.input = input;
	ctx.command = command;
	ctx.remote = remote;
	ctx.stage = ! ctx.local && / --stage\b/.test( command );
	ctx.foreign = /^([a-z]:\/|\/)/.test( norm( ctx.script ) ) && ! norm( ctx.script ).startsWith( norm( ctx.root ) + '/' );
	ctx.strict = ctx.foreign;

	if ( /\bsudo\b|\bmkfs\b|>\s*\/dev\/(sd|nvme)/i.test( remote ) ) {
		decide( 'deny', 'Заблокировано: sudo и разрушающие команды на сервере запрещены.' );
	}
	// Разрушающее WP-CLI — блок и внутри составной команды.
	if ( /\bwp\s+(db\s+(drop|reset|clean)|site\s+(empty|delete))\b/.test( remote ) ) {
		decide( 'deny', `Заблокировано: разрушающая команда WP-CLI. ${ DUMP_HINT }` );
	}
	const write = findWrite( remote );
	if ( write ) {
		decide( 'deny', `Заблокировано: на сервере файлы не пишем (${ write }). Код правится локально, на сервер его заливает хук post-edit или sftp-sync upload.` );
	}
	if ( SECRETS.test( remote ) ) {
		decide( 'deny', 'Заблокировано: чтение секретов на сервере (wp-config, .env, ключи).' );
	}

	// Чтение оболочкой: логи, каталоги, версия PHP.
	if ( isReadPipeline( remote ) ) {
		decide( 'allow', 'Чтение на сервере (логи, каталоги, версия PHP).' );
	}

	if ( /[;&|`]|\$\(/.test( remote ) ) {
		// WP-CLI в составной команде (текст через $(… | base64 -d)) — подтверждение с автодампом; на stage тоже подтверждение.
		ctx.wp = /^(\S*\/)?wp\s/.test( remote );
		ctx.strict = true;
		decide( 'ask', 'Составная команда на сервере (; & | ` $()): подтверди.' );
	}

	const tokens = remote.split( /\s+/ ).filter( Boolean );
	if ( tokens[ 0 ] !== 'wp' && ! tokens[ 0 ].endsWith( '/wp' ) && ! tokens[ 0 ].endsWith( '.phar' ) ) {
		decide( 'ask', 'Не WP-CLI и не чтение на сервере: подтверди.' );
	}

	ctx.wp = true;

	// Слова подкоманды без глобальных флагов (--path=…, --url=…, --allow-root).
	const words = tokens.slice( 1 ).filter( ( t ) => ! t.startsWith( '-' ) );
	const [ group = '', verb = '' ] = words;
	const dry = tokens.includes( '--dry-run' );

	if ( group === 'db' && [ 'drop', 'reset', 'clean' ].includes( verb ) ) {
		decide( 'deny', `Заблокировано: wp db ${ verb } уничтожает БД. ${ DUMP_HINT }` );
	}
	if ( group === 'site' && [ 'empty', 'delete' ].includes( verb ) ) {
		decide( 'deny', `Заблокировано: wp site ${ verb } удаляет данные сайта.` );
	}
	if ( group === 'db' && verb === 'query' ) {
		if ( /\b(drop|truncate)\b/i.test( remote ) ) {
			decide( 'deny', 'Заблокировано: DROP / TRUNCATE в wp db query.' );
		}
		if ( /\b(delete|update|insert|alter|replace|create|grant)\b/i.test( remote ) ) {
			decide( 'ask', `Запрос меняет БД: подтверди. ${ DUMP_HINT }` );
		}
		return;
	}
	if ( group === 'search-replace' ) {
		if ( dry ) {
			return;
		}
		decide( 'ask', `search-replace без --dry-run меняет БД: сначала прогон с --dry-run, потом подтверди. ${ DUMP_HINT }` );
	}
	// Перезапись БД и произвольный код — подтверждение и на stage.
	if ( group === 'db' && verb === 'import' ) {
		ctx.strict = true;
		decide( 'ask', `wp db import перезаписывает БД: подтверди. ${ DUMP_HINT }` );
	}
	if ( [ 'eval', 'eval-file', 'shell', 'config', 'package', 'cli' ].includes( group ) ) {
		ctx.strict = true;
		decide( 'ask', `wp ${ group } выполняет произвольный код или меняет конфиг: подтверди.` );
	}

	if ( CACHE_PURGE.has( `${ group } ${ verb }` ) ) {
		decide( 'allow', 'Сброс кеша сайта: контент и код не меняются.' );
	}
	if ( READ_VERBS.has( verb ) ) {
		return;
	}
	// Новый черновик опубликованный сайт не меняет — без подтверждения; публикует человек.
	const statuses = [ ...remote.matchAll( /--post_status[= ]['"]?([\w-]+)/g ) ].map( ( m ) => m[ 1 ] );
	if ( group === 'post' && verb === 'create' && statuses.length === 1 && statuses[ 0 ] === 'draft' ) {
		decide( 'allow', 'Новый черновик: опубликованный сайт не меняется.' );
	}
	decide( 'ask', `wp ${ words.join( ' ' ) } меняет сайт: подтверди. ${ DUMP_HINT }` );
} );
