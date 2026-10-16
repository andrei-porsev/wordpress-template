/**
 * Скиллы по манифесту .claude/skills.json: проверка обновлений апстрима, обновление, подключение стеков.
 * Запуск из корня: node .claude/skills/project-ops/scripts/skills-sync.mjs <команда> (без аргументов — справка).
 * Сеть — только git (ls-remote, clone во временную папку). Пишет только в .claude/skills*, .claude/rules,
 * манифест и .claude/.state/skills-sync.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve( process.env.CLAUDE_PROJECT_DIR || process.cwd() );
const MANIFEST = join( root, '.claude', 'skills.json' );
const SKILLS = join( root, '.claude', 'skills' );
const OPTIONAL = join( root, '.claude', 'skills-optional' );
const RULES = join( root, '.claude', 'rules' );
const RULES_OPT = join( root, '.claude', 'rules-optional' );
const STATE = join( root, '.claude', '.state', 'skills-sync.json' );
const TEMPLATE_LABEL = join( root, '.claude', 'template.json' );
const TEMPLATE_MANIFEST = '.claude/template/manifest.json';
const TEMPLATE_STATE = join( root, '.claude', '.state', 'template-check.json' );
const SELF = 'node .claude/skills/project-ops/scripts/skills-sync.mjs';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOOK_MODE = process.argv.includes( '--hook' );
// Первый ответ агента ждёт SessionStart-хук: в режиме хука сеть коротко и с общим бюджетом.
const NET_TIMEOUT_MS = HOOK_MODE ? 10000 : 30000;
const HOOK_BUDGET_MS = 40000;
const startedAt = Date.now();
const SKIP_NAMES = new Set( [ '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini' ] );

const HELP = `Скиллы проекта (манифест .claude/skills.json)

  check [--hook]              обновления в апстриме; --hook — тихий режим для SessionStart (раз в сутки)
  list                        стеки, скиллы и что подключено
  update <имя…> | --all       план обновления: какие файлы изменятся, дифф SKILL.md
  update <имя…> --apply       применить (копии в skills-optional/ и, если подключён, в skills/)
         [--force]            перезаписать локальные правки
  ignore <имя…>               не напоминать про текущую версию апстрима
  activate <стек…>            подключить скиллы и правила стека в .claude/skills и .claude/rules
  deactivate <стек…> [--force] отключить стек (удаляет только неизменённые копии)
  add <имя> --source <id> --path <путь> [--stack <стек>]  новый скилл из источника манифеста

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

function loadManifest() {
	if ( ! existsSync( MANIFEST ) ) {
		fail( 'Нет .claude/skills.json. Запускай из корня репозитория.' );
	}
	const m = readJson( MANIFEST, {} );
	return { core: [], sources: {}, skills: {}, stacks: {}, active: [], ...m };
}

const saveManifest = ( m ) => writeJson( MANIFEST, m );

// Файлы каталога: posix-пути относительно dir, отсортированы.
function listFiles( dir, prefix = '' ) {
	const out = [];
	for ( const entry of readdirSync( join( dir, prefix ), { withFileTypes: true } ) ) {
		if ( SKIP_NAMES.has( entry.name ) ) {
			continue;
		}
		const rel = prefix ? `${ prefix }/${ entry.name }` : entry.name;
		if ( entry.isDirectory() ) {
			out.push( ...listFiles( dir, rel ) );
		} else if ( entry.isFile() ) {
			out.push( rel );
		}
	}
	return out.sort();
}

// CRLF → LF для текстовых файлов: git на Windows с autocrlf не должен давать «локальные правки».
function fileHash( path ) {
	let buf = readFileSync( path );
	if ( ! buf.includes( 0 ) ) {
		buf = Buffer.from( buf.toString( 'latin1' ).replace( /\r\n/g, '\n' ), 'latin1' );
	}
	return createHash( 'sha256' ).update( buf ).digest( 'hex' );
}

function fileMap( dir ) {
	const map = {};
	for ( const rel of listFiles( dir ) ) {
		map[ rel ] = fileHash( join( dir, rel ) );
	}
	return map;
}

function dirHash( dir ) {
	const h = createHash( 'sha256' );
	for ( const [ rel, sum ] of Object.entries( fileMap( dir ) ) ) {
		h.update( `${ rel }\0${ sum }\n` );
	}
	return h.digest( 'hex' ).slice( 0, 16 );
}

function git( args, options = {} ) {
	return execFileSync( 'git', [ '-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', ...args ], {
		encoding: 'utf8',
		stdio: [ 'ignore', 'pipe', 'pipe' ],
		timeout: NET_TIMEOUT_MS,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		...options,
	} ).trim();
}

function tempDir() {
	return mkdtempSync( join( tmpdir(), 'skills-sync-' ) );
}

function remoteHead( src ) {
	const line = git( [ 'ls-remote', src.repo, `refs/heads/${ src.ref }` ] );
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
		git( [ 'clone', '--bare', '--quiet', '--depth', '1', '--filter=blob:none', '--single-branch', '--branch', src.ref, src.repo, dir ] );
		const trees = {};
		for ( const p of paths ) {
			try {
				trees[ p ] = git( [ '--git-dir', dir, 'rev-parse', `HEAD:${ p }` ] );
			} catch {
				trees[ p ] = null;
			}
		}
		return { head: git( [ '--git-dir', dir, 'rev-parse', 'HEAD' ] ), trees };
	} finally {
		rmSync( dir, { recursive: true, force: true } );
	}
}

// Рабочая копия только нужных путей. Возвращает { dir, commit, trees }; dir удалить после работы.
function checkoutPaths( src, paths ) {
	const dir = tempDir();
	git( [ 'clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', src.ref, src.repo, dir ] );
	git( [ '-C', dir, 'sparse-checkout', 'set', '--no-cone', ...paths.map( ( p ) => `/${ p }/` ) ] );
	git( [ '-C', dir, 'checkout', '--quiet' ] );
	const trees = {};
	for ( const p of paths ) {
		try {
			trees[ p ] = git( [ '-C', dir, 'rev-parse', `HEAD:${ p }` ] );
		} catch {
			trees[ p ] = null;
		}
	}
	return { dir, commit: git( [ '-C', dir, 'rev-parse', 'HEAD' ] ), trees };
}

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

const isActive = ( name ) => existsSync( join( SKILLS, name ) );

// Есть ли локальные правки в копиях скилла (skills-optional/ и skills/).
function localEdits( name, skill ) {
	const edited = [];
	for ( const [ label, base ] of [ [ 'skills-optional', OPTIONAL ], [ 'skills', SKILLS ] ] ) {
		const dir = join( base, name );
		if ( existsSync( dir ) && skill.hash && dirHash( dir ) !== skill.hash ) {
			edited.push( label );
		}
	}
	return edited;
}

/**
 * Статусы апстрима. useCache — не ходить в сеть, если проверка была меньше суток назад.
 * Возвращает { rows, errors, fromCache }.
 */
