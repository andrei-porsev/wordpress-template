/**
 * Скиллы по манифесту .claude/skills.json (решение 016).
 * Сторонние скиллы шаблон не хранит: в манифесте закреплена проверенная версия (commit, tree, hash),
 * подключение скачивает ровно её, сверяет hash и проверяет содержимое на опасные места.
 * Свои скиллы шаблона (source: local) лежат в .claude/skills-optional/.
 * В репозитории шаблона: проверка апстрима, разбор новой версии (review), закрепление её в манифесте (update --apply).
 * В проекте: только подключение закреплённых версий; новые версии приходят с обновлением шаблона.
 * Запуск из корня: node .claude/skills/project-ops/scripts/skills-sync.mjs <команда> (без аргументов — справка).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
	checkoutHead,
	diffDirs,
	dirHash,
	fetchPinned,
	fileHash,
	findingsKey,
	formatFindings,
	git,
	pruneExcluded,
	scanSkill,
	tempDir,
	treeRef,
} from './skills-lib.mjs';

const root = resolve( process.env.CLAUDE_PROJECT_DIR || process.cwd() );
const MANIFEST = join( root, '.claude', 'skills.json' );
const SKILLS = join( root, '.claude', 'skills' );
const OPTIONAL = join( root, '.claude', 'skills-optional' );
const RULES = join( root, '.claude', 'rules' );
const RULES_OPT = join( root, '.claude', 'rules-optional' );
const STATE = join( root, '.claude', '.state', 'skills-sync.json' );
const AUDIT = join( root, '.claude', '.state', 'audit.log' );
const TEMPLATE_LABEL = join( root, '.claude', 'template.json' );
const TEMPLATE_MANIFEST = '.claude/template/manifest.json';
const TEMPLATE_BRANCH = 'template-update';
const SELF = 'node .claude/skills/project-ops/scripts/skills-sync.mjs';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOOK_MODE = process.argv.includes( '--hook' );
// Первый ответ агента ждёт SessionStart-хук: в режиме хука сеть коротко и с общим бюджетом.
const NET_TIMEOUT_MS = HOOK_MODE ? 10000 : 30000;
const HOOK_BUDGET_MS = 40000;
const startedAt = Date.now();

const githubSlug = ( url ) => ( String( url ).match( /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i ) || [] )[ 1 ]?.toLowerCase() || '';

// Репозиторий шаблона — origin совпадает с manifest.repo; иначе (или без origin) — проект.
function detectTemplate() {
	if ( process.env.SKILLS_SYNC_ROLE ) {
		return process.env.SKILLS_SYNC_ROLE === 'template';
	}
	try {
		const repo = githubSlug( JSON.parse( readFileSync( join( root, TEMPLATE_MANIFEST ), 'utf8' ) ).repo );
		return Boolean( repo ) && githubSlug( git( [ '-C', root, 'remote', 'get-url', 'origin' ] ) ) === repo;
	} catch {
		return false;
	}
}
const IS_TEMPLATE = detectTemplate();

const HELP = `Скиллы проекта (манифест .claude/skills.json)

  list                        стеки, скиллы и что подключено
  activate <стек…> [--accept] подключить стек: скиллы (сторонние — скачать закреплённую версию, сверить hash, проверить),
                              правила; --accept — подключить и с находками проверки (только после «да» пользователя)
  install <имя…> [--accept]   поставить или обновить в .claude/skills закреплённую версию подключённых скиллов
  deactivate <стек…> [--force] отключить стек (удаляет только неизменённые копии)

Только в репозитории шаблона:
  check [--hook]              новые версии в апстриме; --hook — тихий режим для SessionStart (раз в сутки)
  review <имя…> | --all       разбор новой версии: файлы, дифф, проверка; запоминает разобранную версию
  update <имя…> --apply       закрепить в манифесте версию из review (файлы не скачиваются в шаблон)
  ignore <имя…>               не напоминать про текущую версию апстрима
  add <имя> --source <id> --path <путь> [--stack <стек>] [--exclude <путь,…>] [--accept]
                              новый скилл из источника манифеста; --exclude — пути внутри скилла, которые не берутся

Пример: ${ SELF } activate fse woo content`;

function fail( message ) {
	console.error( message );
	process.exit( 1 );
}

function readJson( path, fallback ) {
	if ( ! existsSync( path ) ) {
		return fallback;
	}
	return JSON.parse( readFileSync( path, 'utf8' ) );
}

function writeJson( path, data ) {
	mkdirSync( dirname( path ), { recursive: true } );
	writeFileSync( path, JSON.stringify( data, null, '\t' ) + '\n' );
}

function audit( text ) {
	try {
		mkdirSync( dirname( AUDIT ), { recursive: true } );
		appendFileSync( AUDIT, `${ new Date().toISOString() } skills-sync ${ text }\n` );
	} catch {}
}

function loadManifest() {
	if ( ! existsSync( MANIFEST ) ) {
		fail( 'Нет .claude/skills.json. Запускай из корня репозитория.' );
	}
	const m = readJson( MANIFEST, {} );
	return { core: [], sources: {}, skills: {}, stacks: {}, active: [], ...m };
}

const saveManifest = ( m ) => writeJson( MANIFEST, m );

const templateOnly = ( what ) => {
	if ( ! IS_TEMPLATE ) {
		fail( `${ what } — только в репозитории шаблона. В проекте новые версии скиллов приходят с обновлением шаблона (по просьбе пользователя, project-ops → template.md).` );
	}
};

const errText = ( e ) => String( e.stderr || e.message || e ).trim().split( '\n' ).pop();

function sourceOf( m, name ) {
	const skill = m.skills[ name ];
	if ( ! skill ) {
		fail( `Скилла «${ name }» нет в манифесте.` );
	}
	if ( skill.source === 'local' ) {
		return null;
	}
	const src = m.sources[ skill.source ];
	if ( ! src ) {
		fail( `Источник «${ skill.source }» скилла «${ name }» не описан в sources.` );
	}
	return src;
}

const isPinned = ( m, name ) => Boolean( m.skills[ name ] && m.skills[ name ].source !== 'local' );
const isActive = ( name ) => existsSync( join( SKILLS, name ) );

// Подключённая копия стороннего скилла отличается от закреплённой версии.
const edited = ( m, name ) => isPinned( m, name ) && isActive( name ) && dirHash( join( SKILLS, name ) ) !== m.skills[ name ].hash;

// --- Проверка апстрима (шаблон) ---

function remoteHead( src ) {
	const line = git( [ 'ls-remote', src.repo, `refs/heads/${ src.ref }` ], { timeout: NET_TIMEOUT_MS } );
	const sha = line.split( /\s+/ )[ 0 ];
	if ( ! sha ) {
		throw new Error( `ветка ${ src.ref } не найдена` );
	}
	return sha;
}

// Хеши деревьев путей на вершине ветки: только деревья, без содержимого файлов.
function remoteTrees( src, paths ) {
	const dir = tempDir();
	try {
		git( [ 'clone', '--bare', '--quiet', '--depth', '1', '--filter=blob:none', '--single-branch', '--branch', src.ref, src.repo, dir ], { timeout: NET_TIMEOUT_MS } );
		const trees = {};
		for ( const p of paths ) {
			try {
				trees[ p ] = git( [ '--git-dir', dir, 'rev-parse', treeRef( p ) ] );
			} catch {
				trees[ p ] = null;
			}
		}
		return { head: git( [ '--git-dir', dir, 'rev-parse', 'HEAD' ] ), trees };
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
}

/**
 * Статусы апстрима. useCache — не ходить в сеть, если проверка была меньше суток назад.
 * Возвращает { rows, errors }.
 */
