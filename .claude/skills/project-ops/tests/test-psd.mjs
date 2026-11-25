/**
 * Проверка psd.mjs на собранном здесь PSD: артборд с секцией (текст, фигура со скруглением и тенью, картинка),
 * info — секции, шрифт и кегль; tree — координаты от секции и стиль текста; tokens — цвет, кегль, промежуток;
 * export — вырез секции по размеру, ассет картинки, ошибки на неизвестную группу и неоднозначный путь.
 * node .claude/skills/project-ops/tests/test-psd.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'psd.mjs' );
const MODULES = join( dirname( SCRIPT ), '..', 'node_modules' );
const { writePsdBuffer } = await import( pathToFileURL( join( MODULES, 'ag-psd', 'dist', 'index.js' ) ).href );
const sharp = ( await import( pathToFileURL( join( MODULES, 'sharp', 'lib', 'index.js' ) ).href ) ).default;
const proj = join( tmpdir(), 'wp-template-test-psd' );
rmSync( proj, { recursive: true, force: true } );
mkdirSync( join( proj, 'design' ), { recursive: true } );

let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
const pixels = ( w, h, [ r, g, b, a = 255 ] ) => {
	const data = new Uint8ClampedArray( w * h * 4 );
	for ( let i = 0; i < data.length; i += 4 ) {
		data.set( [ r, g, b, a ], i );
	}
	return { width: w, height: h, data };
};
const px = ( v ) => ( { units: 'Pixels', value: v } );

// Холст 800×600: артборд Desktop, в нём секция Hero (100,100 — 600×300) и Footer; второй Footer — в артборде Mobile.
const psd = {
	width: 800,
	height: 600,
	imageData: pixels( 800, 600, [ 255, 255, 255 ] ),
	children: [
		{
			name: 'Desktop',
			artboard: { rect: { top: 0, left: 0, bottom: 600, right: 800 }, color: { r: 255, g: 255, b: 255 } },
			children: [
				{
					name: 'Hero',
					children: [
						{ name: 'Photo', top: 100, left: 100, bottom: 200, right: 300, imageData: pixels( 200, 100, [ 200, 30, 30 ] ) },
						{
							name: 'Button',
							top: 300,
							left: 100,
							bottom: 348,
							right: 260,
							imageData: pixels( 160, 48, [ 34, 85, 204 ] ),
							vectorFill: { type: 'color', color: { r: 34, g: 85, b: 204 } },
							vectorOrigination: { keyDescriptorList: [ { keyOriginType: 2, keyOriginRRectRadii: { topLeft: px( 8 ), topRight: px( 8 ), bottomLeft: px( 8 ), bottomRight: px( 8 ) } } ] },
							effects: { dropShadow: [ { enabled: true, angle: 90, distance: px( 4 ), size: px( 12 ), choke: px( 0 ), color: { r: 0, g: 0, b: 0 }, opacity: 0.25 } ] },
						},
						{
							name: 'Title',
							top: 220,
							left: 100,
							bottom: 276,
							right: 700,
							imageData: pixels( 600, 56, [ 17, 17, 17, 0 ] ),
							text: {
								text: 'Hello world',
								transform: [ 1, 0, 0, 1, 100, 260 ],
								style: { font: { name: 'Montserrat-SemiBold' }, fontSize: 48, leading: 56, autoLeading: false, fillColor: { r: 17, g: 17, b: 17 } },
							},
						},
					],
				},
				{ name: 'Footer', children: [ { name: 'Bar', top: 500, left: 0, bottom: 600, right: 800, imageData: pixels( 800, 100, [ 17, 17, 17 ] ) } ] },
			],
		},
		{
			name: 'Mobile',
			hidden: false,
			artboard: { rect: { top: 0, left: 900, bottom: 600, right: 1275 } },
			children: [ { name: 'Footer', children: [ { name: 'Bar', top: 550, left: 900, bottom: 600, right: 1275, imageData: pixels( 375, 50, [ 17, 17, 17 ] ) } ] } ],
		},
	],
};
const file = join( proj, 'design', 'site.psd' );
writeFileSync( file, writePsdBuffer( psd, { generateThumbnail: false, invalidateTextLayers: false } ) );
const cache = join( proj, '.claude', '.state', 'cache', 'psd', 'site' );

let r = run( 'info', 'design/site.psd' );
check( '1 info: размер и артборды', r.code === 0 && /800 × 600/.test( r.out ) && /Артборды \(2\)/.test( r.out ), r.out );
check( '1 info: секция Hero с координатами', /Hero — 100, 100, 600 × 248/.test( r.out ), r.out );
check( '1 info: шрифт и кегль', /Montserrat-SemiBold: 48/.test( r.out ), r.out );

r = run( 'tree', 'design/site.psd', '--group', 'Desktop/Hero' );
const tree = existsSync( join( cache, 'tree-hero.json' ) ) ? JSON.parse( readFileSync( join( cache, 'tree-hero.json' ), 'utf8' ) ) : {};
const title = ( tree.children || [] ).find( ( c ) => c.name === 'Title' ) || {};
const button = ( tree.children || [] ).find( ( c ) => c.name === 'Button' ) || {};
check( '2 tree: файл и координаты от секции', r.code === 0 && tree.x === 0 && title.x === 0 && title.y === 120, r.out + JSON.stringify( title ) );
const run0 = title.text?.runs?.[ 0 ] || {};
check( '2 tree: стиль текста', run0.family === 'Montserrat' && run0.weight === 600 && run0.size === 48 && run0.lineHeight === 56 && run0.color === '#111111', JSON.stringify( title.text ) );
check( '2 tree: фигура — заливка, скругление, тень', button.kind === 'shape' && button.fill === '#2255cc' && button.radius === 8 && /0px 4px 12px 0px #000000 \/ 25%/.test( ( button.effects?.shadow || [] )[ 0 ] ), JSON.stringify( button ) );

r = run( 'tokens', 'design/site.psd', '--group', 'Hero' );
const tokens = existsSync( join( cache, 'tokens-hero.md' ) ) ? readFileSync( join( cache, 'tokens-hero.md' ), 'utf8' ) : '';
check( '3 tokens: цвета, типографика, промежуток', r.code === 0 && /\| #2255cc \| 1 \|/.test( tokens ) && /Montserrat 600 — 48\/56/.test( tokens ) && /\| 20 \| 1 \| по вертикали/.test( tokens ), r.out + '\n' + tokens );

r = run( 'export', 'design/site.psd', '--group', 'Desktop/Hero', '--assets' );
const crop = join( cache, 'export', 'hero.png' );
const meta = existsSync( crop ) ? await sharp( crop ).metadata() : {};
check( '4 export: вырез секции по размеру', r.code === 0 && meta.width === 600 && meta.height === 248, r.out + JSON.stringify( meta ) );
check( '4 export: ассет картинки', existsSync( join( cache, 'export', 'hero-photo.png' ) ), r.out );

r = run( 'export', 'design/site.psd', '--composite' );
check( '5 export: сведённая картинка', r.code === 0 && existsSync( join( cache, 'export', 'composite.png' ) ), r.out );

r = run( 'tree', 'design/site.psd', '--group', 'Footer' );
check( '6 неоднозначный путь — список вариантов', r.code === 1 && /Desktop\/Footer/.test( r.out ) && /Mobile\/Footer/.test( r.out ), r.out );
r = run( 'tree', 'design/site.psd', '--group', 'Nope' );
check( '6 нет группы — ошибка', r.code === 1 && /не найдена/.test( r.out ), r.out );

rmSync( proj, { recursive: true, force: true } );
console.log( fails ? `\nОшибок: ${ fails }` : '\nВсе проверки пройдены' );
process.exit( fails ? 1 : 0 );