function collectStatus( m, useCache ) {
	const state = readJson( STATE, { checkedAt: 0, sources: {} } );
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
			errors.push( `${ id }: ${ String( e.message || e ).split( '\n' )[ 0 ] }` );
		}
	}
	if ( touchedNetwork ) {
		state.checkedAt = Date.now();
		writeJson( STATE, state );
	}

	const rows = [];
	for ( const [ name, skill ] of Object.entries( m.skills ) ) {
		const row = { name, source: skill.source, active: isActive( name ), edited: localEdits( name, skill ) };
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
	return { rows, errors, fromCache: ! touchedNetwork };
}

const STATUS_TEXT = {
	ok: 'актуален',
	update: 'есть обновление',
	ignored: 'обновление отложено',
	gone: 'удалён в апстриме',
	unknown: 'не проверен',
	local: 'свой',
};

function cmdCheck( m, flags ) {
	if ( flags.hook ) {
		return hookReport( m );
	}
	const { rows, errors } = collectStatus( m, false );
	for ( const r of rows ) {
		const marks = [ r.active ? 'подключён' : '', r.edited.length ? `правки: ${ r.edited.join( ', ' ) }` : '' ].filter( Boolean );
		console.log( `${ r.name.padEnd( 28 ) } ${ STATUS_TEXT[ r.status ].padEnd( 20 ) } ${ marks.join( '; ' ) }` );
	}
	for ( const e of errors ) {
		console.log( `Не удалось проверить ${ e }` );
	}
	const pending = rows.filter( ( r ) => r.status === 'update' ).map( ( r ) => r.name );
	if ( pending.length ) {
		console.log( `\nПлан обновления: ${ SELF } update ${ pending.join( ' ' ) }` );
	}
}

