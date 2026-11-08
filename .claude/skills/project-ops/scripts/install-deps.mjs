/**
 * Зависимости скриптов project-ops: npm install в папке скилла.
 * `npm install --prefix …` ломается, если в пути проекта есть `#` (npm режет путь как URL).
 * --browsers — ещё WebKit и Firefox для playwright-cli (skill qa, направление B), один раз на машину.
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
if ( r.status !== 0 || ! process.argv.includes( '--browsers' ) ) {
	process.exit( r.status ?? 1 );
}

const cli = join( skillDir, 'node_modules', '@playwright', 'cli', 'playwright-cli.js' );
for ( const engine of [ 'webkit', 'firefox' ] ) {
	const b = spawnSync( process.execPath, [ cli, 'install-browser', engine ], { cwd: skillDir, stdio: 'inherit' } );
	if ( b.status !== 0 ) {
		console.error( `Не установлен ${ engine }.` );
		process.exit( b.status ?? 1 );
	}
}
console.log( 'WebKit и Firefox установлены.' );
