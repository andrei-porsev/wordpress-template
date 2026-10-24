/**
 * Проверка markup.mjs без сервера: вёрстка не включена, нет markup/, нет конфига stage — понятные отказы до любой заливки.
 * node .claude/skills/project-ops/tests/test-markup.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'markup.mjs' );
const proj = join( tmpdir(), 'wp-template-test-markup' );
rmSync( proj, { recursive: true, force: true } );
mkdirSync( join( proj, 'project-base' ), { recursive: true } );
mkdirSync( join( proj, '.vscode' ), { recursive: true } );
spawnSync( 'git', [ 'init', '-q' ], { cwd: proj } );

const write = ( p, d ) => writeFileSync( join( proj, p ), typeof d === 'string' ? d : JSON.stringify( d ) );
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};

write( '.vscode/sftp.json', { host: 'prod.example', username: 'u', password: 'p', ignore: [] } );
write( 'project-base/project.json', { stem: 'acme', themes: [ 'acme' ], markup: false } );
let r = run( 'publish' );
check( 'markup: false — отказ с подсказкой', r.code === 1 && /"markup": true/.test( r.out ), r.out );

write( 'project-base/project.json', { stem: 'acme', themes: [ 'acme' ], markup: true } );
r = run( 'publish' );
check( 'нет markup/ — отказ', r.code === 1 && /Нет папки markup/.test( r.out ), r.out );

mkdirSync( join( proj, 'markup' ), { recursive: true } );
write( 'markup/index.html', '<!doctype html><title>t</title>' );
r = run( 'publish' );
check( 'нет sftp-stage.json — отказ, прод не трогается', r.code === 1 && /sftp-stage\.json/.test( r.out ), r.out );

write( '.vscode/sftp-stage.json', { host: '', ignore: [] } );
r = run( 'url' );
check( 'пустой host stage — отказ', r.code === 1 && /host пустой/.test( r.out ), r.out );

r = run( 'deploy' );
check( 'неизвестная команда — отказ', r.code === 1, r.out );

rmSync( proj, { recursive: true, force: true } );
console.log( fails ? `\nПровалено: ${ fails }` : '\nВсе проверки markup прошли' );
process.exit( fails ? 1 : 0 );
