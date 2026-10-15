/**
 * Проверка local-exec без LocalWP: запрет разрушающего, junction (создать, уже есть, настоящая папка — стоп).
 * node .claude/skills/project-ops/tests/test-local.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'local-exec.mjs' );
const base = join( tmpdir(), 'wp-template-test-local' );
const proj = join( base, 'project' );
const site = join( base, 'site' );
rmSync( base, { recursive: true, force: true } );

const put = ( p, text ) => {
	mkdirSync( dirname( p ), { recursive: true } );
	writeFileSync( p, text );
};
put( join( site, 'wp-config.php' ), '<?php // fake\n' );
put( join( proj, 'project-base', 'project.json' ), JSON.stringify( { themes: [ 'mytheme', 'missing' ], plugins: [ 'myplugin' ], muPlugins: [] } ) );
put( join( proj, 'wp-content', 'themes', 'mytheme', 'style.css' ), '/* Theme Name: My */\n' );
put( join( proj, 'wp-content', 'plugins', 'myplugin', 'myplugin.php' ), '<?php\n' );
put( join( site, 'wp-content', 'plugins', 'myplugin', 'old.php' ), '<?php // настоящая папка в сайте\n' );
put( join( proj, '.vscode', 'local.json' ), JSON.stringify( { tool: 'ospanel', sitePath: site, php: process.execPath, wpCli: 'none', dbPort: 1 } ) );

const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};

let r = run( '--', 'wp', 'db', 'drop', '--yes' );
check( 'wp db drop — запрещено даже с --yes', r.code === 1 && /Запрещено/.test( r.out ), r.out );
r = run( '--', 'wp', 'site', 'empty' );
check( 'wp site empty — запрещено', r.code === 1 && /Запрещено/.test( r.out ), r.out );
r = run( '--', 'ls', '-la' );
check( 'не WP-CLI — отказ', r.code === 1 && /Только WP-CLI/.test( r.out ), r.out );
r = run( '--', 'wp', 'option', 'get', 'home' );
check( 'база не отвечает — ручной шаг', r.code === 1 && /СДЕЛАТЬ ВРУЧНУЮ/.test( r.out ), r.out );

r = run( 'link' );
check( 'link: план без --yes', /mytheme: создать junction/.test( r.out ) && /ПЛАН/.test( r.out ) && ! existsSync( join( site, 'wp-content', 'themes', 'mytheme' ) ), r.out );
check( 'link: нет папки в проекте — пропуск', /missing: пропуск/.test( r.out ), r.out );
check( 'link: настоящая папка в сайте — стоп', /myplugin: СТОП/.test( r.out ), r.out );
run( 'link', '--yes' );
const link = join( site, 'wp-content', 'themes', 'mytheme' );
check( 'link --yes: junction создан', existsSync( link ) && lstatSync( link ).isSymbolicLink() && /Theme Name/.test( readFileSync( join( link, 'style.css' ), 'utf8' ) ) );
check( 'link --yes: настоящая папка не тронута', existsSync( join( site, 'wp-content', 'plugins', 'myplugin', 'old.php' ) ) );
check( 'link повторно — уже связано', /mytheme: уже связано/.test( run( 'link' ).out ) );

console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки local-exec прошли' );
process.exit( fails ? 1 : 0 );
