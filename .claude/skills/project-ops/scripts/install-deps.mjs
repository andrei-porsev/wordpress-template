/**
 * Зависимости скриптов project-ops: npm install в папке скилла.
 * `npm install --prefix …` ломается, если в пути проекта есть `#` (npm режет путь как URL).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const r = spawnSync( 'npm', [ 'install', '--no-fund', '--no-audit' ], {
	cwd: skillDir,
	stdio: 'inherit',
	shell: true,
} );
process.exit( r.status ?? 1 );
