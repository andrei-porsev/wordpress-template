/**
 * Скриншоты «было → стало» (решение 046): сравнение двух PNG и хранение пар.
 *   node .claude/skills/project-ops/scripts/shot-diff.mjs diff <было.png> <стало.png> [--out <разница.png>]
 *   node .claude/skills/project-ops/scripts/shot-diff.mjs clean [<задача>] [--days 180] [--all]
 * Пары — .claude/.state/reports/shots/<задача>/ (не в git); старше 180 дней удаляются при каждом запуске.
 * diff: доля изменённых пикселей, прямоугольники изменённых областей, картинка-разница (стало, приглушённое, изменения — красным).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const SHOTS = join( process.cwd(), '.claude', '.state', 'reports', 'shots' );
const KEEP_DAYS = 180;
// Сравнение по слегка размытым снимкам: пересчёт масштаба фото и сглаживание дают разброс на краях, а не правку.
// Размытие 1 и порог 72: шум в фото падает с ~17 000 до ~40 px, смена цвета заголовка видна целиком.
const BLUR = 1;
// Разница каналов RGB (сумма, 0–765) после размытия.
const PIXEL_THRESHOLD = 72;
// Клетка считается изменённой от этого числа пикселей: одиночные точки — шум.
const CELL_MIN = 3;
// Сетка поиска областей, px; соседние изменённые клетки — одна область.
const CELL = 16;

const args = process.argv.slice( 2 );
const flag = ( name ) => {
	const i = args.indexOf( name );
	return i >= 0 ? args[ i + 1 ] : null;
};
const positional = args.filter( ( a, i ) => ! a.startsWith( '--' ) && ! ( i > 0 && args[ i - 1 ].startsWith( '--' ) && args[ i - 1 ] !== '--all' ) );

// Папки задач старше days (по времени последнего изменения).
function prune( days ) {
	if ( ! existsSync( SHOTS ) ) {
		return [];
	}
	const limit = Date.now() - days * 24 * 60 * 60 * 1000;
	const removed = [];
	for ( const name of readdirSync( SHOTS ) ) {
		const path = join( SHOTS, name );
		if ( statSync( path ).mtimeMs < limit ) {
			rmSync( path, { recursive: true, force: true } );
			removed.push( name );
		}
	}
	return removed;
}

async function load( sharp, file, blur = 0 ) {
	const img = blur ? sharp( file ).blur( blur ) : sharp( file );
	const { data, info } = await img.ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height };
}

// Связные группы изменённых клеток → прямоугольники в px.
function regions( cells, cols, rows ) {
	const seen = new Uint8Array( cells.length );
	const out = [];
	for ( let start = 0; start < cells.length; start++ ) {
		if ( ! cells[ start ] || seen[ start ] ) {
			continue;
		}
		let [ x0, y0, x1, y1 ] = [ Infinity, Infinity, -1, -1 ];
		const stack = [ start ];
		seen[ start ] = 1;
		while ( stack.length ) {
			const c = stack.pop();
			const cx = c % cols;
			const cy = Math.floor( c / cols );
			x0 = Math.min( x0, cx );
			y0 = Math.min( y0, cy );
			x1 = Math.max( x1, cx );
			y1 = Math.max( y1, cy );
			for ( const [ dx, dy ] of [ [ 1, 0 ], [ -1, 0 ], [ 0, 1 ], [ 0, -1 ] ] ) {
				const nx = cx + dx;
				const ny = cy + dy;
				const n = ny * cols + nx;
				if ( nx >= 0 && ny >= 0 && nx < cols && ny < rows && cells[ n ] && ! seen[ n ] ) {
					seen[ n ] = 1;
					stack.push( n );
				}
			}
		}
		out.push( { x: x0 * CELL, y: y0 * CELL, w: ( x1 - x0 + 1 ) * CELL, h: ( y1 - y0 + 1 ) * CELL } );
	}
	return out.sort( ( a, b ) => b.w * b.h - a.w * a.h );
}

async function cmdDiff( before, after ) {
	if ( ! before || ! after || ! existsSync( before ) || ! existsSync( after ) ) {
		throw new Error( 'diff <было.png> <стало.png> [--out <разница.png>] — оба файла должны существовать.' );
	}
	const sharp = ( await import( 'sharp' ) ).default;
	const a = await load( sharp, before, BLUR );
	const b = await load( sharp, after, BLUR );
	const view = await load( sharp, after );
	const width = Math.min( a.width, b.width );
	const height = Math.min( a.height, b.height );
	const cols = Math.ceil( width / CELL );
	const rows = Math.ceil( height / CELL );
	const counts = new Uint16Array( cols * rows );
	const hit = new Uint8Array( width * height );
	for ( let y = 0; y < height; y++ ) {
		for ( let x = 0; x < width; x++ ) {
			const ia = ( y * a.width + x ) * 4;
			const ib = ( y * b.width + x ) * 4;
			const d = Math.abs( a.data[ ia ] - b.data[ ib ] ) + Math.abs( a.data[ ia + 1 ] - b.data[ ib + 1 ] ) + Math.abs( a.data[ ia + 2 ] - b.data[ ib + 2 ] );
			if ( d > PIXEL_THRESHOLD ) {
				hit[ y * width + x ] = 1;
				counts[ Math.floor( y / CELL ) * cols + Math.floor( x / CELL ) ]++;
			}
		}
	}
	const cells = counts.map( ( n ) => ( n >= CELL_MIN ? 1 : 0 ) );
	const out = Buffer.alloc( width * height * 4 );
	let changed = 0;
	for ( let y = 0; y < height; y++ ) {
		for ( let x = 0; x < width; x++ ) {
			const iv = ( y * view.width + x ) * 4;
			const io = ( y * width + x ) * 4;
			if ( hit[ y * width + x ] && cells[ Math.floor( y / CELL ) * cols + Math.floor( x / CELL ) ] ) {
				changed++;
				out[ io ] = 230;
				out[ io + 1 ] = 30;
				out[ io + 2 ] = 30;
			} else {
				// «Стало» приглушённым, чтобы красное читалось.
				for ( let c = 0; c < 3; c++ ) {
					out[ io + c ] = Math.round( 255 - ( 255 - view.data[ iv + c ] ) * 0.35 );
				}
			}
			out[ io + 3 ] = 255;
		}
	}
	const file = flag( '--out' ) || join( dirname( after ), `${ basename( after, extname( after ) ) }-diff.png` );
	await sharp( out, { raw: { width, height, channels: 4 } } ).png().toFile( file );

	const pct = ( changed / ( width * height ) ) * 100;
	const all = regions( cells, cols, rows );
	// Одна клетка — обычно шум фото или сглаживания; области от двух клеток — правки.
	const boxes = all.filter( ( r ) => r.w * r.h > CELL * CELL );
	const specks = all.length - boxes.length;
	console.log( `Изменено: ${ pct.toFixed( 2 ) }% (${ changed } px из ${ width * height })` );
	if ( a.width !== b.width ) {
		console.log( `Ширина: было ${ a.width }, стало ${ b.width } — снимки несопоставимы (полоса прокрутки или окно): переснять после подготовки (layout-check → «Было → стало»)` );
	} else if ( a.height !== b.height ) {
		console.log( `Высота страницы: было ${ a.height }, стало ${ b.height } — вёрстка сдвинулась; ниже места правки сравнение сдвинуто` );
	}
	if ( specks ) {
		console.log( `Одиночные клетки ${ CELL }×${ CELL }: ${ specks } (шум фото или сглаживания; на картинке-разнице видны)` );
	}
	if ( boxes.length ) {
		console.log( `Области (x, y, ширина × высота, px), крупные первыми${ boxes.length > 10 ? `, первые 10 из ${ boxes.length }` : '' }:` );
		boxes.slice( 0, 10 ).forEach( ( r ) => console.log( `  ${ r.x }, ${ r.y }, ${ r.w } × ${ r.h }` ) );
	}
	console.log( `Разница: ${ file }` );
}

try {
	const [ cmd ] = positional;
	const removed = prune( KEEP_DAYS );
	if ( removed.length ) {
		console.log( `Удалены пары старше ${ KEEP_DAYS } дней: ${ removed.join( ', ' ) }` );
	}
	if ( cmd === 'diff' ) {
		await cmdDiff( positional[ 1 ], positional[ 2 ] );
	} else if ( cmd === 'clean' ) {
		if ( args.includes( '--all' ) ) {
			rmSync( SHOTS, { recursive: true, force: true } );
			console.log( 'OK: все пары удалены' );
		} else if ( positional[ 1 ] ) {
			const path = join( SHOTS, basename( positional[ 1 ] ) );
			if ( ! existsSync( path ) ) {
				throw new Error( `Нет пар задачи: ${ positional[ 1 ] }` );
			}
			rmSync( path, { recursive: true, force: true } );
			console.log( `OK: удалены пары задачи ${ positional[ 1 ] }` );
		} else {
			const days = Number( flag( '--days' ) || KEEP_DAYS );
			const old = prune( days );
			console.log( `OK: удалено старше ${ days } дней — ${ old.length ? old.join( ', ' ) : 'нечего' }` );
		}
	} else {
		throw new Error( 'Команда: diff <было.png> <стало.png> [--out <файл>] | clean [<задача>] [--days N] [--all]' );
	}
} catch ( err ) {
	console.error( err instanceof Error ? err.message : String( err ) );
	process.exit( 1 );
}