function collectStatus( m, useCache ) {
	const state = readJson( STATE, { checkedAt: 0, sources: {} } );
	state.sources ||= {};
	const fresh = useCache && Date.now() - state.checkedAt < DAY_MS;
	const bySource = {};
	for ( const [ name, skill ] of Object.entries( m.skills ) ) {
		if ( skill.source !== 'local' ) {
			( bySource[ skill.source ] ||= [] ).push( name );
		}
	}

	const errors = [];
	let touchedNetwork = false;
	for ( const [ id, names ] of Object.entries( bySource ) ) {
		const src = m.sources[ id ];
		const cached = state.sources[ id ];
		const paths = names.map( ( n ) => m.skills[ n ].path );
		const cacheCovers = cached && paths.every( ( p ) => p in ( cached.trees || {} ) );
		if ( fresh && cacheCovers ) {
			continue;
		}
		if ( HOOK_MODE && Date.now() - startedAt > HOOK_BUDGET_MS ) {
			errors.push( `${ id }: не успели за время старта, проверка в следующей сессии` );
			continue;
		}
		try {
			touchedNetwork = true;
			const head = remoteHead( src );
			if ( cached && cached.head === head && cacheCovers ) {
				continue;
			}
			state.sources[ id ] = { ...remoteTrees( src, paths ), checkedAt: Date.now() };
		} catch ( e ) {
			errors.push( `${ id }: ${ errText( e ) }` );
		}
	}
	if ( touchedNetwork ) {
		state.checkedAt = Date.now();
		writeJson( STATE, state );
	}

	const rows = [];
	for ( const [ name, skill ] of Object.entries( m.skills ) ) {
		const row = { name, source: skill.source, active: isActive( name ) };
		if ( skill.source === 'local' ) {
			row.status = 'local';
		} else {
			const remote = state.sources[ skill.source ]?.trees?.[ skill.path ];
			if ( remote === undefined ) {
				row.status = 'unknown';
			} else if ( remote === null ) {
				row.status = 'gone';
			} else if ( remote === skill.tree ) {
				row.status = 'ok';
			} else {
				row.status = remote === skill.ignoredTree ? 'ignored' : 'update';
			}
			row.remoteTree = remote;
		}
		rows.push( row );
	}
	return { rows, errors };
}

