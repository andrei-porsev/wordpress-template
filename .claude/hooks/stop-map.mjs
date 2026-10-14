/**
 * Stop: если в ходе были структурные правки (новый файл, функция, класс, хук), а карту
 * project-base не трогали — один раз просим агента её обновить. Второй раз не блокируем.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadState, readInput, repoRoot, safe, saveState } from './lib.mjs';

await safe( () => {
	const input = readInput();
	if ( input.stop_hook_active ) {
		return;
	}
	const root = repoRoot( input );
	const state = loadState( root, input.session_id );
	const files = Object.keys( state.structural || {} );
	if ( state.mapTouched && files.length ) {
		saveState( root, input.session_id, { structural: {}, mapTouched: false, reminded: false } );
		return;
	}
	if ( ! files.length || state.reminded ) {
		return;
	}

	// Карты ещё нет (шапка INDEX из прочерков) — напоминать не о чем.
	const indexPath = join( root, 'project-base', 'INDEX.md' );
	if ( existsSync( indexPath ) ) {
		const head = readFileSync( indexPath, 'utf8' ).split( '\n' ).find( ( l ) => l.startsWith( '- Название / домен:' ) ) || '';
		if ( head.trim().endsWith( '—' ) ) {
			return;
		}
	}

	state.reminded = true;
	saveState( root, input.session_id, state );
	const list = files.map( ( f ) => `${ f } (${ state.structural[ f ] })` ).join( ', ' );
	process.stdout.write( JSON.stringify( {
		decision: 'block',
		reason: `Структурные правки без обновления карты: ${ list }. Обнови INDEX пакета и/или md слоя в project-base/ (skill project-structure), затем заверши.`,
	} ) );
} );