// SessionStart: stdout уходит агенту в контекст, поэтому печатаем только когда есть что сказать.
function hookReport( m ) {
	let result;
	try {
		result = collectStatus( m, true );
	} catch {
		return;
	}
	const anyActive = m.active.length > 0;
	const pending = result.rows.filter( ( r ) => r.status === 'update' && ( ! anyActive || r.active ) );
	const gone = result.rows.filter( ( r ) => r.status === 'gone' && r.active );
	if ( ! pending.length && ! gone.length ) {
		return;
	}
	const lines = [ 'Скиллы проекта (skills-sync):' ];
	if ( pending.length ) {
		const names = pending.map( ( r ) => r.name + ( r.edited.length ? ' (есть локальные правки)' : '' ) );
		lines.push( `- в апстриме обновились: ${ names.join( ', ' ) }.` );
	}
	if ( gone.length ) {
		lines.push( `- удалены в апстриме: ${ gone.map( ( r ) => r.name ).join( ', ' ) }.` );
	}
	lines.push(
		`Перед первой задачей одной строкой предложи пользователю обновить. План: \`${ SELF } update <имена>\`, ` +
			'применить — тот же вызов с `--apply`, только после его «да». Отказ — `ignore <имена>`.'
	);
	process.stdout.write( lines.join( '\n' ) + '\n' );
}

// Версии вида 2026.10.16 или 2026.10.16.2: сравнение по числам.
function newer( a, b ) {
	const x = String( a ).split( '.' ).map( Number );
	const y = String( b ).split( '.' ).map( Number );
	for ( let i = 0; i < Math.max( x.length, y.length ); i++ ) {
		if ( ( x[ i ] || 0 ) !== ( y[ i ] || 0 ) ) {
			return ( x[ i ] || 0 ) > ( y[ i ] || 0 );
		}
	}
	return false;
}

// Манифест последней версии шаблона: из его папки, нет папки — с GitHub (раз в сутки, качает только при смене коммита).
function latestTemplate( label, state ) {
	const local = label.source?.path && join( label.source.path, TEMPLATE_MANIFEST );
	if ( local && existsSync( local ) ) {
		return readJson( local, null );
	}
	if ( ! label.source?.repo ) {
		return null;
	}
	if ( state.checkedAt && Date.now() - state.checkedAt < DAY_MS ) {
		return state.latest || null;
	}
	const head = git( [ 'ls-remote', label.source.repo, 'HEAD' ] ).split( /\s+/ )[ 0 ];
	let latest = state.latest && state.head === head ? state.latest : null;
	if ( ! latest && head === label.commit ) {
		latest = { version: label.version, migrations: [] };
	}
	if ( ! latest ) {
		const dir = tempDir();
		try {
			git( [ 'clone', '--bare', '--quiet', '--depth', '1', '--filter=blob:none', label.source.repo, dir ] );
			latest = JSON.parse( git( [ '--git-dir', dir, 'show', `HEAD:${ TEMPLATE_MANIFEST }` ] ) );
		} finally {
			rmSync( dir, { recursive: true, force: true } );
		}
	}
	Object.assign( state, { checkedAt: Date.now(), head, latest } );
	return latest;
}

// SessionStart: версия шаблона и незавершённые миграции — не чаще раза в сутки (решение 032).
function templateReport() {
	const label = readJson( TEMPLATE_LABEL, null );
	const state = readJson( TEMPLATE_STATE, {} );
	if ( state.notifiedAt && Date.now() - state.notifiedAt < DAY_MS ) {
		return;
	}
	const lines = [];
	if ( ! label ) {
		// Без метки и без манифеста — старый проект; с манифестом — сам шаблон.
		if ( existsSync( join( root, TEMPLATE_MANIFEST ) ) ) {
			return;
		}
		lines.push( 'Шаблон: версия проекта неизвестна (нет .claude/template.json). Одной строкой предложи обновить проект по процедуре `project-ops` → `template.md`.' );
	} else {
		const own = readJson( join( root, TEMPLATE_MANIFEST ), { migrations: [] } );
		const open = ( own.migrations || [] ).filter( ( m ) => ! ( label.migrations || [] ).includes( m.id ) );
		if ( open.length ) {
			lines.push( `Шаблон: незавершённая миграция ${ open.map( ( m ) => m.id ).join( ', ' ) } — инструкция ${ open[ 0 ].doc }, после неё \`template-update.mjs "<проект>" --done <id>\`.` );
		}
		const latest = latestTemplate( label, state );
		if ( latest && newer( latest.version, label.version ) ) {
			const pending = ( latest.migrations || [] ).filter( ( m ) => ! ( label.migrations || [] ).includes( m.id ) ).length;
			const cmd = `node "${ label.source.path }/.claude/skills/project-ops/scripts/template-update.mjs" "${ root.replace( /\\/g, '/' ) }"`;
			lines.push(
				`Шаблон: доступна ${ latest.version } (у проекта ${ label.version }${ pending ? `, миграций: ${ pending }` : '' }). ` +
					`Одной строкой предложи обновить. Пробный прогон: \`${ cmd }\`; применение — после «да» (\`project-ops\` → \`template.md\`). Отказ — напомнить завтра.`
			);
		}
	}
	if ( lines.length ) {
		state.notifiedAt = Date.now();
		process.stdout.write( lines.join( '\n' ) + '\n' );
	}
	writeJson( TEMPLATE_STATE, state );
}

