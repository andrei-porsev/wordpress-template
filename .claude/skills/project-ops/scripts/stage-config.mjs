/**
 * Конфиги stage по профилю своего сервера и «stage становится продом» после переезда.
 *   node .claude/skills/project-ops/scripts/stage-config.mjs build <project> [--server vps] [--yes]
 *       ~/.wp-template/servers.json → .vscode/sftp-stage.json + ssh-stage.json (ignore / watcher — из sftp.json проекта;
 *       httpAuth и пароль подписки из прежнего sftp-stage.json сохраняются — пароль на каталог у каждого проекта свой);
 *       с --yes печатает команду для SSH Terminal подписки: публичный ключ агента + PHP Plesk в PATH
 *   node .claude/skills/project-ops/scripts/stage-config.mjs auth <project> [--server vps]
 *       httpAuth из sftp-stage.json → .vscode/playwright-mcp.json (после того как человек вписал пароль на каталог)
 *   node .claude/skills/project-ops/scripts/stage-config.mjs promote [--yes]
 *       после переключения DNS: sftp-stage.json → sftp.json (старый → sftp.old.json), ssh — так же, снимок синхронизации — тоже
 * Без --yes — только план. Секреты в вывод не попадают; данные сервера в контекст агента — тоже (только итоговые поля без паролей).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function profile() {
	if ( ! project || ! /^[a-z0-9][a-z0-9-_]*$/i.test( project ) ) {
		throw new Error( `Нужно имя проекта латиницей: stage-config.mjs ${ cmd } <project> [--server <ключ>]` );
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
	return { key, srv, url: fill( srv.stageUrl || '', project ) };
}

function build() {
	const { key, srv, url } = profile();
	if ( ! existsSync( vs( 'sftp.json' ) ) ) {
		throw new Error( 'Нет .vscode/sftp.json проекта — из него берутся ignore и watcher.' );
	}
	const base = readJson( vs( 'sftp.json' ) );
	// Вёрстка макета (project.json → markup) — только на stage: в ignore прода её нет.
	const projectPath = join( root, 'project-base', 'project.json' );
	const withMarkup = existsSync( projectPath ) && readJson( projectPath ).markup === true;
	const baseIgnore = base.ignore || [];
	const ignore = withMarkup && ! baseIgnore.includes( '!/markup' ) ? [ baseIgnore[ 0 ], '!/markup', '!/markup/**', ...baseIgnore.slice( 1 ) ].filter( Boolean ) : baseIgnore;
	const sftp = {
		name: `${ project } stage (${ key })`,
		host: srv.host,
		protocol: 'sftp',
		port: srv.port || 22,
		username: fill( srv.username, project ),
		privateKeyPath: srv.privateKeyPath || '',
		remotePath: fill( srv.remotePath || '/httpdocs', project ),
		context: '.',
		connectTimeout: 20000,
		uploadOnSave: false,
		ignore,
		watcher: base.watcher || {},
	};
	// Вписанное человеком в прежний конфиг: пароль на каталог проекта и пароль подписки при входе без ключа.
	// Поле password — только при входе без ключа; пустая заготовка httpAuth показывает, куда вписать пароль на каталог.
	const prev = existsSync( vs( 'sftp-stage.json' ) ) ? readJson( vs( 'sftp-stage.json' ) ) : {};
	if ( ! sftp.privateKeyPath ) {
		sftp.password = prev.password && prev.username === sftp.username ? prev.password : '';
	}
	sftp.httpAuth = prev.httpAuth?.user ? prev.httpAuth : { user: '', password: '' };
	const hasAuth = Boolean( sftp.httpAuth.user );
	const ssh = { host: '', port: sftp.port, username: '', password: '', privateKeyPath: '', cwd: sftp.remotePath, wpCli: srv.wpCli || 'wp' };

	console.log( `Stage по профилю «${ key }» (${ srv.title || srv.host }):` );
	console.log( `  ${ sftp.username }@${ sftp.host }:${ sftp.port } · ${ sftp.remotePath } · ${ sftp.privateKeyPath ? 'вход по ключу' : 'вход по паролю — вписать в sftp-stage.json' }${ hasAuth ? ' · httpAuth есть' : '' }` );
	console.log( `  Stage / dev URL: ${ url || '—' }` );
	// Копии старых конфигов — вне .vscode (он в git, а в конфигах пароли).
	const bakDir = join( root, '.claude', '.state', 'backups', 'config', new Date().toISOString().replace( /[-:T]/g, '' ).slice( 0, 14 ) );
	for ( const f of [ 'sftp-stage.json', 'ssh-stage.json' ] ) {
		existsSync( vs( f ) ) && console.log( `  ⚠️ ${ f } уже есть — будет перезаписан (старый → .claude/.state/backups/config/<время>/${ f })` );
	}
	if ( ! yes ) {
		console.log( 'ПЛАН: показать пользователю; после «да» — тот же запуск с --yes.' );
		return;
	}
	for ( const f of [ 'sftp-stage.json', 'ssh-stage.json' ] ) {
		if ( existsSync( vs( f ) ) ) {
			mkdirSync( bakDir, { recursive: true } );
			copyFileSync( vs( f ), join( bakDir, f ) );
		}
	}
	writeJson( vs( 'sftp-stage.json' ), sftp );
	writeJson( vs( 'ssh-stage.json' ), ssh );
	console.log( 'OK: .vscode/sftp-stage.json, .vscode/ssh-stage.json записаны.' );
	if ( hasAuth && url ) {
		writePlaywrightConfig( url, sftp.httpAuth );
	}
	terminalCommand( srv );
	console.log( `Дальше: ACCESS.md → «Окружения» (Stage: свой VPS, Stage-конфиг) и «Stage / dev URL: ${ url || '—' }»; проверка — connect-check.mjs --stage.` );
	sftp.privateKeyPath || sftp.password || console.log( 'Пароль подписки — в .vscode/sftp-stage.json → password (в чат не писать).' );
	sftp.privateKeyPath && console.log( 'Вход по ключу: пароль подписки и FTP не нужен и в конфиг не пишется.' );
	hasAuth || console.log( `Пароль на каталог stage — логин и пароль из Plesk → «Защищённые паролем папки» (окно пароля в браузере; не пароль подписки и не FTP) → .vscode/sftp-stage.json → httpAuth { "user", "password" }, затем stage-config.mjs auth ${ project }.` );
}

/*
 * Одна вставка для SSH Terminal подписки (Plesk): публичный ключ агента в authorized_keys и PHP Plesk в PATH через ~/.bashrc.
 * Повторный запуск безопасен: ключ не дублируется, прежняя строка PATH заменяется (смена версии PHP — поле php профиля).
 */
