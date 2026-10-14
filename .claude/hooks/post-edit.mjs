/**
 * PostToolUse (Write|Edit|MultiEdit):
 *  1. помечает структурные правки для Stop-хука (карта project-base);
 *  2. режимы guarded-auto / stage-auto: php -l → бэкап файла с сервера → заливка →
 *     проверка сайта (HTTP, debug.log) → откат при ошибке. manual — не заливает, только php -l и отчёт phpcs/stylelint.
 * Проверку в браузере делает агент.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	accessField,
	audit,
	block,
	deployConfigured,
	deployMode,
	firstUrl,
	loadState,
	packageOf,
	readInput,
	repoRoot,
	safe,
	saveState,
	toRel,
} from './lib.mjs';

const STRUCTURAL = [
	/\b(function|class|interface|trait)\s+[A-Za-z_]/,
	/\badd_(action|filter)\s*\(/,
	/\bregister_[a-z_]+\s*\(/,
	/@(mixin|function)\s/,
];

function newContent( input ) {
	const ti = input.tool_input || {};
	if ( typeof ti.content === 'string' ) {
		return ti.content;
	}
	if ( typeof ti.new_string === 'string' ) {
		return ti.new_string;
	}
	if ( Array.isArray( ti.edits ) ) {
		return ti.edits.map( ( e ) => e.new_string || '' ).join( '\n' );
	}
	return '';
}

function shQuote( s ) {
	return `'${ String( s ).split( "'" ).join( "'\\''" ) }'`;
}

const MAX_TRIES = 3;

// Локальные проверки стиля: phpcs (WordPress) и stylelint (SCSS). Нет инструмента — молча пропускаем.
function qualityReport( root, rel ) {
	const full = join( root, rel );
	const notes = [];
	if ( rel.endsWith( '.php' ) ) {
		const has = spawnSync( 'phpcs', [ '--version' ], { encoding: 'utf8', shell: true } ).status === 0;
		if ( has ) {
			const r = spawnSync( 'phpcs', [ '-n', '-q', '--report=emacs', `"${ full }"` ], { cwd: root, encoding: 'utf8', shell: true, timeout: 60000 } );
			const out = String( r.stdout || '' ).trim();
			if ( r.status !== 0 && out ) {
				notes.push( `phpcs (ошибки WordPress Coding Standards):\n${ out.split( '\n' ).slice( 0, 8 ).join( '\n' ) }` );
			}
		}
	}
	if ( rel.endsWith( '.scss' ) ) {
		const bin = join( root, '.claude', 'skills', 'project-ops', 'node_modules', 'stylelint', 'bin', 'stylelint.mjs' );
		const config = join( root, '.stylelintrc.json' );
		if ( existsSync( bin ) && existsSync( config ) ) {
			const r = spawnSync( process.execPath, [ bin, '--no-color', '--config', config, '--config-basedir', join( root, '.claude', 'skills', 'project-ops' ), full ], { cwd: root, encoding: 'utf8', timeout: 60000 } );
			// Отчёт stylelint идёт в stderr.
			const out = `${ r.stdout || '' }${ r.stderr || '' }`.trim();
			if ( r.status !== 0 && out ) {
				notes.push( `stylelint:\n${ out.split( '\n' ).slice( 0, 12 ).join( '\n' ) }` );
			}
		}
	}
	return notes.join( '\n' );
}

// Локальный php -l: null — PHP нет или синтаксис верный, иначе текст ошибки.
function localLint( root, rel ) {
	if ( spawnSync( 'php', [ '-v' ], { encoding: 'utf8' } ).status !== 0 ) {
		return null;
	}
	const r = spawnSync( 'php', [ '-l', join( root, rel ) ], { encoding: 'utf8' } );
	return r.status === 0 ? null : `${ r.stdout || '' }${ r.stderr || '' }`.trim();
}

// Ответ агенту без блокировки: контекст в результат хука.
function emit( text ) {
	if ( ! text ) {
		return;
	}
	process.stdout.write( JSON.stringify( {
		hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
	} ) );
}

await safe( async () => {
	const input = readInput();
	const root = repoRoot( input );
	const abs = input.tool_input?.file_path;
	const rel = toRel( root, abs );
	if ( ! rel ) {
		return;
	}
	const sessionId = input.session_id;
	const state = loadState( root, sessionId );

	// Правка материалов проекта: карта могла быть обновлена.
	if ( rel.startsWith( 'project-base/' ) && rel.endsWith( '.md' ) ) {
		state.mapTouched = true;
		saveState( root, sessionId, state );
		return;
	}

	const pkg = packageOf( rel );
	if ( ! pkg || rel.endsWith( '.md' ) ) {
		return;
	}

	// Структурная правка → карта должна быть обновлена до конца хода.
	const created = input.tool_response?.type === 'create';
	const text = newContent( input );
	if ( created || STRUCTURAL.some( ( re ) => re.test( text ) ) ) {
		state.structural[ rel ] = created ? 'новый файл' : 'функция/класс/хук';
		state.mapTouched = false;
		state.reminded = false;
		saveState( root, sessionId, state );
	}

	const quality = qualityReport( root, rel );
	const mode = deployMode( root );
	if ( mode === 'manual' ) {
		// manual не заливает, но синтаксис PHP проверяет до запроса на заливку.
		const lint = rel.endsWith( '.php' ) ? localLint( root, rel ) : null;
		if ( lint ) {
			audit( root, 'lint-fail', { rel } );
			block( `php -l: ошибка синтаксиса в ${ rel }. Исправь до запроса на заливку.\n${ lint }${ quality ? `\n${ quality }` : '' }` );
		}
		emit( quality );
		return;
	}
	const stage = mode === 'stage-auto';
	if ( ! deployConfigured( root, stage ? 'sftp-stage.json' : 'sftp.json' ) ) {
		emit( quality );
		return;
	}
	const fullPath = join( root, rel );
	if ( ! existsSync( fullPath ) || statSync( fullPath ).isDirectory() ) {
		return;
	}

	const env = stage ? { SFTP_CONFIG: 'sftp-stage.json', SSH_CONFIG: 'ssh-stage.json' } : {};
	const ops = join( root, '.claude', 'skills', 'project-ops', 'scripts' );
	const run = ( script, args ) => spawnSync( process.execPath, [ join( ops, script ), ...args ], {
		cwd: root,
		encoding: 'utf8',
		timeout: 60000,
		env: { ...process.env, ...env },
	} );
	const outOf = ( r ) => `${ r.stdout || '' }${ r.stderr || '' }`.trim();

	const isPhp = rel.endsWith( '.php' );
	state.failures = state.failures || {};
	const fail = ( message ) => {
		state.failures[ rel ] = ( state.failures[ rel ] || 0 ) + 1;
		saveState( root, sessionId, state );
		const n = state.failures[ rel ];
		audit( root, 'deploy-fail', { rel, mode, n, message: message.slice( 0, 200 ) } );
		const tail = n >= MAX_TRIES
			? `\nЛИМИТ ПОПЫТОК (${ n } из ${ MAX_TRIES }): не правь этот файл дальше. Опиши пользователю, что не получается, и спроси, как быть.`
			: `\nПопытка ${ n } из ${ MAX_TRIES }.`;
		block( message + tail );
	};

	// 1) Синтаксис до заливки: локальный php, если он есть.
	const localPhp = isPhp && spawnSync( 'php', [ '-v' ], { encoding: 'utf8' } ).status === 0;
	if ( localPhp ) {
		const lint = spawnSync( 'php', [ '-l', fullPath ], { encoding: 'utf8' } );
		if ( lint.status !== 0 ) {
			fail( `php -l: ошибка синтаксиса в ${ rel }, на сервер НЕ залито.\n${ outOf( lint ) }` );
		}
	}

	// 2) Хвост debug.log до заливки, чтобы потом увидеть только новые ошибки.
	let logBase = null;
	if ( isPhp ) {
		const r = run( 'ssh-exec.mjs', [ '--', 'wc -l < wp-content/debug.log 2>/dev/null || echo 0' ] );
		if ( r.status === 0 ) {
			logBase = parseInt( r.stdout, 10 ) || 0;
		}
	}

	// 3) Бэкап серверной версии (код 3 — файла на сервере ещё нет).
	const backup = join( root, '.claude', '.state', 'backup', sessionId || 'default', rel );
	const fetched = run( 'sftp-sync.mjs', [ 'fetch', rel, backup ] );
	if ( fetched.status !== 0 && fetched.status !== 3 ) {
		fail( `Заливка ${ rel } не выполнена: нет связи с сервером.\n${ outOf( fetched ) }` );
	}
	const hadRemote = fetched.status === 0;

	const rollback = () => {
		const r = hadRemote ? run( 'sftp-sync.mjs', [ 'put', backup, rel ] ) : run( 'sftp-sync.mjs', [ 'remove', rel ] );
		return r.status === 0
			? 'Файл на сервере откачен к прежней версии (локальная правка осталась).'
			: `ОТКАТ НЕ УДАЛСЯ, проверь сервер вручную: ${ outOf( r ) }`;
	};

	// 4) Заливка.
	const up = run( 'sftp-sync.mjs', [ 'upload', rel ] );
	if ( up.status !== 0 ) {
		fail( `Заливка ${ rel } не удалась.\n${ outOf( up ) }` );
	}

	const problems = [];

	// 5) Синтаксис на сервере, если локального php нет.
	if ( isPhp && ! localPhp ) {
		const r = run( 'ssh-exec.mjs', [ '--', `php -l ${ shQuote( rel ) }` ] );
		if ( /Parse error|Errors parsing/i.test( outOf( r ) ) ) {
			problems.push( `php -l на сервере: ${ outOf( r ) }` );
		}
	}

	// 6) Сайт отвечает без 5xx (главная: ловит fatal в functions.php и плагинах).
	const url = firstUrl( stage ? accessField( root, 'Stage / dev URL' ) : accessField( root, 'Публичный URL' ) )
		|| firstUrl( accessField( root, 'Публичный URL' ) );
	let status = null;
	if ( isPhp && url ) {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout( () => ctrl.abort(), 20000 );
			const res = await fetch( `${ url }/?claude-check=${ Date.now() }`, { signal: ctrl.signal, redirect: 'follow' } );
			clearTimeout( timer );
			status = res.status;
			if ( status >= 500 ) {
				problems.push( `сайт отвечает HTTP ${ status }` );
			}
		} catch {
			// Нет ответа — не откатываем: сеть или защита сайта.
		}
	}

	// 7) Новые PHP Fatal / Parse в debug.log.
	if ( isPhp && logBase !== null && ! problems.length ) {
		const r = run( 'ssh-exec.mjs', [
			'--',
			`tail -n +${ logBase + 1 } wp-content/debug.log 2>/dev/null | grep -E 'PHP (Fatal|Parse)' | tail -n 3`,
		] );
		if ( r.status === 0 && r.stdout.trim() ) {
			problems.push( `в debug.log: ${ r.stdout.trim() }` );
		}
	}

	if ( problems.length ) {
		audit( root, 'rollback', { rel, problems } );
		fail( `${ rel }: ${ problems.join( '; ' ) }\n${ rollback() }` );
	}

	delete state.failures[ rel ];
	saveState( root, sessionId, state );
	audit( root, 'upload', { rel, mode, status } );
	const note = `Залито на ${ stage ? 'stage' : 'сервер' }: ${ rel }${ status ? `; сайт HTTP ${ status }` : '' }. Проверь правку в браузере.`;
	emit( quality ? `${ note }\n${ quality }` : note );
} );