// Сравнение двух каталогов скилла: добавленные, удалённые, изменённые файлы.
function diffDirs( oldDir, newDir ) {
	const a = existsSync( oldDir ) ? fileMap( oldDir ) : {};
	const b = fileMap( newDir );
	const out = [];
	for ( const rel of Object.keys( b ) ) {
		if ( ! ( rel in a ) ) {
			out.push( `+ ${ rel }` );
		} else if ( a[ rel ] !== b[ rel ] ) {
			out.push( `~ ${ rel }` );
		}
	}
	for ( const rel of Object.keys( a ) ) {
		if ( ! ( rel in b ) ) {
			out.push( `- ${ rel }` );
		}
	}
	return out;
}

function skillMdDiff( oldDir, newDir, maxLines = 120 ) {
	const oldFile = join( oldDir, 'SKILL.md' );
	const newFile = join( newDir, 'SKILL.md' );
	if ( ! existsSync( oldFile ) || ! existsSync( newFile ) ) {
		return '';
	}
	let text = '';
	try {
		git( [ 'diff', '--no-index', '--no-color', '--ignore-cr-at-eol', oldFile, newFile ] );
	} catch ( e ) {
		text = String( e.stdout || '' );
	}
	const lines = text.split( '\n' ).slice( 4 );
	const cut = lines.length > maxLines ? `\n… ещё ${ lines.length - maxLines } строк` : '';
	return lines.slice( 0, maxLines ).join( '\n' ) + cut;
}

function replaceDir( from, to ) {
	rmSync( to, { recursive: true, force: true } );
	cpSync( from, to, { recursive: true } );
}

function cmdUpdate( m, names, flags ) {
	if ( flags.all ) {
		const { rows } = collectStatus( m, false );
		names = rows.filter( ( r ) => r.status === 'update' ).map( ( r ) => r.name );
		if ( ! names.length ) {
			console.log( 'Обновлений нет.' );
			return;
		}
	}
	if ( ! names.length ) {
		fail( 'Укажи скиллы или --all.' );
	}

	const bySource = {};
	for ( const name of names ) {
		if ( ! sourceOf( m, name ) ) {
			console.log( `${ name }: свой скилл, обновлять неоткуда.` );
			continue;
		}
		( bySource[ m.skills[ name ].source ] ||= [] ).push( name );
	}

	let changed = 0;
	for ( const [ id, group ] of Object.entries( bySource ) ) {
		const src = m.sources[ id ];
		let fetched;
		try {
			fetched = checkoutPaths( src, group.map( ( n ) => m.skills[ n ].path ) );
		} catch ( e ) {
			console.log( `Не удалось скачать ${ id }: ${ String( e.message || e ).split( '\n' )[ 0 ] }` );
			continue;
		}
		try {
			for ( const name of group ) {
				const skill = m.skills[ name ];
				const newDir = join( fetched.dir, skill.path );
				const newTree = fetched.trees[ skill.path ];
				console.log( `\n== ${ name } (${ src.repo }, ${ skill.path })` );
				if ( ! newTree || ! existsSync( newDir ) ) {
					console.log( 'Удалён в апстриме — оставлен как есть. Решить: убрать из манифеста или сделать своим (source: local).' );
					continue;
				}
				if ( newTree === skill.tree && ! flags.force ) {
					console.log( 'Уже актуален.' );
					continue;
				}
				const edited = localEdits( name, skill );
				if ( edited.length && ! flags.force ) {
					console.log( `Локальные правки в ${ edited.join( ', ' ) } — не трогаю. Перенеси правки или запусти с --force.` );
					continue;
				}
				const optionalDir = join( OPTIONAL, name );
				const changes = diffDirs( optionalDir, newDir );
				console.log( changes.length ? changes.join( '\n' ) : 'Файлы совпадают, обновится только запись в манифесте.' );
				if ( ! flags.apply ) {
					const d = skillMdDiff( optionalDir, newDir );
					if ( d.trim() ) {
						console.log( `\nSKILL.md:\n${ d }` );
					}
					continue;
				}
				replaceDir( newDir, optionalDir );
				if ( isActive( name ) ) {
					replaceDir( newDir, join( SKILLS, name ) );
				}
				Object.assign( skill, {
					commit: fetched.commit,
					tree: newTree,
					hash: dirHash( optionalDir ),
					updated: new Date().toISOString().slice( 0, 10 ),
				} );
				delete skill.ignoredTree;
				changed++;
				console.log( isActive( name ) ? 'Обновлён (skills-optional и skills).' : 'Обновлён (skills-optional).' );
			}
		} finally {
			rmSync( fetched.dir, { recursive: true, force: true } );
		}
	}

	if ( flags.apply ) {
		if ( changed ) {
			saveManifest( m );
		}
		console.log( `\nОбновлено: ${ changed }. Изменения — в git diff; закоммитить отдельным коммитом.` );
	} else {
		console.log( `\nЭто план. Применить: ${ SELF } update ${ names.join( ' ' ) } --apply` );
	}
}