const STATUS_TEXT = {
	ok: 'актуален',
	update: 'есть новая версия',
	ignored: 'новая версия отложена',
	gone: 'удалён в апстриме',
	unknown: 'не проверен',
	local: 'свой',
};

function cmdCheck( m ) {
	templateOnly( 'check' );
	const { rows, errors } = collectStatus( m, false );
	for ( const r of rows ) {
		console.log( `${ r.name.padEnd( 28 ) } ${ STATUS_TEXT[ r.status ] }` );
	}
	for ( const e of errors ) {
		console.log( `Не удалось проверить ${ e }` );
	}
	const pending = rows.filter( ( r ) => r.status === 'update' ).map( ( r ) => r.name );
	if ( pending.length ) {
		console.log( `\nРазобрать новые версии: ${ SELF } review ${ pending.join( ' ' ) }` );
	}
}

// SessionStart в шаблоне: stdout уходит агенту в контекст, поэтому печатаем только когда есть что сказать.
function hookReport( m ) {
	if ( ! IS_TEMPLATE ) {
		return;
	}
	let result;
	try {
		result = collectStatus( m, true );
	} catch {
		return;
	}
	const pending = result.rows.filter( ( r ) => r.status === 'update' );
	const gone = result.rows.filter( ( r ) => r.status === 'gone' );
	if ( ! pending.length && ! gone.length ) {
		return;
	}
	const lines = [ 'Скиллы шаблона (skills-sync):' ];
	if ( pending.length ) {
		lines.push( `- в апстриме новые версии: ${ pending.map( ( r ) => r.name ).join( ', ' ) }.` );
	}
	if ( gone.length ) {
		lines.push( `- удалены в апстриме: ${ gone.map( ( r ) => r.name ).join( ', ' ) }.` );
	}
	lines.push(
		`Одной строкой сказать пользователю. По его просьбе — \`${ SELF } review <имена>\`, разбор и итог; ` +
			'закрепить — `update <имена> --apply` после «да». Отказ — `ignore <имена>`.'
	);
	process.stdout.write( lines.join( '\n' ) + '\n' );
}

// SessionStart в проекте: только начатое и не доведённое обновление шаблона; о новых версиях не сообщает — обновляет человек сам (решение 059).
function templateReport() {
	const label = readJson( TEMPLATE_LABEL, null );
	if ( ! label ) {
		return;
	}
	const lines = [];
	const own = readJson( join( root, TEMPLATE_MANIFEST ), { migrations: [] } );
	const open = ( own.migrations || [] ).filter( ( m ) => ! ( label.migrations || [] ).includes( m.id ) );
	if ( open.length ) {
		lines.push( `Шаблон: незавершённая миграция ${ open.map( ( m ) => m.id ).join( ', ' ) } — инструкция ${ open[ 0 ].doc }, после неё \`node .claude/skills/project-ops/scripts/template-update.mjs . --done <id>\`.` );
	}
	const unresolved = Object.keys( label.unresolved || {} );
	if ( unresolved.length ) {
		lines.push( `Шаблон: нерешённые конфликты обновления — ${ unresolved.join( ', ' ) } (\`project-ops\` → \`template.md\`, шаг 4).` );
	}
	// Метка новой версии живёт в ветке template-update, пока её не влили: без этой строки проект выглядит необновлённым.
	if ( git( [ '-C', root, 'branch', '--list', TEMPLATE_BRANCH ] ) && ! git( [ '-C', root, 'branch', '--merged', 'HEAD', '--list', TEMPLATE_BRANCH ] ) ) {
		const head = git( [ '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD' ] );
		lines.push(
			`Шаблон: обновление начато в ветке ${ TEMPLATE_BRANCH } и не влито${ head === TEMPLATE_BRANCH ? ' (сессия сейчас в этой ветке)' : ` (сессия в ${ head })` }. ` +
				'Не предлагать обновление заново; доделать или влить — по просьбе пользователя (`template.md`, шаг 9).'
		);
	}
	if ( lines.length ) {
		process.stdout.write( lines.join( '\n' ) + '\n' );
	}
}

