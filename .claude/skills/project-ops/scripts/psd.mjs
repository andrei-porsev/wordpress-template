/**
 * Макет PSD как источник для вёрстки (решение 023): то, что для Figma даёт MCP, — из файла.
 *   node .claude/skills/project-ops/scripts/psd.mjs info   <файл.psd>
 *   node .claude/skills/project-ops/scripts/psd.mjs tree   <файл.psd> [--group "Desktop/Header"] [--hidden]
 *   node .claude/skills/project-ops/scripts/psd.mjs tokens <файл.psd> [--group "…"]
 *   node .claude/skills/project-ops/scripts/psd.mjs export <файл.psd> --composite | --group "…" [--assets] | --layer "…"
 * info   — размер, артборды и секции (группы второго уровня) с координатами, шрифты, предупреждения.
 * tree   — дерево слоёв в JSON: координаты (от левого верхнего угла выбранного корня), тексты со стилями, заливки, обводки, тени, скругления.
 * tokens — сводка повторов: цвета, шрифты и кегли, скругления, тени, промежутки между соседними блоками — с частотой.
 * export — PNG: --composite весь макет, --group вырез сведённой картинки по границам группы (секция как видна),
 *          --assets ещё и каждый растровый слой и смарт-объект группы с прозрачностью, --layer один слой.
 * Всё пишется в .claude/.state/cache/psd/<имя файла>/ (не в git, пересоздаётся); в консоль — коротко и путь.
 * Файл макета — project-base/design/client/ (`*.psd` в git не идёт). Только чтение PSD.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OPS = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const CACHE = join( process.cwd(), '.claude', '.state', 'cache', 'psd' );
// Промежутки больше этого — уже не отступ внутри секции, а раскладка страницы.
const GAP_MAX = 400;
// Веса по окончанию PostScript-имени шрифта, полному и сокращённому (Montserrat-SemiBold, Steradian-Blk); порядок важен.
const WEIGHTS = [
	[ /hairline|thin|^th(?![a-z])/i, 100 ],
	[ /(extra|ultra)-?light|^xlt/i, 200 ],
	[ /light|^lt(?![a-z])/i, 300 ],
	[ /(semi|demi)-?b|^smbd|^sb(?![a-z])/i, 600 ],
	[ /(extra|ultra)-?b|^xbd/i, 800 ],
	[ /black|heavy|^blk|^hv(?![a-z])/i, 900 ],
	[ /bold|^bd(?![a-z])/i, 700 ],
	[ /medium|^md(?![a-z])/i, 500 ],
];

const args = process.argv.slice( 2 );
const flag = ( name ) => {
	const i = args.indexOf( name );
	return i >= 0 && args[ i + 1 ] && ! args[ i + 1 ].startsWith( '--' ) ? args[ i + 1 ] : null;
};
const has = ( name ) => args.includes( name );
const [ command, file ] = args;

function fail( message ) {
	console.error( message );
	process.exit( 1 );
}

async function lib( name, entry ) {
	const path = join( OPS, 'node_modules', ...entry );
	if ( ! existsSync( path ) ) {
		fail( `Нет зависимости ${ name }: node .claude/skills/project-ops/scripts/install-deps.mjs` );
	}
	return import( pathToFileURL( path ).href );
}

// Чтение PSD. Растр слоёв и сведённая картинка — только когда нужны: файлы клиентов бывают по сотни МБ.
async function load( { layers = false, composite = false } = {} ) {
	const { readPsd, initializeCanvas } = await lib( 'ag-psd', [ 'ag-psd', 'dist', 'index.js' ] );
	// В Node нет canvas: пиксели — обычным буфером RGBA, канвас библиотеке не нужен при useImageData.
	initializeCanvas(
		() => {
			throw new Error( 'canvas не используется' );
		},
		( width, height ) => ( { width, height, data: new Uint8ClampedArray( width * height * 4 ) } )
	);
	return readPsd( readFileSync( file ), {
		useImageData: true,
		skipLayerImageData: ! layers,
		skipCompositeImageData: ! composite,
		skipThumbnail: true,
		skipLinkedFilesData: true,
	} );
}

// Цвет PSD → #hex (и альфа). CMYK и Lab пересчитываются приблизительно — помечено `~`.
function hex( c, alpha = 1 ) {
	if ( ! c ) {
		return null;
	}
	let r;
	let g;
	let b;
	let approx = false;
	if ( 'r' in c ) {
		( { r, g, b } = c );
	} else if ( 'fr' in c ) {
		[ r, g, b ] = [ c.fr * 255, c.fg * 255, c.fb * 255 ];
	} else if ( 'h' in c ) {
		const s = c.s / 100;
		const v = c.b / 100;
		const f = ( n ) => {
			const k = ( n + c.h / 60 ) % 6;
			return ( v - v * s * Math.max( 0, Math.min( k, 4 - k, 1 ) ) ) * 255;
		};
		[ r, g, b ] = [ f( 5 ), f( 3 ), f( 1 ) ];
	} else if ( 'c' in c ) {
		const k = c.k / 100;
		[ r, g, b ] = [ c.c, c.m, c.y ].map( ( x ) => 255 * ( 1 - x / 100 ) * ( 1 - k ) );
		approx = true;
	} else if ( 'k' in c ) {
		r = g = b = 255 * ( 1 - c.k / 100 );
	} else {
		return '~lab';
	}
	const a = ( 'a' in c && typeof c.a === 'number' && c.a <= 1 ? c.a : 1 ) * alpha;
	const h = '#' + [ r, g, b ].map( ( x ) => Math.round( Math.max( 0, Math.min( 255, x ) ) ).toString( 16 ).padStart( 2, '0' ) ).join( '' );
	return ( approx ? '~' : '' ) + h + ( a < 1 ? ` / ${ Math.round( a * 100 ) }%` : '' );
}

const units = ( v ) => ( v && typeof v.value === 'number' ? Math.round( v.value * 10 ) / 10 : undefined );
const round = ( n ) => Math.round( n * 10 ) / 10;

function kind( layer ) {
	if ( layer.children ) {
		return layer.artboard ? 'artboard' : 'group';
	}
	if ( layer.text ) {
		return 'text';
	}
	if ( layer.placedLayer ) {
		return 'smart';
	}
	if ( layer.adjustment ) {
		return 'adjustment';
	}
	if ( layer.vectorFill || layer.vectorOrigination ) {
		return 'shape';
	}
	return 'image';
}

// Границы слоя; у группы — артборд или объединение видимых детей (у групп PSD своих границ обычно нет).
function bounds( layer, hidden = false ) {
	if ( layer.artboard ) {
		const { top, left, bottom, right } = layer.artboard.rect;
		return { top, left, bottom, right };
	}
	if ( layer.children ) {
		const parts = layer.children.filter( ( c ) => hidden || ! c.hidden ).map( ( c ) => bounds( c, hidden ) ).filter( Boolean );
		if ( ! parts.length ) {
			return null;
		}
		return {
			top: Math.min( ...parts.map( ( p ) => p.top ) ),
			left: Math.min( ...parts.map( ( p ) => p.left ) ),
			bottom: Math.max( ...parts.map( ( p ) => p.bottom ) ),
			right: Math.max( ...parts.map( ( p ) => p.right ) ),
		};
	}
	const { top = 0, left = 0, bottom = 0, right = 0 } = layer;
	return bottom > top && right > left ? { top, left, bottom, right } : null;
}

function fontInfo( name = '' ) {
	const [ family, style = '' ] = name.split( '-' );
	const weight = ( WEIGHTS.find( ( [ re ] ) => re.test( style ) ) || [ null, 400 ] )[ 1 ];
	return { postscript: name, family: family.replace( /([a-z])([A-Z])/g, '$1 $2' ), weight, italic: /italic|oblique/i.test( style ) };
}

// Стиль куска текста: кегль и интерлиньяж с учётом масштаба трансформации (текст, растянутый рамкой, хранит исходный кегль).
function textStyle( style = {}, scale = 1 ) {
	const font = fontInfo( style.font?.name );
	const out = { font: font.postscript, family: font.family, weight: font.weight };
	if ( font.italic || style.fauxItalic ) {
		out.italic = true;
	}
	if ( style.fontSize ) {
		out.size = round( style.fontSize * scale );
	}
	if ( style.leading && ! style.autoLeading ) {
		out.lineHeight = round( style.leading * scale );
	}
	if ( style.tracking ) {
		// Трекинг Photoshop — тысячные доли em.
		out.letterSpacingEm = round( style.tracking / 10 ) / 100;
	}
	if ( style.fontCaps === 2 ) {
		out.uppercase = true;
	}
	if ( style.underline ) {
		out.underline = true;
	}
	const color = hex( style.fillColor );
	if ( color ) {
		out.color = color;
	}
	return out;
}

function text( layer ) {
	const t = layer.text;
	const content = ( t.text || '' ).replace( /\r/g, '\n' ).replace( /\u0003/g, '\n' );
	const tr = t.transform || [ 1, 0, 0, 1 ];
	const scale = Math.sqrt( tr[ 2 ] * tr[ 2 ] + tr[ 3 ] * tr[ 3 ] ) || 1;
	const runs = [];
	let pos = 0;
	for ( const run of t.styleRuns || [ { length: content.length, style: t.style } ] ) {
		const style = textStyle( { ...t.style, ...run.style }, scale );
		const piece = content.slice( pos, pos + run.length );
		pos += run.length;
		const last = runs[ runs.length - 1 ];
		if ( last && JSON.stringify( { ...last, text: '' } ) === JSON.stringify( { ...style, text: '' } ) ) {
			last.text += piece;
		} else if ( piece.trim() || ! runs.length ) {
			runs.push( { text: piece, ...style } );
		}
	}
	for ( const run of runs ) {
		run.text = run.text.replace( /\n+$/, '' );
	}
	const out = { content: content.trim(), runs: runs.filter( ( r ) => r.text ) };
	const align = t.paragraphStyle?.justification;
	if ( align && align !== 'left' ) {
		out.align = align;
	}
	if ( t.warp?.style && t.warp.style !== 'none' ) {
		out.warp = t.warp.style;
	}
	return out;
}

function fill( content ) {
	if ( ! content ) {
		return undefined;
	}
	if ( content.type === 'color' ) {
		return hex( content.color );
	}
	if ( content.colorStops ) {
		return `gradient(${ content.angle ?? '' }deg: ${ content.colorStops.map( ( s ) => `${ hex( s.color ) } ${ Math.round( s.location / 40.96 ) }%` ).join( ', ' ) })`;
	}
	return content.type;
}

function shadow( s, inset = false ) {
	const d = units( s.distance ) || 0;
	const a = ( ( s.angle ?? 90 ) * Math.PI ) / 180;
	const blur = units( s.size ) || 0;
	const spread = round( ( blur * ( units( s.choke ) || 0 ) ) / 100 );
	return `${ inset ? 'inset ' : '' }${ round( -Math.cos( a ) * d ) }px ${ round( Math.sin( a ) * d ) }px ${ blur }px ${ spread }px ${ hex( s.color, s.opacity ?? 1 ) }`;
}

function effects( fx ) {
	if ( ! fx || fx.disabled ) {
		return undefined;
	}
	const out = {};
	const on = ( list ) => ( list || [] ).filter( ( e ) => e.enabled !== false );
	const shadows = [ ...on( fx.dropShadow ).map( ( s ) => shadow( s ) ), ...on( fx.innerShadow ).map( ( s ) => shadow( s, true ) ) ];
	if ( shadows.length ) {
		out.shadow = shadows;
	}
	const stroke = on( fx.stroke )[ 0 ];
	if ( stroke ) {
		out.stroke = `${ units( stroke.size ) }px ${ stroke.position || '' } ${ hex( stroke.color, stroke.opacity ?? 1 ) }`.replace( /\s+/g, ' ' );
	}
	const overlay = on( fx.solidFill )[ 0 ];
	if ( overlay ) {
		out.colorOverlay = hex( overlay.color, overlay.opacity ?? 1 );
	}
	const gradient = on( fx.gradientOverlay )[ 0 ];
	if ( gradient ) {
		out.gradientOverlay = fill( { ...gradient.gradient, angle: gradient.angle } );
	}
	const other = [ 'outerGlow', 'innerGlow', 'bevel', 'satin', 'patternOverlay' ].filter( ( k ) => fx[ k ] && fx[ k ].enabled !== false );
	if ( other.length ) {
		out.other = other;
	}
	return Object.keys( out ).length ? out : undefined;
}

function radius( layer ) {
	const item = ( layer.vectorOrigination?.keyDescriptorList || [] )[ 0 ];
	if ( ! item ) {
		return undefined;
	}
	if ( item.keyOriginType === 5 ) {
		return 'ellipse';
	}
	const r = item.keyOriginRRectRadii;
	if ( ! r ) {
		return undefined;
	}
	const v = [ r.topLeft, r.topRight, r.bottomRight, r.bottomLeft ].map( units );
	return v.every( ( x ) => x === v[ 0 ] ) ? v[ 0 ] || undefined : v.join( ' ' );
}

// Узел дерева: координаты от левого верхнего угла корня.
function node( layer, origin, hidden ) {
	const k = kind( layer );
	const b = bounds( layer, hidden );
	const out = { name: layer.name, kind: k };
	if ( b ) {
		Object.assign( out, { x: b.left - origin.left, y: b.top - origin.top, w: b.right - b.left, h: b.bottom - b.top } );
	}
	if ( layer.hidden ) {
		out.hidden = true;
	}
	if ( layer.opacity !== undefined && layer.opacity < 1 ) {
		out.opacity = round( layer.opacity );
	}
	if ( layer.fillOpacity !== undefined && layer.fillOpacity < 1 ) {
		out.fillOpacity = round( layer.fillOpacity );
	}
	if ( layer.blendMode && ! [ 'normal', 'pass through' ].includes( layer.blendMode ) ) {
		out.blend = layer.blendMode;
	}
	if ( layer.clipping ) {
		out.clipped = true;
	}
	if ( k === 'artboard' && layer.artboard.color ) {
		out.background = hex( layer.artboard.color );
	}
	if ( k === 'text' ) {
		out.text = text( layer );
	}
	if ( k === 'shape' ) {
		out.fill = fill( layer.vectorFill );
		const s = layer.vectorStroke;
		if ( s && s.strokeEnabled !== false && s.content ) {
			out.stroke = `${ units( s.lineWidth ) }px ${ fill( s.content ) }${ s.lineDashSet?.length ? ' dashed' : '' }`;
		}
		out.radius = radius( layer );
	}
	if ( k === 'smart' ) {
		out.smart = layer.placedLayer.type;
	}
	if ( k === 'adjustment' ) {
		out.adjustment = layer.adjustment.type;
	}
	out.effects = effects( layer.effects );
	if ( layer.children ) {
		out.children = layer.children.filter( ( c ) => hidden || ! c.hidden ).map( ( c ) => node( c, origin, hidden ) );
	}
	for ( const key of Object.keys( out ) ) {
		if ( out[ key ] === undefined ) {
			delete out[ key ];
		}
	}
	return out;
}

function walk( layers, fn, path = [] ) {
	for ( const layer of layers || [] ) {
		const p = [ ...path, layer.name ];
		fn( layer, p );
		walk( layer.children, fn, p );
	}
}

// Группа по пути «Артборд/Секция»: первый сегмент — на любой глубине, следующие — среди потомков по порядку.
function findGroup( psd, query ) {
	const want = query.split( '/' ).map( ( s ) => s.trim().toLowerCase() ).filter( Boolean );
	const found = [];
	walk( psd.children, ( layer, path ) => {
		const names = path.map( ( n ) => ( n || '' ).trim().toLowerCase() );
		if ( names[ names.length - 1 ] !== want[ want.length - 1 ] ) {
			return;
		}
		let i = 0;
		for ( const n of names ) {
			if ( n === want[ i ] ) {
				i++;
			}
		}
		if ( i === want.length ) {
			found.push( { layer, path: path.join( '/' ) } );
		}
	} );
	if ( ! found.length ) {
		fail( `Группа «${ query }» не найдена. Имена секций — команда info.` );
	}
	if ( found.length > 1 ) {
		fail( `«${ query }» — несколько совпадений, уточните путь:\n${ found.map( ( f ) => '  ' + f.path ).join( '\n' ) }` );
	}
	return found[ 0 ];
}

function outDir() {
	const dir = join( CACHE, basename( file, extname( file ) ).replace( /[^\w.-]+/g, '-' ) );
	mkdirSync( dir, { recursive: true } );
	return dir;
}

const slug = ( s ) => ( s || 'layer' ).toLowerCase().replace( /[^a-z0-9а-яё]+/gi, '-' ).replace( /^-|-$/g, '' ) || 'layer';
const rel = ( p ) => relative( process.cwd(), p ).replace( /\\/g, '/' );
const size = ( b ) => ( b ? `${ b.left }, ${ b.top }, ${ b.right - b.left } × ${ b.bottom - b.top }` : 'пусто' );

async function info() {
	const psd = await load();
	const lines = [ `${ basename( file ) }: ${ psd.width } × ${ psd.height } px, ${ psd.colorMode === 3 ? 'RGB' : psd.colorMode === 4 ? 'CMYK' : `режим ${ psd.colorMode }` }, ${ psd.bitsPerChannel || 8} бит, ${ ( statSync( file ).size / 1048576 ).toFixed( 1 ) } МБ` ];
	const top = ( psd.children || [] ).filter( ( l ) => ! l.hidden );
	const boards = top.filter( ( l ) => l.artboard );
	lines.push( boards.length ? `Артборды (${ boards.length }) и секции в них:` : 'Артбордов нет; группы верхнего уровня и секции в них:' );
	for ( const layer of boards.length ? boards : top.filter( ( l ) => l.children ) ) {
		lines.push( `  ${ layer.name } — ${ size( bounds( layer ) ) }` );
		for ( const child of ( layer.children || [] ).filter( ( c ) => ! c.hidden && c.children ) ) {
			lines.push( `    ${ child.name } — ${ size( bounds( child ) ) }` );
		}
	}
	const fonts = new Map();
	const count = { smart: 0, adjustment: 0, hidden: 0, warp: 0, otherFx: 0 };
	walk( psd.children, ( layer ) => {
		if ( layer.hidden ) {
			count.hidden++;
		}
		const k = kind( layer );
		if ( k === 'smart' || k === 'adjustment' ) {
			count[ k ]++;
		}
		if ( k === 'text' ) {
			const t = text( layer );
			if ( t.warp ) {
				count.warp++;
			}
			for ( const run of t.runs ) {
				const key = run.font || '(без имени)';
				const f = fonts.get( key ) || { sizes: new Set(), n: 0 };
				f.n++;
				if ( run.size ) {
					f.sizes.add( run.size );
				}
				fonts.set( key, f );
			}
		}
		if ( effects( layer.effects )?.other ) {
			count.otherFx++;
		}
	} );
	lines.push( `Шрифты (${ fonts.size }) — PostScript-имя: кегли, px (наличие в теме и лицензию проверить):` );
	for ( const [ name, f ] of [ ...fonts ].sort( ( a, b ) => b[ 1 ].n - a[ 1 ].n ) ) {
		lines.push( `  ${ name }: ${ [ ...f.sizes ].sort( ( a, b ) => a - b ).join( ', ' ) || '—' } (${ f.n })` );
	}
	const warn = [];
	if ( psd.colorMode === 4 ) {
		warn.push( 'CMYK: цвета пересчитаны приблизительно (помечены ~), сверить с дизайнером или брендбуком' );
	}
	if ( count.smart ) {
		warn.push( `смарт-объекты: ${ count.smart } — внутрь не читаются, только картинкой (export --assets)` );
	}
	if ( count.adjustment ) {
		warn.push( `корректирующие слои: ${ count.adjustment } — меняют цвета под собой; точный вид — сведённая картинка` );
	}
	if ( count.otherFx ) {
		warn.push( `эффекты без CSS-аналога (свечение, тиснение, атлас, узор): ${ count.otherFx } слоёв — по картинке` );
	}
	if ( count.warp ) {
		warn.push( `текст с деформацией: ${ count.warp } — вёрстка не повторит, обсудить с пользователем` );
	}
	if ( count.hidden ) {
		warn.push( `скрытые слои: ${ count.hidden } — в дерево не входят (--hidden — включить); могут быть состояния (hover, меню)` );
	}
	try {
		const full = await load( { composite: true } );
		if ( ! full.imageData ) {
			throw new Error( 'нет' );
		}
	} catch {
		warn.push( 'нет сведённой картинки (сохранён без «Maximize compatibility»): export --composite и --group недоступны — попросить пересохранить' );
	}
	if ( ! boards.length && psd.width >= 1000 ) {
		warn.push( 'один холст без артбордов: мобильной версии в файле, скорее всего, нет — собрать по аналогии и показать на утверждение' );
	}
	lines.push( warn.length ? 'Предупреждения:\n' + warn.map( ( w ) => '  - ' + w ).join( '\n' ) : 'Предупреждений нет.' );
	console.log( lines.join( '\n' ) );
}

async function tree() {
	const psd = await load();
	const query = flag( '--group' );
	const hidden = has( '--hidden' );
	let root;
	let name;
	if ( query ) {
		const g = findGroup( psd, query );
		root = node( g.layer, bounds( g.layer, hidden ) || { top: 0, left: 0 }, hidden );
		name = slug( g.path.split( '/' ).pop() );
	} else {
		root = { name: basename( file ), kind: 'document', w: psd.width, h: psd.height, children: ( psd.children || [] ).filter( ( c ) => hidden || ! c.hidden ).map( ( c ) => node( c, { top: 0, left: 0 }, hidden ) ) };
		name = 'all';
	}
	const out = join( outDir(), `tree-${ name }.json` );
	writeFileSync( out, JSON.stringify( root, null, '\t' ) );
	let n = 0;
	const kinds = {};
	( function count( x ) {
		n++;
		kinds[ x.kind ] = ( kinds[ x.kind ] || 0 ) + 1;
		( x.children || [] ).forEach( count );
	} )( root );
	console.log( `Дерево: ${ rel( out ) } — ${ n } узлов (${ Object.entries( kinds ).map( ( [ k, v ] ) => `${ k } ${ v }` ).join( ', ' ) }), ${ ( statSync( out ).size / 1024 ).toFixed( 0 ) } КБ` );
	if ( ! query && statSync( out ).size > 300 * 1024 ) {
		console.log( 'Большое дерево: читать по секциям — tree --group "<артборд>/<секция>" (имена — info).' );
	}
}

async function tokens() {
	const psd = await load();
	const query = flag( '--group' );
	const scope = query ? [ findGroup( psd, query ).layer ] : psd.children || [];
	const tally = () => new Map();
	const t = { colors: tally(), type: tally(), radius: tally(), shadow: tally(), gap: tally() };
	const add = ( map, key, where ) => {
		if ( key === undefined || key === null || key === '' ) {
			return;
		}
		const e = map.get( key ) || { n: 0, where: new Set() };
		e.n++;
		e.where.add( where );
		map.set( key, e );
	};
	walk( scope, ( layer ) => {
		if ( layer.hidden ) {
			return;
		}
		const k = kind( layer );
		if ( k === 'text' ) {
			for ( const run of text( layer ).runs ) {
				add( t.colors, run.color, 'текст' );
				add( t.type, `${ run.family } ${ run.weight }${ run.italic ? ' italic' : '' } — ${ run.size ?? '?' }/${ run.lineHeight ?? 'auto' }${ run.letterSpacingEm ? ` ls ${ run.letterSpacingEm }em` : '' }${ run.uppercase ? ' caps' : '' }`, layer.name );
			}
		}
		if ( k === 'shape' ) {
			const f = fill( layer.vectorFill );
			if ( f?.startsWith( 'gradient' ) ) {
				add( t.colors, f, 'градиент' );
			} else {
				add( t.colors, f, 'фигура' );
			}
			const r = radius( layer );
			if ( r !== undefined && r !== 'ellipse' ) {
				add( t.radius, String( r ), layer.name );
			}
			const s = layer.vectorStroke;
			if ( s && s.strokeEnabled !== false && s.content ) {
				add( t.colors, fill( s.content ), 'обводка' );
			}
		}
		const fx = effects( layer.effects );
		for ( const s of fx?.shadow || [] ) {
			add( t.shadow, s, layer.name );
		}
		if ( fx?.colorOverlay ) {
			add( t.colors, fx.colorOverlay, 'наложение цвета' );
		}
		if ( layer.artboard?.color ) {
			add( t.colors, hex( layer.artboard.color ), 'фон артборда' );
		}
		// Промежутки между соседними блоками группы: сверху вниз и слева направо, без перекрытий.
		if ( layer.children ) {
			const kids = layer.children.filter( ( c ) => ! c.hidden && kind( c ) !== 'adjustment' ).map( ( c ) => bounds( c ) ).filter( Boolean );
			for ( const [ a, b2, dir ] of [ [ 'top', 'bottom', 'по вертикали' ], [ 'left', 'right', 'по горизонтали' ] ] ) {
				const sorted = [ ...kids ].sort( ( p, q ) => p[ a ] - q[ a ] );
				for ( let i = 1; i < sorted.length; i++ ) {
					const gap = sorted[ i ][ a ] - sorted[ i - 1 ][ b2 ];
					if ( gap > 0 && gap <= GAP_MAX ) {
						add( t.gap, gap, dir );
					}
				}
			}
		}
	} );
	const section = ( title, map, numeric = false ) => {
		const rows = [ ...map ].sort( ( a, b ) => ( numeric ? a[ 0 ] - b[ 0 ] : b[ 1 ].n - a[ 1 ].n ) );
		if ( ! rows.length ) {
			return `## ${ title }\n\n—\n`;
		}
		return `## ${ title }\n\n| Значение | Раз | Где |\n|---|---|---|\n${ rows.map( ( [ k, e ] ) => `| ${ k } | ${ e.n } | ${ [ ...e.where ].slice( 0, 4 ).join( ', ' ) }${ e.where.size > 4 ? ` +${ e.where.size - 4 }` : '' } |` ).join( '\n' ) }\n`;
	};
	const md = [
		`# Токены из ${ basename( file ) }${ query ? ` — ${ query }` : '' }`,
		'',
		'Повторы по макету, не решение: близкие значения (15 и 16, #222 и #232323) — скорее одно; итог — в паспорт дизайна после «да» пользователя.',
		'',
		section( 'Цвета', t.colors ),
		section( 'Типографика — семейство вес — кегль/интерлиньяж, px', t.type ),
		section( 'Скругления, px', t.radius ),
		section( 'Тени (CSS)', t.shadow ),
		section( 'Промежутки между соседними блоками, px', t.gap, true ),
	].join( '\n' );
	const out = join( outDir(), `tokens-${ query ? slug( query.split( '/' ).pop() ) : 'all' }.md` );
	writeFileSync( out, md );
	console.log( `Токены: ${ rel( out ) } — цветов ${ t.colors.size }, стилей текста ${ t.type.size }, скруглений ${ t.radius.size }, теней ${ t.shadow.size }, промежутков ${ t.gap.size }` );
}

async function png( data, width, height, out ) {
	const sharp = ( await lib( 'sharp', [ 'sharp', 'lib', 'index.js' ] ) ).default;
	await sharp( Buffer.from( data.buffer, data.byteOffset, data.byteLength ), { raw: { width, height, channels: 4 } } ).png().toFile( out );
	return out;
}

async function exportPng() {
	const query = flag( '--group' );
	const layerQuery = flag( '--layer' );
	const assets = has( '--assets' );
	if ( ! has( '--composite' ) && ! query && ! layerQuery ) {
		fail( 'Что выгрузить: --composite, --group "<путь>" [--assets] или --layer "<путь>".' );
	}
	const psd = await load( { composite: has( '--composite' ) || !! query, layers: assets || !! layerQuery } );
	const dir = join( outDir(), 'export' );
	mkdirSync( dir, { recursive: true } );
	const done = [];
	const needComposite = () => {
		if ( ! psd.imageData ) {
			fail( 'В файле нет сведённой картинки (сохранён без «Maximize compatibility»): попросить пересохранить или выгружать слои (--layer, --assets).' );
		}
		return psd.imageData;
	};
	if ( has( '--composite' ) ) {
		const img = needComposite();
		done.push( await png( img.data, img.width, img.height, join( dir, 'composite.png' ) ) );
	}
	if ( query ) {
		const g = findGroup( psd, query );
		const b = bounds( g.layer );
		if ( ! b ) {
			fail( `Группа «${ g.path }» пустая.` );
		}
		const img = needComposite();
		const left = Math.max( 0, b.left );
		const top = Math.max( 0, b.top );
		const w = Math.min( img.width, b.right ) - left;
		const h = Math.min( img.height, b.bottom ) - top;
		const crop = new Uint8Array( w * h * 4 );
		for ( let y = 0; y < h; y++ ) {
			const from = ( ( top + y ) * img.width + left ) * 4;
			crop.set( img.data.subarray( from, from + w * 4 ), y * w * 4 );
		}
		done.push( await png( crop, w, h, join( dir, `${ slug( g.path.split( '/' ).pop() ) }.png` ) ) );
		if ( assets ) {
			const used = new Set();
			const list = [];
			walk( g.layer.children, ( layer, path ) => {
				if ( ! layer.hidden && [ 'image', 'smart' ].includes( kind( layer ) ) && layer.imageData ) {
					list.push( { layer, path } );
				}
			} );
			for ( const { layer, path } of list ) {
				let name = slug( `${ g.layer.name }-${ path[ path.length - 1 ] }` );
				while ( used.has( name ) ) {
					name += '-2';
				}
				used.add( name );
				done.push( await png( layer.imageData.data, layer.imageData.width, layer.imageData.height, join( dir, `${ name }.png` ) ) );
			}
		}
	}
	if ( layerQuery ) {
		const g = findGroup( psd, layerQuery );
		if ( ! g.layer.imageData ) {
			fail( `У «${ g.path }» нет растра (группа, текст или фигура): для вида — --group, для иконки — экспорт SVG у дизайнера.` );
		}
		done.push( await png( g.layer.imageData.data, g.layer.imageData.width, g.layer.imageData.height, join( dir, `${ slug( g.path.split( '/' ).pop() ) }.png` ) ) );
	}
	console.log( `PNG (${ done.length }) в ${ rel( dir ) }:\n${ done.map( ( d ) => '  ' + basename( d ) ).join( '\n' ) }` );
}

if ( ! command || ! file ) {
	fail( 'node .claude/skills/project-ops/scripts/psd.mjs info|tree|tokens|export <файл.psd> [--group "<путь>"] [--hidden] [--composite] [--assets] [--layer "<путь>"]' );
}
if ( ! existsSync( file ) ) {
	fail( `Нет файла ${ file }. Макеты PSD — в project-base/design/client/.` );
}
const run = { info, tree, tokens, export: exportPng }[ command ];
if ( ! run ) {
	fail( `Неизвестная команда ${ command }: info, tree, tokens, export.` );
}
await run();
