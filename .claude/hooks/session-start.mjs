/**
 * SessionStart: напоминание агенту о порядке «сверка → обновления → работа» (WORKFLOW.md → 2.1).
 * Проект не настроен (шапка INDEX из прочерков) — напоминание о project-init вместо сверки.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readInput, repoRoot, safe } from './lib.mjs';

await safe( () => {
	const root = repoRoot( readInput() );
	const index = join( root, 'project-base', 'INDEX.md' );
	const name = existsSync( index ) ? ( readFileSync( index, 'utf8' ).split( '\n' ).find( ( l ) => l.startsWith( '- Название / домен:' ) ) || '' ) : '';
	const configured = name && ! name.trim().endsWith( '—' );
	const text = configured
		? 'Перед первой задачей с кодом или сервером — запуск сессии: node .claude/skills/project-ops/scripts/session-check.mjs (WORKFLOW.md → 2.1); ' +
			'отчёт пользователю 3–4 строки, открытые «Сделать вручную» — напомнить. Простой вопрос без правок — без сверки.'
		: 'Проект не настроен (шапка project-base/INDEX.md из прочерков): просят писать код — одной строкой предложить project-init.';
	process.stdout.write( JSON.stringify( { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } ) );
} );
