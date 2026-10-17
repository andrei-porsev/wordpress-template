/**
 * Проверка stage-config: сборка sftp-stage.json по профилю ~/.wp-template/servers.json, пароль на каталог проекта (auth) и promote после переезда.
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

const keyPath = join( base, 'id_ed25519' ).replaceAll( '\\', '/' );
const pubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyOnly agent@test';
writeFileSync( keyPath, 'PRIVATE-KEY-MUST-NOT-LEAK' );
writeFileSync( `${ keyPath }.pub`, pubKey + '\n' );
write( join( home, 'servers.json' ), { servers: { vps: {
	host: 'vps.example', port: 22, username: '{project}_dev', privateKeyPath: keyPath, remotePath: '/httpdocs',
	stageUrl: 'https://{project}.stage.example', php: '8.2',
} } } );
r = run( 'build', 'acme' );
check( 'план без --yes', r.code === 0 && /ПЛАН/.test( r.out ) && ! existsSync( join( proj, '.vscode', 'sftp-stage.json' ) ), r.out );
check( 'план: пользователь и URL по шаблону', /acme_dev@vps\.example/.test( r.out ) && /https:\/\/acme\.stage\.example/.test( r.out ), r.out );
check( 'секреты не в выводе', ! /secret-http|oldpass/.test( r.out ), r.out );

r = run( 'build', 'acme', '--yes' );
let st = json( join( proj, '.vscode', 'sftp-stage.json' ) );
check( 'sftp-stage.json записан', st.host === 'vps.example' && st.username === 'acme_dev' && st.remotePath === '/httpdocs', JSON.stringify( st ) );
check( 'ignore и watcher — из sftp.json проекта', JSON.stringify( st.ignore ) === JSON.stringify( ignore ) && st.watcher.files === 'x' );
check( 'без httpAuth — подсказка про пароль на каталог, uploadOnSave выключен', ! st.httpAuth && /stage-config\.mjs auth acme/.test( r.out ) && st.uploadOnSave === false, r.out );
check( 'ssh-stage.json: cwd = remotePath', json( join( proj, '.vscode', 'ssh-stage.json' ) ).cwd === '/httpdocs' );
check( 'неверное имя проекта — отказ', run( 'build', 'ac me' ).code === 1 );

// Команда для SSH Terminal: публичный ключ и PATH версии из профиля; приватный ключ не печатается; повтор не дублирует.
const cmdLine = r.out.split( '\n' ).find( ( l ) => l.startsWith( 'mkdir -p ~/.ssh' ) ) || '';
check( 'команда для SSH Terminal: ключ и PHP 8.2', cmdLine.includes( pubKey ) && cmdLine.includes( '/opt/plesk/php/8.2/bin' ), r.out );
check( 'приватный ключ не в выводе', ! /PRIVATE-KEY-MUST-NOT-LEAK/.test( r.out ) );
const fakeHome = join( base, 'remote-home' );
mkdirSync( fakeHome, { recursive: true } );
writeFileSync( join( fakeHome, '.bashrc' ), 'export PATH=/opt/plesk/php/7.4/bin:$PATH\nalias ll="ls -l"\n' );
const shellPart = cmdLine.replace( / && source ~\/\.bashrc.*$/, '' );
const bash = ( c ) => spawnSync( 'bash', [ '-c', c ], { encoding: 'utf8', env: { ...process.env, HOME: fakeHome.replaceAll( '\\', '/' ) } } );
if ( bash( 'true' ).status === 0 ) {
	bash( shellPart );
	const b2 = bash( shellPart );
	const keys = readFileSync( join( fakeHome, '.ssh', 'authorized_keys' ), 'utf8' ).trim().split( '\n' );
	const rc = readFileSync( join( fakeHome, '.bashrc' ), 'utf8' );
	check( 'повтор: ключ один раз', b2.status === 0 && keys.length === 1 && keys[ 0 ] === pubKey, keys.join( '|' ) + b2.stderr );
	check( 'повтор: одна строка PATH новой версии, остальное в .bashrc сохранено', rc.startsWith( 'export PATH=/opt/plesk/php/8.2/bin:$PATH\n' ) && ( rc.match( /opt\/plesk\/php/g ) || [] ).length === 1 && rc.includes( 'alias ll' ), rc );
} else {
	console.log( 'SKIP команда для SSH Terminal в bash — bash не найден' );
}

r = run( 'auth', 'acme' );
check( 'auth без httpAuth — понятная ошибка', r.code === 1 && /httpAuth/.test( r.out ), r.out );
write( join( proj, '.vscode', 'sftp-stage.json' ), { ...st, httpAuth: { user: 'stage', password: 'secret-http' } } );
r = run( 'auth', 'acme' );
const pw = json( join( proj, '.vscode', 'playwright-mcp.json' ) );
check( 'auth: пароль stage для браузера — только для origin stage', r.code === 0 && pw.browser.contextOptions.httpCredentials.origin === 'https://acme.stage.example' && pw.browser.contextOptions.httpCredentials.username === 'stage', r.out );
check( 'auth: секреты не в выводе', ! /secret-http/.test( r.out ), r.out );

r = run( 'build', 'acme', '--yes' );
st = json( join( proj, '.vscode', 'sftp-stage.json' ) );
check( 'повторный build сохраняет httpAuth проекта', st.httpAuth?.password === 'secret-http' && ! /secret-http/.test( r.out ), r.out );

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