// --- Разбор и закрепление новой версии (шаблон) ---

function textDiff( oldDir, newDir, maxLines ) {
	let text = '';
	try {
		git( [ 'diff', '--no-index', '--no-color', '--ignore-cr-at-eol', oldDir, newDir ] );
	} catch ( e ) {
		text = String( e.stdout || '' );
	}
	const lines = text.split( '\n' );
	const cut = lines.length > maxLines ? `\n… ещё ${ lines.length - maxLines } строк (полностью: git diff --no-index между версиями)` : '';
	return lines.slice( 0, maxLines ).join( '\n' ) + cut;
}

const licenseOf = ( dir ) => [ 'LICENSE', 'LICENSE.txt', 'LICENSE.md' ].map( ( f ) => join( dir, f ) ).find( existsSync );

function cmdReview( m, names, flags ) {
	templateOnly( 'review' );
	if ( flags.all ) {
		names = collectStatus( m, false ).rows.filter( ( r ) => r.status === 'update' ).map( ( r ) => r.name );
		if ( ! names.length ) {
			console.log( 'Новых версий нет.' );
			return;
		}
	}
	if ( ! names.length ) {
		fail( 'Укажи скиллы или --all.' );
	}
	const state = readJson( STATE, { checkedAt: 0, sources: {} } );
	state.reviewed ||= {};
	const bySource = {};
	for ( const name of names ) {
		if ( ! sourceOf( m, name ) ) {
			console.log( `${ name }: свой скилл, разбирать нечего.` );
			continue;
		}
		( bySource[ m.skills[ name ].source ] ||= [] ).push( name );
	}
	for ( const [ id, group ] of Object.entries( bySource ) ) {
		const src = m.sources[ id ];
		let head;
		try {
			head = checkoutHead( src, group.map( ( n ) => m.skills[ n ].path ) );
		} catch ( e ) {
			console.log( `Не удалось скачать ${ id }: ${ errText( e ) }` );
			continue;
		}
		const old = fetchPinned( m, group );
		try {
			for ( const name of group ) {
				const skill = m.skills[ name ];
				const newDir = join( head.dir, skill.path );
				console.log( `\n== ${ name } (${ src.repo }, ${ skill.path })` );
				if ( ! head.trees[ skill.path ] || ! existsSync( newDir ) ) {
					console.log( 'Удалён в апстриме. Решить: убрать из манифеста и стеков или сделать своим (source: local).' );
					continue;
				}
				if ( head.trees[ skill.path ] === skill.tree ) {
					console.log( 'Закреплённая версия и есть последняя.' );
					continue;
				}
				pruneExcluded( newDir, skill.exclude );
				const oldDir = old.ok[ name ] || null;
				if ( ! oldDir ) {
					console.log( `Закреплённую версию скачать не удалось (${ old.failed[ name ] }) — сравнение со всем содержимым новой.` );
				}
				console.log( `Версия: ${ ( skill.commit || '' ).slice( 0, 7 ) || '—' } → ${ head.commit.slice( 0, 7 ) }` );
				const files = diffDirs( oldDir, newDir );
				console.log( files.length ? `Файлы:\n${ files.join( '\n' ) }` : 'Файлы совпадают (изменилось только исключённое).' );
				const oldLic = oldDir && licenseOf( oldDir );
				const newLic = licenseOf( newDir );
				if ( ( oldLic ? fileHash( oldLic ) : '' ) !== ( newLic ? fileHash( newLic ) : '' ) ) {
					console.log( `! Лицензия изменилась или появилась/пропала — сверить с sources.${ id }.license (${ src.license || '—' }).` );
				}
				const scan = scanSkill( newDir );
				const before = oldDir ? new Set( scanSkill( oldDir ).findings.map( ( f ) => `${ f.file }\0${ f.kind }\0${ f.text.trim() }` ) ) : new Set();
				const fresh = scan.findings.filter( ( f ) => ! before.has( `${ f.file }\0${ f.kind }\0${ f.text.trim() }` ) );
				console.log( `Проверка: находок ${ scan.findings.length } (новых ${ fresh.length }), скриптов ${ scan.scripts.length }.` );
				if ( fresh.length ) {
					console.log( formatFindings( fresh ).join( '\n' ) );
				}
				if ( oldDir ) {
					const d = textDiff( oldDir, newDir, flags.full ? 5000 : 300 );
					if ( d.trim() ) {
						console.log( `\nДифф:\n${ d }` );
					}
				}
				state.reviewed[ name ] = {
					commit: head.commit,
					tree: head.trees[ skill.path ],
					hash: dirHash( newDir ),
					...( scan.findings.length ? { accepted: findingsKey( scan.findings ) } : {} ),
					at: Date.now(),
				};
			}
		} finally {
			rmSync( head.dir, { recursive: true, force: true } );
			old.cleanup();
		}
	}
	writeJson( STATE, state );
	console.log(
		'\nРазбор для пользователя: что изменилось по сути, находки проверки и вывод. Закрепить после его «да»: ' +
			`${ SELF } update ${ names.join( ' ' ) } --apply (закрепится ровно разобранная версия).`
	);
}

