/**
 * SFTP/FTP: команды над своим кодом на сервере (ядро — remote.mjs).
 * Пароль в stdout/stderr не пишем — иначе всплывёт в чат агента.
 */
import { ensureDeps, repoRoot, loadConfig, cmdTest, cmdUpload, cmdDownload, cmdFetch, cmdPut, cmdRemove, cmdSyncDown, cmdSyncUp, cmdCompare, cmdList, cmdDeploy } from './remote.mjs';

// --stage: конфиг sftp-stage.json / ssh-stage.json вместо боевого.
if ( process.argv.includes( '--stage' ) ) {
	process.env.SFTP_CONFIG = 'sftp-stage.json';
	process.env.SSH_CONFIG = 'ssh-stage.json';
}
const isStage = process.argv.includes( '--stage' );
const flags = new Set( process.argv.filter( ( a ) => [ '--force', '--json', '--yes' ].includes( a ) ) );
const [ , , cmd, ...args ] = process.argv.filter( ( a ) => a !== '--stage' && ! flags.has( a ) );

try {
	ensureDeps();
	const root = repoRoot();
	const cfg = loadConfig( root );
	switch ( cmd ) {
		case 'test':
			await cmdTest( cfg );
			break;
		case 'upload':
			await cmdUpload( cfg, root, args );
			break;
		case 'download':
			await cmdDownload( cfg, root, args );
			break;
		case 'fetch':
			await cmdFetch( cfg, args[ 0 ], args[ 1 ] );
			break;
		case 'put':
			await cmdPut( cfg, args[ 0 ], args[ 1 ] );
			break;
		case 'remove':
			await cmdRemove( cfg, args[ 0 ] );
			break;
		case 'sync-down':
			await cmdSyncDown( cfg, root, flags.has( '--force' ) );
			break;
		case 'sync-up':
			await cmdSyncUp( cfg, root );
			break;
		case 'compare':
			await cmdCompare( cfg, root, flags.has( '--json' ) );
			break;
		case 'list':
			await cmdList( cfg, args[ 0 ] );
			break;
		case 'deploy':
			await cmdDeploy( cfg, root, flags.has( '--yes' ), isStage );
			break;
		default:
			throw new Error( 'Команда: test | list | compare | deploy | download | upload | fetch | put | remove | sync-down | sync-up' );
	}
} catch ( err ) {
	const msg = err instanceof Error ? err.message : String( err );
	console.error( msg.replace( /password[=:]\S+/gi, 'password=***' ) );
	process.exit( 1 );
}
