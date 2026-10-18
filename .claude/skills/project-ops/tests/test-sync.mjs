/**
 * Проверка compare / sync-down / upload / list на протоколе local («сервер» — папка во временном каталоге).
 * node .claude/skills/project-ops/tests/test-sync.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'sftp-sync.mjs' );
const base = join( tmpdir(), 'wp-template-test-sync' );
const proj = join( base, 'project' );
const remote = join( base, 'remote' );
rmSync( base, { recursive: true, force: true } );

const put = ( root, rel, text ) => {
	mkdirSync( dirname( join( root, rel ) ), { recursive: true } );
	writeFileSync( join( root, rel ), text );
};
put( proj, '.vscode/sftp.json', JSON.stringify( {
	protocol: 'local',
	remotePath: remote.replace( /\\/g, '/' ),
	ignore: [ '/*', '!/wp-content', '/wp-content/*', '!/wp-content/themes', '/wp-content/themes/*', '!/wp-content/themes/demo' ],
} ) );
const T = 'wp-content/themes/demo/';
put( remote, T + 'a.php', '<?php // a v1\n' );
put( remote, T + 'b.css', '.b{}\n' );
put( remote, T + 'inc/c.php', '<?php // c\n' );

let fails = 0;
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return ( r.stdout + r.stderr ).trim();
};
const groups = () => JSON.parse( run( 'compare', '--json' ).split( '\n' ).pop() ).groups;
const check = ( name, ok, detail ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	if ( ! ok ) {
		fails++;
	}
};
const rels = ( list ) => list.map( ( i ) => `${ i.rel }:${ i.kind }` ).sort().join( ',' );

// 1. Первая синхронизация без снимка и без локальных файлов.
let out = run( 'sync-down' );
check( '1 первая sync-down скачала 3', /скачано 3/.test( out ), out );
check( '1 после — всё совпадает', groups().same.length === 3, JSON.stringify( groups() ) );

// 2. CRLF локально не считается отличием.
put( proj, T + 'b.css', '.b{}\r\n' );
check( '2 CRLF ≠ отличие', groups().local.length === 0, JSON.stringify( groups() ) );

// 3. Чужая правка, своя правка, новый локальный файл, удалённый на сервере.
put( remote, T + 'a.php', '<?php // a v2 (клиент)\n' );
put( proj, T + 'b.css', '.b{color:red}\n' );
put( proj, T + 'new.php', '<?php // новый\n' );
rmSync( join( remote, T + 'inc/c.php' ) );
let g = groups();
check( '3 на сервере: a изменён, c удалён', rels( g.remote ) === `${ T }a.php:changed,${ T }inc/c.php:deleted`, rels( g.remote ) );
check( '3 локально: b изменён, new добавлен', rels( g.local ) === `${ T }b.css:changed,${ T }new.php:added`, rels( g.local ) );

// 4. sync-down берёт только чужое, своё не трогает.
out = run( 'sync-down' );
check( '4 a скачан с сервера', readFileSync( join( proj, T + 'a.php' ), 'utf8' ).includes( 'v2' ), out );
check( '4 c удалён локально', ! existsSync( join( proj, T + 'inc/c.php' ) ), out );
check( '4 b не перезаписан', readFileSync( join( proj, T + 'b.css' ), 'utf8' ).includes( 'red' ), out );
check( '4 new.php остался', existsSync( join( proj, T + 'new.php' ) ), out );

// 5. upload обновляет снимок — после него b совпадает.
run( 'upload', T + 'b.css', T + 'new.php' );
g = groups();
check( '5 после upload всё совпадает', g.same.length === 3 && ! g.local.length && ! g.remote.length, JSON.stringify( g ) );

// 6. Конфликт: правка с обеих сторон, sync-down его не трогает.
put( remote, T + 'a.php', '<?php // a v3 сервер\n' );
put( proj, T + 'a.php', '<?php // a v3 локально\n' );
check( '6 конфликт найден', rels( groups().conflict ) === `${ T }a.php:changed`, JSON.stringify( groups() ) );
run( 'sync-down' );
check( '6 конфликт не перезаписан', readFileSync( join( proj, T + 'a.php' ), 'utf8' ).includes( 'локально' ), '' );

// 7. --force забирает серверную версию.
run( 'sync-down', '--force' );
check( '7 --force взял сервер', readFileSync( join( proj, T + 'a.php' ), 'utf8' ).includes( 'сервер' ), '' );
check( '7 после --force всё совпадает', groups().same.length === 3, JSON.stringify( groups() ) );

// 8. list.
out = run( 'list', T );
check( '8 list показывает файлы и папки', /^-.*a\.php$/m.test( out ) && /^d.*inc$/m.test( out ) && /b\.css/.test( out ), out );

// 9. SCSS изменился на сервере — подсказка проверить, собран ли CSS.
check( '9 без SCSS подсказки нет', ! /compile-scss/.test( run( 'sync-down' ) ), '' );
put( remote, T + 'assets/scss/_x.scss', '.x{}\n' );
out = run( 'compare' );
check( '9 compare: подсказка про SCSS', /SCSS изменился на сервере → .*compile-scss\.mjs --check/.test( out ), out );
out = run( 'sync-down' );
check( '9 sync-down: подсказка про SCSS', /скачано 1/.test( out ) && /compile-scss\.mjs --check/.test( out ), out );

console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки sftp-sync прошли' );
process.exit( fails ? 1 : 0 );
