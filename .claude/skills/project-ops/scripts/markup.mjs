/**
 * Вёрстка макета (project-base/project.json → "markup": true): заливка markup/ на stage и ссылка на стартовую страницу.
 * Запуск из корня:
 *   node .claude/skills/project-ops/scripts/markup.mjs publish [--all]   изменённое против снимка stage (--all — всё), затем ссылка
 *   node .claude/skills/project-ops/scripts/markup.mjs url               только ссылка и ответ сервера
 * На прод не заливает: работает только с sftp-stage.json. Пароль stage в вывод не попадает.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.SFTP_CONFIG = 'sftp-stage.json';
process.env.SSH_CONFIG = 'ssh-stage.json';

const { ensureDeps, repoRoot, loadConfig, loadSnapshot, walkLocal, hashOf, localOf, cmdUpload, accessUrl } = await import( './remote.mjs' );

const [ , , cmd = 'publish' ] = process.argv;
const all = process.argv.includes( '--all' );

// Стартовая страница: markup/index.html, иначе первый .html в корне markup/.
function startPage( files ) {
	if ( files.includes( 'markup/index.html' ) ) {
		return 'markup/';
	}
	return files.find( ( f ) => /^markup\/[^/]+\.html$/.test( f ) ) || 'markup/';
}

async function check( url, auth ) {
	try {
		const headers = auth?.user ? { Authorization: 'Basic ' + Buffer.from( `${ auth.user }:${ auth.password || '' }` ).toString( 'base64' ) } : {};
		const res = await fetch( url, { method: 'HEAD', headers, redirect: 'follow' } );
		return res.status;
	} catch ( e ) {
		return `нет ответа (${ String( e.message || e ).split( '\n' )[ 0 ] })`;
	}
}

try {
	ensureDeps();
	const root = repoRoot();
	const projectPath = join( root, 'project-base', 'project.json' );
	const project = existsSync( projectPath ) ? JSON.parse( readFileSync( projectPath, 'utf8' ) ) : {};
	if ( project.markup !== true ) {
		throw new Error( 'Вёрстка макета не включена: project-base/project.json → "markup": true, затем gen-whitelist.mjs.' );
	}
	if ( ! existsSync( join( root, 'markup' ) ) ) {
		throw new Error( 'Нет папки markup/ в корне проекта.' );
	}
	const cfg = loadConfig( root );
	const files = walkLocal( join( root, 'markup' ), root );
	const base = accessUrl( root, 'Stage / dev URL' );

	if ( cmd === 'publish' ) {
		const snap = loadSnapshot( root, cfg ) || { files: {} };
		const changed = all ? files : files.filter( ( rel ) => snap.files?.[ rel ]?.hash !== hashOf( readFileSync( localOf( root, rel ) ) ) );
		if ( changed.length ) {
			await cmdUpload( cfg, root, changed );
		} else {
			console.log( 'Изменений в markup/ нет — заливать нечего.' );
		}
		const gone = Object.keys( snap.files || {} ).filter( ( rel ) => rel.startsWith( 'markup/' ) && ! files.includes( rel ) );
		if ( gone.length ) {
			console.log( `Удалены локально, на stage остались (${ gone.length }): ${ gone.slice( 0, 10 ).join( ', ' ) }${ gone.length > 10 ? ' …' : '' }` );
			console.log( 'Убрать с stage: node .claude/skills/project-ops/scripts/sftp-sync.mjs remove <путь> --stage' );
		}
	} else if ( cmd !== 'url' ) {
		throw new Error( 'Команда: publish [--all] | url' );
	}

	if ( ! base ) {
		console.log( 'Ссылки нет: ACCESS.md → «Stage / dev URL» пустой.' );
	} else {
		const url = `${ base }/${ startPage( files ) }`;
		console.log( `\nВёрстка: ${ url }` );
		console.log( `Ответ сервера: ${ await check( url, cfg.httpAuth ) } · пароль — как у stage (ACCESS.md → «Пароль на stage»)` );
	}
} catch ( e ) {
	console.error( String( e.message || e ) );
	process.exit( 1 );
}