function cmdUpdate( m, names, flags ) {
	templateOnly( 'update' );
	if ( ! flags.apply ) {
		return cmdReview( m, names, flags );
	}
	if ( ! names.length ) {
		fail( 'Укажи скиллы.' );
	}
	const state = readJson( STATE, { reviewed: {} } );
	let changed = 0;
	for ( const name of names ) {
		const r = state.reviewed?.[ name ];
		if ( ! sourceOf( m, name ) ) {
			console.log( `${ name }: свой скилл — правится в skills-optional/ напрямую.` );
			continue;
		}
		if ( ! r ) {
			console.log( `${ name }: нет разбора — сначала review ${ name }.` );
			continue;
		}
		const skill = m.skills[ name ];
		Object.assign( skill, { commit: r.commit, tree: r.tree, hash: r.hash, updated: new Date().toISOString().slice( 0, 10 ) } );
		if ( r.accepted ) {
			skill.accepted = r.accepted;
		} else {
			delete skill.accepted;
		}
		delete skill.ignoredTree;
		delete state.reviewed[ name ];
		changed++;
		audit( `pin ${ name } ${ r.commit.slice( 0, 7 ) } hash ${ r.hash }` );
		console.log( `${ name }: закреплена версия ${ r.commit.slice( 0, 7 ) }.` );
	}
	if ( changed ) {
		saveManifest( m );
		writeJson( STATE, state );
	}
	console.log( `\nЗакреплено: ${ changed }. Подключённые в шаблоне копии обновить: ${ SELF } install <имена>; коммит — отдельный.` );
}

function cmdIgnore( m, names ) {
	templateOnly( 'ignore' );
	const { rows } = collectStatus( m, true );
	for ( const name of names ) {
		const row = rows.find( ( r ) => r.name === name );
		if ( ! row || row.status !== 'update' ) {
			console.log( `${ name }: нечего откладывать.` );
			continue;
		}
		m.skills[ name ].ignoredTree = row.remoteTree;
		console.log( `${ name }: не напоминать до следующего изменения в апстриме.` );
	}
	saveManifest( m );
}

// --- Установка закреплённых версий (шаблон и проект) ---

/**
 * Ставит в .claude/skills закреплённые версии сторонних скиллов: скачать, сверить tree и hash, проверить содержимое.
 * Находки, совпавшие с принятыми при разборе в шаблоне (skill.accepted), не останавливают; новые — только с --accept.
 * Возвращает { installed, blocked, failed }.
 */
