/**
 * Конфиги stage по профилю своего сервера и «stage становится продом» после переезда.
 *   node .claude/skills/project-ops/scripts/stage-config.mjs build <project> [--server vps] [--yes]
 *       ~/.wp-template/servers.json → .vscode/sftp-stage.json + ssh-stage.json (ignore / watcher — из sftp.json проекта)
 *   node .claude/skills/project-ops/scripts/stage-config.mjs promote [--yes]
 *       после переключения DNS: sftp-stage.json → sftp.json (старый → sftp.old.json), ssh — так же, снимок синхронизации — тоже
 * Без --yes — только план. Секреты в вывод не попадают; данные сервера в контекст агента — тоже (только итоговые поля без паролей).
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir, readHome } from './home.mjs';

const argv = process.argv.slice( 2 );
const [ cmd, project ] = argv.filter( ( a ) => ! a.startsWith( '--' ) );
const yes = argv.includes( '--yes' );
const serverKey = ( argv.find( ( a ) => a.startsWith( '--server=' ) ) || '' ).slice( 9 ) || ( argv.includes( '--server' ) ? argv[ argv.indexOf( '--server' ) + 1 ] : '' );

const root = process.cwd();
const vs = ( name ) => join( root, '.vscode', name );
const readJson = ( p ) => JSON.parse( readFileSync( p, 'utf8' ) );
const writeJson = ( p, data ) => writeFileSync( p, JSON.stringify( data, null, '\t' ) + '\n' );
const fill = ( v, name ) => ( typeof v === 'string' ? v.replaceAll( '{project}', name ) : v );

function build() {
	if ( ! project || ! /^[a-z0-9][a-z0-9-_]*$/i.test( project ) ) {
		throw new Error( 'Нужно имя проекта латиницей: stage-config.mjs build <project> [--server <ключ>]' );
	}
	const servers = readHome( 'servers.json' );
	if ( ! servers?.servers ) {
		throw new Error( `Нет профиля сервера: скопировать .claude/skills/project-ops/servers.example.json → ${ join( homeDir(), 'servers.json' ) } и заполнить (человек).` );
	}
	const keys = Object.keys( servers.servers );
	const key = serverKey || ( keys.length === 1 ? keys[ 0 ] : '' );
	const srv = servers.servers[ key ];
	if ( ! srv ) {
		throw new Error( `Профиль «${ serverKey || '?' }» не найден; есть: ${ keys.join( ', ' ) } (--server <ключ>).` );
	}
	if ( ! srv.host ) {
		throw new Error( `В профиле ${ key } пустой host — заполнить ${ join( homeDir(), 'servers.json' ) }.` );
	}
	if ( ! existsSync( vs( 'sftp.json' ) ) ) {
		throw new Error( 'Нет .vscode/sftp.json проекта — из него берутся ignore и watcher.' );
	}
	const base = readJson( vs( 'sftp.json' ) );
	const sftp = {
		name: `${ project } stage (${ key })`,
		host: srv.host,
		protocol: 'sftp',
		port: srv.port || 22,
		username: fill( srv.username, project ),
		password: '',
		privateKeyPath: srv.privateKeyPath || '',
		remotePath: fill( srv.remotePath || '/httpdocs', project ),
		context: '.',
		connectTimeout: 20000,
		uploadOnSave: false,
		ignore: base.ignore || [],
		watcher: base.watcher || {},
	};
	if ( srv.httpAuth?.user ) {
		sftp.httpAuth = srv.httpAuth;
	}
	const ssh = { host: '', port: sftp.port, username: '', password: '', privateKeyPath: '', cwd: sftp.remotePath, wpCli: srv.wpCli || 'wp' };
	const url = fill( srv.stageUrl || '', project );

	console.log( `Stage по профилю «${ key }» (${ srv.title || srv.host }):` );
	console.log( `  ${ sftp.username }@${ sftp.host }:${ sftp.port } · ${ sftp.remotePath } · ${ sftp.privateKeyPath ? 'вход по ключу' : 'вход по паролю — вписать в sftp-stage.json' }${ sftp.httpAuth ? ' · httpAuth есть' : '' }` );
	console.log( `  Stage / dev URL: ${ url || '—' }` );
	for ( const f of [ 'sftp-stage.json', 'ssh-stage.json' ] ) {
		existsSync( vs( f ) ) && console.log( `  ⚠️ ${ f } уже есть — будет перезаписан (старый → ${ f.replace( '.json', '.bak.json' ) })` );
	}
	if ( ! yes ) {
		console.log( 'ПЛАН: показать пользователю; после «да» — тот же запуск с --yes.' );
		return;
	}
	for ( const f of [ 'sftp-stage.json', 'ssh-stage.json' ] ) {
		existsSync( vs( f ) ) && copyFileSync( vs( f ), vs( f.replace( '.json', '.bak.json' ) ) );
	}
	writeJson( vs( 'sftp-stage.json' ), sftp );
	writeJson( vs( 'ssh-stage.json' ), ssh );
	console.log( 'OK: .vscode/sftp-stage.json, .vscode/ssh-stage.json записаны.' );
	console.log( `Дальше: ACCESS.md → «Окружения» (Stage: свой VPS, Stage-конфиг) и «Stage / dev URL: ${ url || '—' }»; проверка — connect-check.mjs --stage.` );
	sftp.privateKeyPath || console.log( 'Пароль подписки — в .vscode/sftp-stage.json → password (в чат не писать).' );
}

function promote() {
	for ( const f of [ 'sftp-stage.json' ] ) {
		if ( ! existsSync( vs( f ) ) ) {
			throw new Error( `Нет .vscode/${ f } — нечего переносить в прод.` );
		}
	}
	const moves = [
		[ vs( 'sftp.json' ), vs( 'sftp.old.json' ) ], [ vs( 'sftp-stage.json' ), vs( 'sftp.json' ) ],
		[ vs( 'ssh.json' ), vs( 'ssh.old.json' ) ], [ vs( 'ssh-stage.json' ), vs( 'ssh.json' ) ],
		[ join( root, '.claude', '.state', 'sync-sftp.json' ), join( root, '.claude', '.state', 'sync-sftp.old.json' ) ],
		[ join( root, '.claude', '.state', 'sync-sftp-stage.json' ), join( root, '.claude', '.state', 'sync-sftp.json' ) ],
	].filter( ( [ from ] ) => existsSync( from ) );
	const stageCfg = readJson( vs( 'sftp-stage.json' ) );
	console.log( `Переезд завершён → новый сервер (${ stageCfg.host }) становится продом:` );
	moves.forEach( ( [ a, b ] ) => console.log( `  ${ a.slice( root.length + 1 ) } → ${ b.slice( root.length + 1 ) }` ) );
	if ( ! yes ) {
		console.log( 'ПЛАН: только после переключения DNS и проверки сайта на новом сервере; после «да» — с --yes.' );
		return;
	}
	const old = existsSync( vs( 'sftp.json' ) ) ? readJson( vs( 'sftp.json' ) ) : {};
	for ( const [ a, b ] of moves ) {
		renameSync( a, b );
	}
	// Списки своего кода — из прежнего прода, если у stage их не было.
	const now = readJson( vs( 'sftp.json' ) );
	if ( ( ! now.ignore || ! now.ignore.length ) && old.ignore ) {
		now.ignore = old.ignore;
		now.watcher = old.watcher || {};
	}
	now.uploadOnSave = old.uploadOnSave ?? now.uploadOnSave;
	writeJson( vs( 'sftp.json' ), now );
	console.log( 'OK. Дальше: ACCESS.md → «Сервер» (хост, путь), «Публичный URL», «Окружения» (stage — нет или новый); gen-whitelist.mjs; режим заливки — по этапу 8 заново; connect-check.mjs.' );
	console.log( 'Старые конфиги — *.old.json (в git не коммитить пароли; удалить, когда старый хостинг отключён).' );
}

try {
	if ( cmd === 'build' ) {
		build();
	} else if ( cmd === 'promote' ) {
		promote();
	} else {
		throw new Error( 'Команда: build <project> [--server <ключ>] [--yes] | promote [--yes]' );
	}
} catch ( e ) {
	console.error( String( e instanceof Error ? e.message : e ) );
	process.exit( 1 );
}
