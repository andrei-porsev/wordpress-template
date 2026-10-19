/**
 * Проверка shot-diff.mjs: одинаковые снимки — 0%, изменённый квадрат — одна область на своём месте,
 * сглаживание ниже порога — не изменение, разная высота — пометка, очистка по сроку и по команде.
 * node .claude/skills/project-ops/tests/test-shot-diff.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'shot-diff.mjs' );
const sharp = ( await import( pathToFileURL( join( dirname( SCRIPT ), '..', 'node_modules', 'sharp', 'lib', 'index.js' ) ).href ) ).default;
const proj = join( tmpdir(), 'wp-template-test-shot-diff' );
const shots = join( proj, '.claude', '.state', 'reports', 'shots' );
rmSync( proj, { recursive: true, force: true } );
mkdirSync( join( shots, 'knopka' ), { recursive: true } );

let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
const white = { r: 255, g: 255, b: 255, alpha: 1 };
const png = ( file, w, h, overlays = [] ) => sharp( { create: { width: w, height: h, channels: 4, background: white } } ).composite( overlays ).png().toFile( file );
const box = ( left, top, size, color ) => ( {
	input: { create: { width: size, height: size, channels: 4, background: color } },
	left,
	top,
} );

const dir = join( shots, 'knopka' );
await png( join( dir, 'before.png' ), 400, 300 );
await png( join( dir, 'same.png' ), 400, 300 );
await png( join( dir, 'after.png' ), 400, 300, [ box( 320, 240, 48, { r: 186, g: 140, b: 50, alpha: 1 } ) ] );
await png( join( dir, 'faint.png' ), 400, 300, [ box( 10, 10, 20, { r: 245, g: 245, b: 245, alpha: 1 } ) ] );
await png( join( dir, 'taller.png' ), 400, 360 );
await png( join( dir, 'wider.png' ), 415, 300 );
await png( join( dir, 'line.png' ), 400, 300, [ {
	input: { create: { width: 120, height: 1, channels: 4, background: { r: 33, g: 41, b: 52, alpha: 1 } } },
	left: 40,
	top: 150,
} ] );

let r = run( 'diff', join( dir, 'before.png' ), join( dir, 'same.png' ) );
check( '1 одинаковые — 0%', r.code === 0 && /Изменено: 0\.00%/.test( r.out ) && ! /Области/.test( r.out ), r.out );

r = run( 'diff', join( dir, 'before.png' ), join( dir, 'after.png' ) );
check( '2 квадрат найден', Number( ( r.out.match( /Изменено: ([\d.]+)%/ ) || [] )[ 1 ] ) > 1.5, r.out );
// Квадрат 320,240 48×48; размытие расширяет область не больше чем на клетку 16 px.
const m = r.out.match( /Области[^\n]*:\n {2}(\d+), (\d+), (\d+) × (\d+)$/m );
const [ x, y, w, h ] = m ? m.slice( 1 ).map( Number ) : [];
check( '2 одна область на месте квадрата', m && x <= 320 && y <= 240 && x >= 304 && y >= 224 && x + w >= 368 && y + h >= 288 && x + w <= 384 && y + h <= 304 && ! /\n {2}\d+, \d+, \d+ × \d+\n {2}/.test( r.out ), r.out );
check( '2 картинка-разница рядом со «стало»', existsSync( join( dir, 'after-diff.png' ) ), r.out );

r = run( 'diff', join( dir, 'before.png' ), join( dir, 'faint.png' ) );
check( '3 разница ниже порога — не изменение', /Изменено: 0\.00%/.test( r.out ), r.out );

r = run( 'diff', join( dir, 'before.png' ), join( dir, 'line.png' ) );
check( '3 тонкая линия 1 px — найдена', /Области/.test( r.out ), r.out );

r = run( 'diff', join( dir, 'before.png' ), join( dir, 'taller.png' ), '--out', join( proj, 'd.png' ) );
check( '4 другая высота — пометка, --out', /Высота страницы: было 300, стало 360/.test( r.out ) && existsSync( join( proj, 'd.png' ) ), r.out );

r = run( 'diff', join( dir, 'before.png' ), join( dir, 'wider.png' ) );
check( '4 другая ширина — несопоставимы', /Ширина: было 400, стало 415 — снимки несопоставимы/.test( r.out ), r.out );

// Очистка: по сроку (при любом запуске), задача по имени, всё.
mkdirSync( join( shots, 'old' ), { recursive: true } );
const old = new Date( Date.now() - 200 * 24 * 60 * 60 * 1000 );
utimesSync( join( shots, 'old' ), old, old );
r = run( 'clean', '--days', '365' );
check( '5 старше 180 дней удалены при запуске', /Удалены пары старше 180 дней: old/.test( r.out ) && ! existsSync( join( shots, 'old' ) ), r.out );
r = run( 'clean', 'knopka' );
check( '5 clean <задача>', r.code === 0 && ! existsSync( dir ), r.out );
mkdirSync( join( shots, 'x' ), { recursive: true } );
r = run( 'clean', '--all' );
check( '5 clean --all', r.code === 0 && ! existsSync( shots ), r.out );

rmSync( proj, { recursive: true, force: true } );
console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки shot-diff прошли' );
process.exit( fails ? 1 : 0 );
