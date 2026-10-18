/**
 * PostToolUse (Write|Edit|MultiEdit):
 *  1. помечает структурные правки для Stop-хука (карта project-base);
 *  2. режимы guarded-auto / stage-auto: php -l → бэкап файла с сервера (изменён после сверки — стоп) → заливка →
 *     проверка сайта (HTTP, debug.log по SSH или SFTP) → откат при ошибке.
 *     manual — не заливает, только php -l и отчёт phpcs/stylelint; local — то же + проверка локального сайта.
 * Проверку в браузере делает агент.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	accessField,
	audit,
	block,
	deployConfig,
	deployConfigured,
	deployMode,
	firstUrl,
	loadState,
	packageOf,
	readInput,
	repoRoot,
	safe,
	saveState,
	snapshotHash,
	syncHash,
	toRel,
} from './lib.mjs';

// GET сайта без 5xx-проверки внутри; httpAuth — защита каталога stage (пароль не в адресе).
async function siteStatus( url, auth ) {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout( () => ctrl.abort(), 20000 );
		const headers = auth?.user ? { Authorization: 'Basic ' + Buffer.from( `${ auth.user }:${ auth.password || '' }` ).toString( 'base64' ) } : {};
		const res = await fetch( `${ url }/?claude-check=${ Date.now() }`, { signal: ctrl.signal, redirect: 'follow', headers } );
		clearTimeout( timer );
		return res.status;
	} catch {
		// Нет ответа — не откатываем: сеть или защита сайта.
		return null;
	}
}

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
	if ( mode === 'manual' || mode === 'local' ) {
		// manual / local не заливают, но синтаксис PHP проверяют до запроса на заливку.
		const lint = rel.endsWith( '.php' ) ? localLint( root, rel ) : null;
		if ( lint ) {
			audit( root, 'lint-fail', { rel } );
			block( `php -l: ошибка синтаксиса в ${ rel }. Исправь до запроса на заливку.\n${ lint }${ quality ? `\n${ quality }` : '' }` );
		}
		if ( mode === 'local' && rel.endsWith( '.php' ) ) {
			// Локальный сайт видит правку сразу (проект в папке сайта или junction): ловим fatal без заливки.
			const local = deployConfig( root, 'local.json' );
			const url = firstUrl( local?.url || '' ) || firstUrl( accessField( root, 'Локальный URL' ) );
			const status = url ? await siteStatus( url ) : null;
			if ( status !== null && status >= 500 ) {
				audit( root, 'local-fail', { rel, status } );
				block( `${ rel }: локальный сайт отвечает HTTP ${ status } после правки — исправь (на сервер ничего не заливалось).${ quality ? `\n${ quality }` : '' }` );
			}
			emit( `Локально: ${ rel }${ status ? `; сайт HTTP ${ status }` : url ? '; сайт не ответил (запущен ли в LocalWP / OSPanel?)' : '' }. Проверь правку в браузере.${ quality ? `\n${ quality }` : '' }` );
			return;
		}
		emit( quality );
		return;
	}
	const stage = mode === 'stage-auto';
	const configName = stage ? 'sftp-stage.json' : 'sftp.json';
	if ( ! deployConfigured( root, configName ) ) {
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

	// 2) Хвост debug.log до заливки, чтобы потом увидеть только новые ошибки: по SSH — число строк, без SSH — копия файла по SFTP.
	let logBase = null;
	let logCopy = null;
	const stateDir = join( root, '.claude', '.state', 'backups', 'edit', sessionId || 'default' );
	if ( isPhp ) {
		const r = run( 'ssh-exec.mjs', [ '--', 'wc -l < wp-content/debug.log 2>/dev/null || echo 0' ] );
		if ( r.status === 0 ) {
			logBase = parseInt( r.stdout, 10 ) || 0;
		} else {
			// Нет SSH и нет локального PHP — синтаксис проверить нечем: не заливаем вслепую.
			if ( ! localPhp ) {
				audit( root, 'lint-unavailable', { rel } );
				block( `${ rel }: синтаксис PHP проверить нечем — нет локального PHP, SSH не ответил. На сервер НЕ залито.\n` +
					'Настроить PHP локально (machine-check.mjs → «PHP в PATH») или SSH (connect-check.mjs), затем повторить правку.' );
			}
			logCopy = join( stateDir, '_debug.log.before' );
			const f = run( 'sftp-sync.mjs', [ 'fetch', 'wp-content/debug.log', logCopy ] );
			if ( f.status !== 0 ) {
				logCopy = f.status === 3 ? '' : null;
			}
		}
	}

	// 3) Бэкап серверной версии (код 3 — файла на сервере ещё нет).
	const backup = join( stateDir, rel );
	const fetched = run( 'sftp-sync.mjs', [ 'fetch', rel, backup ] );
	if ( fetched.status !== 0 && fetched.status !== 3 ) {
		fail( `Заливка ${ rel } не выполнена: нет связи с сервером.\n${ outOf( fetched ) }` );
	}
	const hadRemote = fetched.status === 0;

	// 3а) Файл на сервере изменён после последней сверки — чужая правка: заливка поверх её затрёт.
	const known = snapshotHash( root, configName, rel );
	if ( known && ( ! hadRemote || syncHash( readFileSync( backup ) ) !== known ) ) {
		audit( root, 'server-changed', { rel, mode } );
		block( `${ rel }: на сервере файл ${ hadRemote ? 'изменён' : 'удалён' } после последней сверки — НЕ залито, чтобы не затереть чужую правку.\n` +
			'Сначала: sftp-sync.mjs compare → разобраться с пользователем (sync-down или решение по конфликту), потом повторить правку.' );
	}

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
		status = await siteStatus( url, deployConfig( root, configName )?.httpAuth );
		if ( status !== null && status >= 500 ) {
			problems.push( `сайт отвечает HTTP ${ status }` );
		}
	}

	// 7) Новые PHP Fatal / Parse в debug.log: по SSH — хвост после logBase, без SSH — разница копий по SFTP.
	if ( isPhp && logBase !== null && ! problems.length ) {
		const r = run( 'ssh-exec.mjs', [
			'--',
			`tail -n +${ logBase + 1 } wp-content/debug.log 2>/dev/null | grep -E 'PHP (Fatal|Parse)' | tail -n 3`,
		] );
		if ( r.status === 0 && r.stdout.trim() ) {
			problems.push( `в debug.log: ${ r.stdout.trim() }` );
		}
	} else if ( isPhp && logCopy !== null && ! problems.length ) {
		const after = join( stateDir, '_debug.log.after' );
		if ( run( 'sftp-sync.mjs', [ 'fetch', 'wp-content/debug.log', after ] ).status === 0 ) {
			const before = logCopy && existsSync( logCopy ) ? readFileSync( logCopy, 'utf8' ) : '';
			const fresh = readFileSync( after, 'utf8' ).slice( before.length ).split( '\n' ).filter( ( l ) => /PHP (Fatal|Parse)/.test( l ) );
			if ( fresh.length ) {
				problems.push( `в debug.log: ${ fresh.slice( -3 ).join( '\n' ) }` );
			}
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
