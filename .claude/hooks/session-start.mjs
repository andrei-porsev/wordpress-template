/**
 * SessionStart: напоминание агенту о порядке «сверка → обновления → работа» (WORKFLOW.md → 2.1).
 * Проект не настроен (шапка INDEX из прочерков) — напоминание о project-init вместо сверки.
 * Чистит .claude/.state/sessions/ и backups/edit/ старше 30 дней (дампы и копии выкаток — человек).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, repoRoot, safe } from './lib.mjs';

const KEEP_DAYS = 30;

function prune( dir ) {
	if ( ! existsSync( dir ) ) {
		return;
	}
	const limit = Date.now() - KEEP_DAYS * 86400000;
	for ( const name of readdirSync( dir ) ) {
		const path = join( dir, name );
		try {
			if ( statSync( path ).mtimeMs < limit ) {
				rmSync( path, { recursive: true, force: true } );
			}
		} catch {
			// Занятый или удалённый файл — пропустить.
		}
	}
}

await safe( () => {
	const root = repoRoot( readInput() );
	prune( join( root, '.claude', '.state', 'sessions' ) );
	prune( join( root, '.claude', '.state', 'backups', 'edit' ) );
	const index = join( root, 'project-base', 'INDEX.md' );
	const name = existsSync( index ) ? ( readFileSync( index, 'utf8' ).split( '\n' ).find( ( l ) => l.startsWith( '- Название / домен:' ) ) || '' ) : '';
	const configured = name && ! name.trim().endsWith( '—' );
	const text = configured
		? 'Перед первой задачей с кодом или сервером — запуск сессии: node .claude/skills/project-ops/scripts/session-check.mjs (WORKFLOW.md → 2.1); ' +
			'отчёт пользователю 3–4 строки, открытые «Сделать вручную» — напомнить. Простой вопрос без правок — без сверки.'
		: 'Проект не настроен (шапка project-base/INDEX.md из прочерков): просят писать код — одной строкой предложить project-init.';
	process.stdout.write( JSON.stringify( { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } ) );
} );