function cmdIgnore( m, names ) {
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

function stackOf( m, id ) {
	const stack = m.stacks[ id ];
	if ( ! stack ) {
		fail( `Стека «${ id }» нет. Есть: ${ Object.keys( m.stacks ).join( ', ' ) }.` );
	}
	return { skills: [], rules: [], plugins: [], ...stack };
}

function cmdActivate( m, ids ) {
	if ( ! ids.length ) {
		fail( 'Укажи стеки. Список: list.' );
	}
	const plugins = [];
	const notes = [];
	for ( const id of ids ) {
		const stack = stackOf( m, id );
		for ( const name of stack.skills ) {
			const from = join( OPTIONAL, name );
			const to = join( SKILLS, name );
			if ( ! existsSync( from ) ) {
				console.log( `${ name }: нет в skills-optional/ — пропущен.` );
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
			const same = existsSync( optional ) && dirHash( optional ) === dirHash( dir );
			if ( ! same && ! flags.force ) {
				console.log( `${ name }: в skills/ есть правки, которых нет в skills-optional/ — не удаляю (--force удалит).` );
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
		const parts = [
			s.skills.length ? `скиллы: ${ s.skills.join( ', ' ) }` : '',
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
	if ( ! name || ! flags.source || ! flags.path ) {
		fail( `Нужно: add <имя> --source <id> --path <путь>. Источники: ${ Object.keys( m.sources ).join( ', ' ) }.` );
	}
	if ( m.skills[ name ] ) {
		fail( `«${ name }» уже в манифесте — это update.` );
	}
	const src = m.sources[ flags.source ];
	if ( ! src ) {
		fail( `Источника «${ flags.source }» нет в sources.` );
	}
	const fetched = checkoutPaths( src, [ flags.path ] );
	try {
		const from = join( fetched.dir, flags.path );
		if ( ! fetched.trees[ flags.path ] || ! existsSync( join( from, 'SKILL.md' ) ) ) {
			fail( `В ${ src.repo } нет ${ flags.path }/SKILL.md.` );
		}
		const to = join( OPTIONAL, name );
		if ( existsSync( to ) ) {
			fail( `skills-optional/${ name } уже есть, но не в манифесте. Разберись вручную.` );
		}
		cpSync( from, to, { recursive: true } );
		m.skills[ name ] = {
			source: flags.source,
			path: flags.path,
			commit: fetched.commit,
			tree: fetched.trees[ flags.path ],
			hash: dirHash( to ),
			updated: new Date().toISOString().slice( 0, 10 ),
		};
		if ( flags.stack ) {
			const stack = ( m.stacks[ flags.stack ] ||= { title: flags.stack, skills: [] } );
			( stack.skills ||= [] ).includes( name ) || stack.skills.push( name );
		}
		saveManifest( m );
		console.log( `+ skills-optional/${ name } (${ fetched.commit.slice( 0, 7 ) })` );
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
			if ( [ 'source', 'path', 'stack' ].includes( key ) && next && ! next.startsWith( '--' ) ) {
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
	check: () => cmdCheck( loadManifest(), flags ),
	list: () => cmdList( loadManifest() ),
	update: () => cmdUpdate( loadManifest(), args, flags ),
	ignore: () => cmdIgnore( loadManifest(), args ),
	activate: () => cmdActivate( loadManifest(), args ),
	deactivate: () => cmdDeactivate( loadManifest(), args, flags ),
	add: () => cmdAdd( loadManifest(), args[ 0 ], flags ),
};

if ( ! commands[ command ] ) {
	console.log( HELP );
	process.exit( command ? 1 : 0 );
}
commands[ command ]();
