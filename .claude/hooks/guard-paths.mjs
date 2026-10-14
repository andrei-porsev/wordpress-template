/**
 * PreToolUse (Write|Edit|MultiEdit): правки только в своих пакетах и материалах проекта.
 * Слаги — project-base/project.json. Пока слагов нет (шаблон до project-init), пакеты не режем,
 * но ядро WP, хуки/настройки агента и .git закрыты всегда (pathViolation в lib.mjs).
 */
import { audit, block, pathViolation, readInput, repoRoot, safe, toRel } from './lib.mjs';

await safe( () => {
	const input = readInput();
	const root = repoRoot( input );
	const rel = toRel( root, input.tool_input?.file_path );
	if ( ! rel ) {
		return;
	}
	const why = pathViolation( root, rel );
	if ( why ) {
		audit( root, 'guard-paths-deny', { rel } );
		block( `Заблокировано: ${ why }` );
	}
} );