function installPinned( m, names, flags ) {
	const result = { installed: [], blocked: [], failed: [] };
	const todo = [];
	for ( const name of names ) {
		const to = join( SKILLS, name );
		if ( existsSync( to ) && dirHash( to ) === m.skills[ name ].hash ) {
			continue;
		}
		if ( existsSync( to ) && ! flags.force ) {
			console.log( `${ name }: в skills/ версия отличается от закреплённой (правки проекта?) — не трогаю. Заменить: install ${ name } --force.` );
			result.failed.push( name );
			continue;
		}
		todo.push( name );
	}
	if ( ! todo.length ) {
		return result;
	}
	console.log( `Скачиваю закреплённые версии: ${ todo.join( ', ' ) }` );
	const got = fetchPinned( m, todo );
	try {
		for ( const name of todo ) {
			if ( got.failed[ name ] ) {
				console.log( `✖ ${ name }: ${ got.failed[ name ] }. Не подключён.` );
				audit( `install ${ name } FAILED ${ got.failed[ name ] }` );
				result.failed.push( name );
				continue;
			}
			const skill = m.skills[ name ];
			const scan = scanSkill( got.ok[ name ] );
			const known = scan.findings.length > 0 && findingsKey( scan.findings ) === skill.accepted;
			if ( scan.findings.length && ! known && ! flags.accept ) {
				console.log( `⚠ ${ name }: проверка нашла ${ scan.findings.length } мест(а), при разборе в шаблоне они не принимались:` );
				console.log( formatFindings( scan.findings ).join( '\n' ) );
				console.log( `  Не подключён. Показать пользователю; после его «да» — тот же вызов с --accept.` );
				audit( `install ${ name } ${ skill.commit.slice( 0, 7 ) } BLOCKED findings ${ scan.findings.length }` );
				result.blocked.push( name );
				continue;
			}
			const to = join( SKILLS, name );
			rmSync( to, { recursive: true, force: true } );
			cpSync( got.ok[ name ], to, { recursive: true } );
			const note = ! scan.findings.length ? 'проверка чистая' : known ? `находки (${ scan.findings.length }) приняты при разборе в шаблоне` : `находки (${ scan.findings.length }) приняты пользователем`;
			console.log( `+ skills/${ name } (${ skill.commit.slice( 0, 7 ) }, hash сверен, ${ note })` );
			if ( known ) {
				console.log( formatFindings( scan.findings, 10 ).join( '\n' ) );
			}
			audit( `install ${ name } ${ skill.commit.slice( 0, 7 ) } hash ok, ${ note }` );
			result.installed.push( name );
		}
	} finally {
		got.cleanup();
	}
	return result;
}

function cmdInstall( m, names, flags ) {
	if ( ! names.length ) {
		fail( 'Укажи скиллы.' );
	}
	const pinned = names.filter( ( n ) => {
		if ( ! m.skills[ n ] ) {
			console.log( `${ n }: нет в манифесте.` );
			return false;
		}
		if ( ! isPinned( m, n ) ) {
			console.log( `${ n }: свой скилл шаблона — подключается через activate.` );
			return false;
		}
		return true;
	} );
	const r = installPinned( m, pinned, flags );
	if ( r.blocked.length || r.failed.length ) {
		process.exitCode = 2;
	}
}

function stackOf( m, id ) {
	const stack = m.stacks[ id ];
	if ( ! stack ) {
		fail( `Стека «${ id }» нет. Есть: ${ Object.keys( m.stacks ).join( ', ' ) }.` );
	}
	return { skills: [], rules: [], plugins: [], ...stack };
}

function cmdActivate( m, ids, flags ) {
	if ( ! ids.length ) {
		fail( 'Укажи стеки. Список: list.' );
	}
	const plugins = [];
	const notes = [];
	const wanted = [ ...new Set( ids.flatMap( ( id ) => stackOf( m, id ).skills ) ) ];
	const pinned = wanted.filter( ( n ) => isPinned( m, n ) );
	const r = installPinned( m, pinned, flags );
	const notReady = new Set( [ ...r.blocked, ...r.failed ].filter( ( n ) => ! isActive( n ) ) );
	for ( const id of ids ) {
		const stack = stackOf( m, id );
		for ( const name of stack.skills.filter( ( n ) => ! isPinned( m, n ) ) ) {
			const from = join( OPTIONAL, name );
			const to = join( SKILLS, name );
			if ( ! existsSync( from ) ) {
				console.log( `${ name }: нет ни в манифесте как стороннего, ни в skills-optional/ — пропущен.` );
			} else if ( ! existsSync( to ) ) {
				cpSync( from, to, { recursive: true } );
				console.log( `+ skills/${ name }` );
			} else if ( dirHash( to ) !== dirHash( from ) ) {
				console.log( `${ name }: в skills/ своя версия — не трогаю.` );
			}
		}
		for ( const rule of stack.rules ) {
			const from = join( RULES_OPT, `${ rule }.md` );
			const to = join( RULES, `${ rule }.md` );
			if ( ! existsSync( from ) ) {
				console.log( `Правила ${ rule }.md нет в rules-optional/ — пропущено.` );
			} else if ( ! existsSync( to ) ) {
				cpSync( from, to );
				console.log( `+ rules/${ rule }.md` );
			} else if ( fileHash( to ) !== fileHash( from ) ) {
				console.log( `rules/${ rule }.md отличается от rules-optional — не трогаю.` );
			}
		}
		plugins.push( ...stack.plugins );
		if ( stack.note ) {
			notes.push( `${ id }: ${ stack.note }` );
		}
		if ( ! m.active.includes( id ) ) {
			m.active.push( id );
		}
	}
	saveManifest( m );

	if ( plugins.length ) {
		const enabled = {};
		const markets = {};
		for ( const p of plugins ) {
			enabled[ p.id ] = true;
			if ( p.marketplace ) {
				markets[ p.marketplace.name ] = { source: { source: 'github', repo: p.marketplace.repo } };
			}
		}
		const fragment = { enabledPlugins: enabled, ...( Object.keys( markets ).length ? { extraKnownMarketplaces: markets } : {} ) };
		console.log( '\nПлагины стека. .claude/settings.json правит только человек — передай пользователю фрагмент для слияния:' );
		console.log( JSON.stringify( fragment, null, '\t' ) );
		console.log( 'И установку на его машине (один раз):' );
		for ( const p of plugins ) {
			if ( p.marketplace ) {
				console.log( `  claude plugin marketplace add ${ p.marketplace.repo }` );
			}
			console.log( `  claude plugin install ${ p.id } --scope project` );
		}
	}
	for ( const n of notes ) {
		console.log( `\n${ n }` );
	}
	if ( notReady.size ) {
		console.log( `\nНе подключены: ${ [ ...notReady ].join( ', ' ) } — причина выше. Стек отмечен подключённым; доставить: ${ SELF } install <имена>.` );
		process.exitCode = 2;
	}
	console.log( '\nНовые скиллы видны в следующей сессии (или после /reload-plugins, если не подхватились).' );
}

