/**
 * PreToolUse (Bash, PowerShell): запись в файлы через оболочку не должна обходить guard-paths.
 * Смотрит сегменты цепочки и конвейера: если сегмент пишет (>, tee, sed -i, cp, mv, rm, touch,
 * Set-Content, Remove-Item…) и целью оказывается запрещённый путь (ядро WP, чужой пакет, wp-config,
 * хуки и настройки агента, .git) — блокирует.
 * Не видит записи внутри скриптов (node script.mjs, npm run build): это ограничение, а не защита.
 * Команды на сервере (ssh-exec.mjs) разбирает guard-wpcli.
 */
import { audit, firstWord, pathViolation, readInput, redirectTargets, repoRoot, safe, segmentsOf, toRel, unquoted } from './lib.mjs';

const BASH_WRITE = new Set( [ 'tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'truncate', 'dd', 'install' ] );
const PS_WRITE = new Set( [
	'set-content', 'add-content', 'out-file', 'clear-content', 'remove-item', 'move-item', 'copy-item',
	'new-item', 'rename-item', 'rm', 'ri', 'del', 'erase', 'rd', 'rmdir', 'move', 'mv', 'copy', 'cp',
	'ren', 'mkdir', 'md', 'ni', 'sc', 'ac',
] );

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

	// Цели перенаправлений: echo x > wp-config.php.
	for ( const target of redirectTargets( command ) ) {
		checkTarget( target );
	}

	for ( const segment of segmentsOf( command ) ) {
		const word = firstWord( unquoted( segment ) ).replace( /^.*[\\/]/, '' ).toLowerCase();
		const isSedI = word === 'sed' && /\s-[A-Za-z]*i/.test( segment );
		if ( ! BASH_WRITE.has( word ) && ! PS_WRITE.has( word ) && ! isSedI ) {
			continue;
		}
		for ( const token of segment.trim().split( /\s+/ ).slice( 1 ) ) {
			checkTarget( token );
		}
	}
} );
