/**
 * Сценарии хука post-edit на временном проекте: «сервер» — папка (протокол local), «сайт» — HTTP-сервер теста.
 * Хуки — из HOOKS_DIR (по умолчанию .claude/hooks шаблона).
 * node .claude/skills/project-ops/tests/test-post-edit.mjs
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname( fileURLToPath( import.meta.url ) );
const opsDir = join( here, '..' );
const hooksDir = process.env.HOOKS_DIR || join( here, '..', '..', '..', 'hooks' );
const base = join( tmpdir(), 'wp-template-test-post-edit' );
const proj = join( base, 'project' );
const remote = join( base, 'remote' );
rmSync( base, { recursive: true, force: true } );

const put = ( p, text ) => {
	mkdirSync( dirname( p ), { recursive: true } );
	writeFileSync( p, text );
};
const read = ( p ) => ( existsSync( p ) ? readFileSync( p, 'utf8' ) : null );
const T = 'wp-content/themes/acme/';

mkdirSync( join( proj, '.claude', 'skills' ), { recursive: true } );
cpSync( hooksDir, join( proj, '.claude', 'hooks' ), { recursive: true } );
symlinkSync( opsDir, join( proj, '.claude', 'skills', 'project-ops' ), 'junction' );
put( join( proj, 'project-base', 'project.json' ), JSON.stringify( { stem: 'acme', themes: [ 'acme' ], plugins: [], muPlugins: [], blocks: [] } ) );
const sftp = ( extra = {} ) => JSON.stringify( {
	protocol: 'local', remotePath: remote.replace( /\\/g, '/' ),
	ignore: [ '/*', '!/wp-content', '/wp-content/*', '!/wp-content/themes', '/wp-content/themes/*', '!/wp-content/themes/acme' ], ...extra,
} );
put( join( proj, '.vscode', 'sftp.json' ), sftp() );
put( join( remote, T, 'functions.php' ), '<?php // v1\n' );
put( join( remote, 'wp-content', 'debug.log' ), '[old] PHP Warning: старое\n' );

// «Сайт»: /fatal — дописывает Fatal в debug.log «сервера»; /auth — 500 только с верным паролем (доказывает, что хук его послал).
let siteMode = 'ok';
const server = createServer( ( req, res ) => {
	if ( siteMode === 'fatal' ) {
		appendFileSync( join( remote, 'wp-content', 'debug.log' ), '[new] PHP Fatal error: Uncaught Error in functions.php\n' );
		res.writeHead( 200 );
	} else if ( siteMode === 'auth' ) {
		const ok = req.headers.authorization === 'Basic ' + Buffer.from( 'stage:secret' ).toString( 'base64' );
		res.writeHead( ok ? 500 : 401 );
	} else {
		res.writeHead( 200 );
	}
	res.end( 'ok' );
} );
await new Promise( ( r ) => server.listen( 0, '127.0.0.1', r ) );
const url = `http://127.0.0.1:${ server.address().port }`;
const access = ( mode ) => put( join( proj, 'ACCESS.md' ), `- Режим заливки: ${ mode }\n- Публичный URL: ${ url }\n` );

const edit = async ( rel, text, env = {} ) => {
	put( join( proj, rel ), text );
	const input = JSON.stringify( { tool_name: 'Edit', tool_input: { file_path: join( proj, rel ), new_string: text }, tool_response: {}, session_id: 'test', cwd: proj } );
	const r = await new Promise( ( res ) => {
		const p = spawnSync( process.execPath, [ join( proj, '.claude', 'hooks', 'post-edit.mjs' ) ], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env }, timeout: 120000 } );
		res( p );
	} );
	return { code: r.status, out: `${ r.stdout || '' }${ r.stderr || '' }` };
};
// spawnSync блокирует цикл событий — HTTP-сервер теста отвечать не сможет; хук запускаем асинхронно.
const editAsync = ( rel, text, env = {} ) => new Promise( ( res ) => {
	put( join( proj, rel ), text );
	const input = JSON.stringify( { tool_name: 'Edit', tool_input: { file_path: join( proj, rel ), new_string: text }, tool_response: {}, session_id: 'test', cwd: proj } );
	import( 'node:child_process' ).then( ( { spawn } ) => {
		const p = spawn( process.execPath, [ join( proj, '.claude', 'hooks', 'post-edit.mjs' ) ], { env: { ...process.env, CLAUDE_PROJECT_DIR: proj, ...env } } );
		let out = '';
		p.stdout.on( 'data', ( d ) => ( out += d ) );
		p.stderr.on( 'data', ( d ) => ( out += d ) );
		p.on( 'close', ( code ) => res( { code, out } ) );
		p.stdin.end( input );
	} );
} );
void edit;

let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail.slice( 0, 400 ) }` );
	fails += ok ? 0 : 1;
};
const sync = ( ...args ) => spawnSync( process.execPath, [ join( opsDir, 'scripts', 'sftp-sync.mjs' ), ...args ], { cwd: proj, encoding: 'utf8' } );

// 1. guarded-auto: правка уходит на «сервер».
access( 'guarded-auto' );
sync( 'sync-down' );
let r = await editAsync( T + 'functions.php', '<?php // v2\n' );
check( '1 guarded-auto: залито', r.code === 0 && read( join( remote, T, 'functions.php' ) ).includes( 'v2' ), r.out );

// 2. Чужая правка на сервере после сверки — стоп, сервер не перезаписан.
put( join( remote, T, 'functions.php' ), '<?php // v2 + правка клиента\n' );
r = await editAsync( T + 'functions.php', '<?php // v3\n' );
check( '2 изменён на сервере после сверки — стоп', r.code === 2 && /изменён после последней сверки/.test( r.out ), r.out );
check( '2 правка клиента на сервере цела', read( join( remote, T, 'functions.php' ) ).includes( 'клиента' ) );
sync( 'sync-down', '--force' );

// 3. Ошибка синтаксиса — не залито (если есть локальный php).
const hasPhp = spawnSync( 'php', [ '-v' ] ).status === 0;
if ( hasPhp ) {
	r = await editAsync( T + 'functions.php', '<?php echo "x" \n' );
	check( '3 php -l — стоп, на сервер не залито', r.code === 2 && /php -l/.test( r.out ) && read( join( remote, T, 'functions.php' ) ).includes( 'клиента' ), r.out );
	put( join( proj, T, 'functions.php' ), read( join( remote, T, 'functions.php' ) ) );
}

// 4. Откат хука не выглядит потом чужой правкой.
siteMode = 'fatal';
r = await editAsync( T + 'functions.php', '<?php // v4 ломает сайт\n' );
check( '4 Fatal в debug.log (SFTP, без SSH) — откат', r.code === 2 && /debug\.log/.test( r.out ) && /откачен/.test( r.out ) && read( join( remote, T, 'functions.php' ) ).includes( 'клиента' ), r.out );
siteMode = 'ok';
r = await editAsync( T + 'functions.php', '<?php // v5\n' );
check( '4 после отката следующая правка проходит (снимок знает откат)', r.code === 0 && read( join( remote, T, 'functions.php' ) ).includes( 'v5' ), r.out );

// 5. httpAuth: хук посылает пароль stage (сайт отвечает 500 только с паролем → откат).
put( join( proj, '.vscode', 'sftp.json' ), sftp( { httpAuth: { user: 'stage', password: 'secret' } } ) );
siteMode = 'auth';
r = await editAsync( T + 'functions.php', '<?php // v6\n' );
check( '5 httpAuth передан (500 за паролем → откат)', r.code === 2 && /HTTP 500/.test( r.out ), r.out );
siteMode = 'ok';
put( join( proj, '.vscode', 'sftp.json' ), sftp() );
put( join( proj, T, 'functions.php' ), read( join( remote, T, 'functions.php' ) ) );

// 6. Нет SSH и нет локального PHP — PHP не заливается вслепую.
r = await editAsync( T + 'functions.php', '<?php // v7\n', { PATH: dirname( process.execPath ), Path: dirname( process.execPath ) } );
check( '6 нет PHP и SSH — стоп, не залито', r.code === 2 && /проверить нечем/.test( r.out ) && ! read( join( remote, T, 'functions.php' ) ).includes( 'v7' ), r.out );

// 7. local: не заливает, ловит 500 локального сайта.
access( 'local' );
put( join( proj, '.vscode', 'local.json' ), JSON.stringify( { url } ) );
r = await editAsync( T + 'functions.php', '<?php // v8 локально\n' );
check( '7 local: на сервер не залито', r.code === 0 && ! read( join( remote, T, 'functions.php' ) ).includes( 'v8' ) && /Локально/.test( r.out ), r.out );
siteMode = 'auth';
r = await editAsync( T + 'functions.php', '<?php // v9\n' );
check( '7 local: сайт 401 — не стоп (только 5xx)', r.code === 0, r.out );

// 8. manual (local) — тоже не заливает.
access( 'manual (local)' );
siteMode = 'ok';
r = await editAsync( T + 'functions.php', '<?php // v10\n' );
check( '8 manual (local): не залито', r.code === 0 && ! read( join( remote, T, 'functions.php' ) ).includes( 'v10' ), r.out );

server.close();
console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки post-edit прошли' );
process.exit( fails ? 1 : 0 );