function terminalCommand( srv ) {
	const pubPath = srv.privateKeyPath ? `${ srv.privateKeyPath }.pub` : '';
	const pub = pubPath && existsSync( pubPath ) ? readFileSync( pubPath, 'utf8' ).trim() : '';
	if ( ! /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) [A-Za-z0-9+/=]+( [^'\n]*)?$/.test( pub ) ) {
		console.log( `⚠️ Публичный ключ не прочитан (${ pubPath || 'privateKeyPath пуст' }) — команду для SSH Terminal не собрать; ключ — в подписке → SSH Keys.` );
		return;
	}
	const php = /^\d+\.\d+$/.test( String( srv.php || '' ) ) ? srv.php : '8.3';
	const pathLine = `export PATH=/opt/plesk/php/${ php }/bin:$PATH`;
	const command = [
		'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
		`(grep -qxF '${ pub }' ~/.ssh/authorized_keys || echo '${ pub }' >> ~/.ssh/authorized_keys)`,
		`(echo '${ pathLine }'; grep -v '/opt/plesk/php/' ~/.bashrc 2>/dev/null || true) > ~/.bashrc.tmp && mv ~/.bashrc.tmp ~/.bashrc`,
		'source ~/.bashrc && php -v | head -1 && wp --version',
	].join( ' && ' );
	console.log( 'СДЕЛАТЬ ВРУЧНУЮ: Plesk → подписка → SSH Terminal → вставить одной строкой (ключ агента + PHP в PATH), Enter; в ответ — версии PHP и WP-CLI:' );
	console.log( command );
}

function auth() {
	const { url } = profile();
	const cfg = existsSync( vs( 'sftp-stage.json' ) ) ? readJson( vs( 'sftp-stage.json' ) ) : null;
	if ( ! cfg ) {
		throw new Error( `Нет .vscode/sftp-stage.json — сначала stage-config.mjs build ${ project }.` );
	}
	if ( ! cfg.httpAuth?.user ) {
		throw new Error( 'В .vscode/sftp-stage.json нет httpAuth { "user", "password" } — вписывает человек (пароль на каталог из Plesk).' );
	}
	if ( ! url ) {
		throw new Error( 'В профиле сервера нет stageUrl — адрес stage для браузера не известен.' );
	}
	writePlaywrightConfig( url, cfg.httpAuth );
}

/*
 * Пароль stage для браузера агента: конфиг Playwright MCP с httpCredentials только для origin stage — без пароля в адресе.
 * Подключение — `--config .vscode/playwright-mcp.json` в args playwright в .mcp.json и переподключение MCP (человек: /mcp).
 */
function writePlaywrightConfig( url, auth ) {
	const path = vs( 'playwright-mcp.json' );
	const cfg = existsSync( path ) ? readJson( path ) : {};
	cfg.browser = cfg.browser || {};
	// Окно развёрнуто, страница по размеру окна — как в шаблонном .vscode/playwright-mcp.json.
	cfg.browser.launchOptions = cfg.browser.launchOptions || { args: [ '--start-maximized' ] };
	cfg.browser.contextOptions = { viewport: null, ...( cfg.browser.contextOptions || {} ), httpCredentials: { username: auth.user, password: auth.password || '', origin: new URL( url ).origin } };
	writeJson( path, cfg );
	const mcp = existsSync( join( root, '.mcp.json' ) ) ? readFileSync( join( root, '.mcp.json' ), 'utf8' ) : '';
	console.log( 'OK: .vscode/playwright-mcp.json — пароль stage для браузера (только для его адреса).' );
	if ( ! mcp.includes( 'playwright-mcp.json' ) ) {
		console.log( 'СДЕЛАТЬ ВРУЧНУЮ (после «да» агент может дописать сам): .mcp.json → playwright → args: "--config", ".vscode/playwright-mcp.json"; затем /mcp → переподключить playwright.' );
	}
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
	} else if ( cmd === 'auth' ) {
		auth();
	} else if ( cmd === 'promote' ) {
		promote();
	} else {
		throw new Error( 'Команда: build <project> [--server <ключ>] [--yes] | auth <project> [--server <ключ>] | promote [--yes]' );
	}
} catch ( e ) {
	console.error( String( e instanceof Error ? e.message : e ) );
	process.exit( 1 );
}