function cmdDeactivate( m, ids, flags ) {
	const remaining = m.active.filter( ( a ) => ! ids.includes( a ) );
	const keepSkills = new Set( [ ...m.core, ...remaining.flatMap( ( a ) => stackOf( m, a ).skills ) ] );
	const keepRules = new Set( remaining.flatMap( ( a ) => stackOf( m, a ).rules ) );
	for ( const id of ids ) {
		const stack = stackOf( m, id );
		for ( const name of stack.skills ) {
			const dir = join( SKILLS, name );
			if ( keepSkills.has( name ) || ! existsSync( dir ) ) {
				continue;
			}
			const optional = join( OPTIONAL, name );
			const same = isPinned( m, name ) ? dirHash( dir ) === m.skills[ name ].hash : existsSync( optional ) && dirHash( optional ) === dirHash( dir );
			if ( ! same && ! flags.force ) {
				console.log( `${ name }: в skills/ есть правки проекта — не удаляю (--force удалит).` );
				continue;
			}
			rmSync( dir, { recursive: true, force: true } );
			console.log( `- skills/${ name }` );
		}
		for ( const rule of stack.rules ) {
			const file = join( RULES, `${ rule }.md` );
			const optional = join( RULES_OPT, `${ rule }.md` );
			if ( keepRules.has( rule ) || ! existsSync( file ) ) {
				continue;
			}
			if ( ( ! existsSync( optional ) || fileHash( optional ) !== fileHash( file ) ) && ! flags.force ) {
				console.log( `rules/${ rule }.md изменён — не удаляю (--force удалит).` );
				continue;
			}
			rmSync( file );
			console.log( `- rules/${ rule }.md` );
		}
		if ( stack.plugins.length ) {
			console.log( `Плагины стека ${ id } (${ stack.plugins.map( ( p ) => p.id ).join( ', ' ) }) — выключить в .claude/settings.json вручную.` );
		}
	}
	m.active = remaining;
	saveManifest( m );
}

function cmdList( m ) {
	for ( const [ id, raw ] of Object.entries( m.stacks ) ) {
		const s = { skills: [], rules: [], plugins: [], ...raw };
		const mark = m.active.includes( id ) ? '[x]' : '[ ]';
		const skills = s.skills.map( ( n ) => n + ( edited( m, n ) ? ' (правки проекта)' : '' ) );
		const parts = [
			skills.length ? `скиллы: ${ skills.join( ', ' ) }` : '',
			s.rules.length ? `правила: ${ s.rules.join( ', ' ) }` : '',
			s.plugins.length ? `плагины: ${ s.plugins.map( ( p ) => p.id ).join( ', ' ) }` : '',
		].filter( Boolean );
		console.log( `${ mark } ${ id.padEnd( 12 ) } ${ s.title || '' }\n      ${ parts.join( '; ' ) }` );
	}
	const inStacks = new Set( Object.values( m.stacks ).flatMap( ( s ) => s.skills || [] ) );
	const loose = Object.keys( m.skills ).filter( ( n ) => ! inStacks.has( n ) );
	if ( loose.length ) {
		console.log( `\nВне стеков: ${ loose.join( ', ' ) }` );
	}
}

