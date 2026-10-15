/**
 * Проверка stage-config: сборка sftp-stage.json по профилю ~/.wp-template/servers.json и promote после переезда.
 * node .claude/skills/project-ops/tests/test-stage-config.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'stage-config.mjs' );
const base = join( tmpdir(), 'wp-template-test-stage-config' );
const home = join( base, 'home' );
const proj = join( base, 'project' );
rmSync( base, { recursive: true, force: true } );
mkdirSync( join( proj, '.vscode' ), { recursive: true } );
mkdirSync( join( proj, '.claude', '.state' ), { recursive: true } );
mkdirSync( home, { recursive: true } );

const json = ( p ) => JSON.parse( readFileSync( p, 'utf8' ) );
const write = ( p, d ) => writeFileSync( p, JSON.stringify( d ) );
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8', env: { ...process.env, WP_TEMPLATE_HOME: home } } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};

const ignore = [ '/*', '!/wp-content', '/wp-content/*', '!/wp-content/themes', '/wp-content/themes/*', '!/wp-content/themes/acme' ];
write( join( proj, '.vscode', 'sftp.json' ), { host: 'old.example', username: 'olduser', password: 'oldpass', remotePath: '/public_html', ignore, watcher: { files: 'x' }, uploadOnSave: true } );
write( join( proj, '.vscode', 'ssh.json' ), { host: '', cwd: '' } );
write( join( proj, '.claude', '.state', 'sync-sftp.json' ), { files: { a: 1 } } );

let r = run( 'build', 'acme' );
check( 'без профиля — понятная ошибка', r.code === 1 && /servers\.example\.json/.test( r.out ), r.out );

write( join( home, 'servers.json' ), { servers: { vps: {
	host: 'vps.example', port: 22, username: '{project}_dev', privateKeyPath: 'C:/keys/id_ed25519', remotePath: '/httpdocs',
	stageUrl: 'https://{project}.stage.example', httpAuth: { user: 'stage', password: 'secret-http' },
} } } );
r = run( 'build', 'acme' );
check( 'план без --yes', r.code === 0 && /ПЛАН/.test( r.out ) && ! existsSync( join( proj, '.vscode', 'sftp-stage.json' ) ), r.out );
check( 'план: пользователь и URL по шаблону', /acme_dev@vps\.example/.test( r.out ) && /https:\/\/acme\.stage\.example/.test( r.out ), r.out );
check( 'секреты не в выводе', ! /secret-http|oldpass/.test( r.out ), r.out );

r = run( 'build', 'acme', '--yes' );
const st = json( join( proj, '.vscode', 'sftp-stage.json' ) );
check( 'sftp-stage.json записан', st.host === 'vps.example' && st.username === 'acme_dev' && st.remotePath === '/httpdocs', JSON.stringify( st ) );
check( 'ignore и watcher — из sftp.json проекта', JSON.stringify( st.ignore ) === JSON.stringify( ignore ) && st.watcher.files === 'x' );
check( 'httpAuth перенесён, uploadOnSave выключен', st.httpAuth?.user === 'stage' && st.uploadOnSave === false );
check( 'ssh-stage.json: cwd = remotePath', json( join( proj, '.vscode', 'ssh-stage.json' ) ).cwd === '/httpdocs' );
check( 'неверное имя проекта — отказ', run( 'build', 'ac me' ).code === 1 );
const pw = json( join( proj, '.vscode', 'playwright-mcp.json' ) );
check( 'пароль stage для браузера — только для origin stage', pw.browser.contextOptions.httpCredentials.origin === 'https://acme.stage.example' && pw.browser.contextOptions.httpCredentials.username === 'stage' );

write( join( proj, '.claude', '.state', 'sync-sftp-stage.json' ), { files: { b: 2 } } );
r = run( 'promote' );
check( 'promote: план без --yes', /ПЛАН/.test( r.out ) && json( join( proj, '.vscode', 'sftp.json' ) ).host === 'old.example', r.out );
r = run( 'promote', '--yes' );
const prod = json( join( proj, '.vscode', 'sftp.json' ) );
check( 'promote: новый прод — бывший stage', prod.host === 'vps.example' && prod.username === 'acme_dev', JSON.stringify( prod ) );
check( 'promote: старый прод → sftp.old.json', json( join( proj, '.vscode', 'sftp.old.json' ) ).host === 'old.example' );
check( 'promote: stage-конфига больше нет', ! existsSync( join( proj, '.vscode', 'sftp-stage.json' ) ) );
check( 'promote: uploadOnSave как у прежнего прода', prod.uploadOnSave === true );
check( 'promote: снимок синхронизации stage стал продовым', json( join( proj, '.claude', '.state', 'sync-sftp.json' ) ).files.b === 2 );

console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки stage-config прошли' );
process.exit( fails ? 1 : 0 );