function cmdAdd( m, name, flags ) {
	templateOnly( 'add' );
	if ( ! name || ! flags.source || ! flags.path ) {
		fail( `Нужно: add <имя> --source <id> --path <путь>. Источники: ${ Object.keys( m.sources ).join( ', ' ) }.` );
	}
	if ( m.skills[ name ] ) {
		fail( `«${ name }» уже в манифесте — это review / update.` );
	}
	const src = m.sources[ flags.source ];
	if ( ! src ) {
		fail( `Источника «${ flags.source }» нет в sources.` );
	}
	const fetched = checkoutHead( src, [ flags.path ] );
	try {
		const from = join( fetched.dir, flags.path );
		if ( ! fetched.trees[ flags.path ] || ! existsSync( join( from, 'SKILL.md' ) ) ) {
			fail( `В ${ src.repo } нет ${ flags.path }/SKILL.md.` );
		}
		const exclude = typeof flags.exclude === 'string' ? flags.exclude.split( ',' ).map( ( s ) => s.trim() ).filter( Boolean ) : [];
		pruneExcluded( from, exclude );
		const scan = scanSkill( from );
		console.log( `Проверка: находок ${ scan.findings.length }, скриптов ${ scan.scripts.length }.` );
		if ( scan.findings.length ) {
			console.log( formatFindings( scan.findings ).join( '\n' ) );
			if ( ! flags.accept ) {
				console.log( 'Не добавлен. Разобрать находки с пользователем; после его «да» — тот же вызов с --accept.' );
				process.exitCode = 2;
				return;
			}
		}
		m.skills[ name ] = {
			source: flags.source,
			path: flags.path,
			...( exclude.length ? { exclude } : {} ),
			commit: fetched.commit,
			tree: fetched.trees[ flags.path ],
			hash: dirHash( from ),
			...( scan.findings.length ? { accepted: findingsKey( scan.findings ) } : {} ),
			updated: new Date().toISOString().slice( 0, 10 ),
		};
		if ( flags.stack ) {
			const stack = ( m.stacks[ flags.stack ] ||= { title: flags.stack, skills: [] } );
			( stack.skills ||= [] ).includes( name ) || stack.skills.push( name );
		}
		saveManifest( m );
		audit( `add ${ name } ${ fetched.commit.slice( 0, 7 ) } hash ${ m.skills[ name ].hash }` );
		console.log( `+ ${ name } закреплён в манифесте (${ fetched.commit.slice( 0, 7 ) }); подключить — activate стека или install ${ name }.` );
	} finally {
		rmSync( fetched.dir, { recursive: true, force: true } );
	}
}

function parseArgs( argv ) {
	const positional = [];
	const flags = {};
	for ( let i = 0; i < argv.length; i++ ) {
		const a = argv[ i ];
		if ( a.startsWith( '--' ) ) {
			const key = a.slice( 2 );
			const next = argv[ i + 1 ];
			if ( [ 'source', 'path', 'stack', 'exclude' ].includes( key ) && next && ! next.startsWith( '--' ) ) {
				flags[ key ] = next;
				i++;
			} else {
				flags[ key ] = true;
			}
		} else {
			positional.push( a );
		}
	}
	return { command: positional[ 0 ], args: positional.slice( 1 ), flags };
}

const { command, args, flags } = parseArgs( process.argv.slice( 2 ) );

if ( flags.hook ) {
	// Хук не должен мешать старту сессии ни при каких ошибках.
	try {
		templateReport();
	} catch {}
	try {
		if ( existsSync( MANIFEST ) ) {
			hookReport( loadManifest() );
		}
	} catch {}
	process.exit( 0 );
}

const commands = {
	check: () => cmdCheck( loadManifest() ),
	list: () => cmdList( loadManifest() ),
	review: () => cmdReview( loadManifest(), args, flags ),
	update: () => cmdUpdate( loadManifest(), args, flags ),
	ignore: () => cmdIgnore( loadManifest(), args ),
	install: () => cmdInstall( loadManifest(), args, flags ),
	activate: () => cmdActivate( loadManifest(), args, flags ),
	deactivate: () => cmdDeactivate( loadManifest(), args, flags ),
	add: () => cmdAdd( loadManifest(), args[ 0 ], flags ),
};

if ( ! commands[ command ] ) {
	console.log( HELP );
	process.exit( command ? 1 : 0 );
}
commands[ command ]();
