/**
 * Самопроверка охранников без сервера: node .claude/hooks/selftest.mjs
 * Гоняет guard-paths, guard-bash и guard-wpcli на временном проекте (CLAUDE_PROJECT_DIR).
 * Код выхода 0 — все кейсы прошли. Так project-init проверяет хуки при старте проекта.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = dirname( fileURLToPath( import.meta.url ) );
const root = mkdtempSync( join( tmpdir(), 'wp-hooks-' ) );
mkdirSync( join( root, 'project-base' ), { recursive: true } );
writeFileSync( join( root, 'project-base', 'project.json' ), JSON.stringify( { stem: 'acme', themes: [ 'acme-child' ], plugins: [], muPlugins: [], blocks: [] } ) );

const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
delete env.CLAUDE_TEMPLATE_DEV;

function run( hook, input ) {
	const r = spawnSync( process.execPath, [ join( hooks, hook ) ], { input: JSON.stringify( { ...input, cwd: root, session_id: 'selftest' } ), encoding: 'utf8', env, timeout: 30000 } );
	let decision = 'pass';
	if ( r.status === 2 ) {
		decision = 'deny';
	} else if ( r.stdout.trim() ) {
		decision = JSON.parse( r.stdout ).hookSpecificOutput?.permissionDecision || 'pass';
	}
	return decision;
}

let failed = 0;
let total = 0;
function check( label, got, want ) {
	total++;
	const ok = got === want;
	failed += ok ? 0 : 1;
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ want.padEnd( 5 ) } ${ ok ? '' : `(получено ${ got }) ` }${ label }` );
}

// guard-paths (Write/Edit): deny = код выхода 2
const file = ( p ) => ( { tool_name: 'Write', tool_input: { file_path: join( root, p ) } } );
for ( const [ p, want ] of [
	[ 'wp-config.php', 'deny' ],
	[ 'wp-includes/x.php', 'deny' ],
	[ 'wp-content/themes/other/functions.php', 'deny' ],
	[ 'wp-content/uploads/a.jpg', 'deny' ],
	[ '.claude/hooks/lib.mjs', 'deny' ],
	[ '.claude/settings.json', 'deny' ],
	[ '.git/config', 'deny' ],
	[ 'wp-content/themes/acme-child/functions.php', 'pass' ],
	[ 'CLAUDE.md', 'pass' ],
] ) {
	check( `guard-paths ${ p }`, run( 'guard-paths.mjs', file( p ) ), want );
}

// guard-bash: запись через оболочку
const sh = ( command ) => ( { tool_name: 'Bash', tool_input: { command } } );
for ( const [ c, want ] of [
	[ 'echo x > wp-config.php', 'deny' ],
	[ 'sed -i s/a/b/ wp-content/themes/other/f.php', 'deny' ],
	[ 'rm -rf wp-content/plugins/foo', 'deny' ],
	[ 'echo x > .claude/hooks/lib.mjs', 'deny' ],
	[ 'cp a wp-content/themes/other/b.php', 'deny' ],
	[ 'Set-Content -Path wp-config.php -Value x', 'deny' ],
	[ 'cp a wp-content/themes/acme-child/b.php', 'deny' ],
	[ 'sed -i s/a/b/ wp-content/themes/acme-child/assets/scss/_a.scss', 'deny' ],
	[ 'echo x > wp-content/themes/acme-child/functions.php', 'deny' ],
	[ 'cat a | tee wp-content/themes/acme-child/theme.json', 'deny' ],
	[ 'cp logo.png wp-content/themes/acme-child/assets/img/logo.png', 'pass' ],
	[ 'cp wp-content/themes/acme-child/a.php /tmp/a.php', 'pass' ],
	[ 'echo x > wp-content/themes/acme-child/assets/css/a.css', 'pass' ],
	[ 'rm wp-content/themes/acme-child/old.php', 'pass' ],
	[ "node -e \"require('fs').writeFileSync('wp-content/themes/acme-child/a.scss', 'x')\"", 'deny' ],
	[ "node - <<'EOF'\nconst fs = require('fs');\nfs.writeFileSync('wp-content/themes/acme-child/a.php', 'x');\nEOF", 'deny' ],
	[ 'node -e "console.log(1)"', 'pass' ],
	[ "node -e \"require('fs').readFileSync('wp-content/themes/acme-child/a.php')\"", 'pass' ],
	[ 'python -c "print(1)"', 'deny' ],
	[ "python3 - <<'EOF'\nprint(1)\nEOF", 'deny' ],
	[ 'py scripts/report.py', 'pass' ],
	[ 'ls > out.txt', 'pass' ],
	[ 'echo "a => b" > /dev/null', 'pass' ],
	[ 'npm run build', 'pass' ],
	[ 'git status', 'pass' ],
	[ 'node script.mjs', 'pass' ],
] ) {
	check( `guard-bash ${ c }`, run( 'guard-bash.mjs', sh( c ) ), want );
}

// guard-wpcli: команды на сервере
const S = 'node .claude/skills/project-ops/scripts/ssh-exec.mjs';
for ( const [ c, want ] of [
	[ `${ S } -- wp plugin list`, 'pass' ],
	[ `${ S } -- wp db drop --yes`, 'deny' ],
	[ `cd x && ${ S } --stage -- wp plugin update --all`, 'ask' ],
	[ `${ S } -- wp cache flush && rm -rf x`, 'deny' ],
	[ `${ S } -- wp cache flush ; echo hi`, 'ask' ],
	[ `${ S } -- 'wp post update 1 --post_content="$(echo eA== | base64 -d)"'`, 'ask' ],
	[ `${ S } --stage -- 'wp post update 1 --post_title="$(echo eA== | base64 -d)"'`, 'ask' ],
	[ `${ S } -- "wp db drop --yes; ls"`, 'deny' ],
	[ `${ S } --stdin d.html -- wp post create - --post_status=draft --post_category=5 --post_title="Пам'ять"`, 'allow' ],
	[ `${ S } -- wp post create --post_title=x`, 'ask' ],
	[ `${ S } -- wp post create --post_status=draft --post_status=publish`, 'ask' ],
	[ `${ S } -- wp post update 5 --post_status=draft`, 'ask' ],
	[ `${ S } -- wp litespeed-purge all`, 'allow' ],
	[ `${ S } --stage -- wp w3-total-cache flush all`, 'allow' ],
	[ `${ S } -- wp rocket clean --confirm`, 'allow' ],
	[ `${ S } -- wp sg purge`, 'allow' ],
	[ `${ S } -- wp litespeed-purge all ; echo hi`, 'ask' ],
	[ `${ S } -- wp litespeed-option set x 1`, 'ask' ],
	[ `${ S } -- wp search-replace a b`, 'ask' ],
	[ `${ S } -- wp search-replace a b --dry-run`, 'pass' ],
	[ `${ S } -- "wp option get siteurl"`, 'pass' ],
	[ `${ S } -- wp option get "a;b|c"`, 'pass' ],
	[ `${ S } -- wp option get 'a;b'`, 'pass' ],
	[ `${ S } -- wp option get "$(id)"`, 'ask' ],
	[ `${ S } -- wp option get 'x' ; echo hi`, 'ask' ],
	[ `${ S } -- wp eval 'echo do_blocks("<!-- wp:a {\\"b\\":1} /-->"); echo 1;'`, 'ask' ],
	[ `${ S } -- wp db query "DELETE FROM x"`, 'ask' ],
	[ `${ S } -- wp db query "DROP TABLE x"`, 'deny' ],
	[ `${ S } -- "wp db query 'SELECT * FROM wp_posts WHERE ID > 5'"`, 'pass' ],
	[ `${ S } -- wp db export`, 'pass' ],
	[ `${ S } -- "wp db export > d.sql"`, 'deny' ],
	[ `${ S } -- sudo ls`, 'deny' ],
	[ `${ S } -- ls -la`, 'allow' ],
	[ `${ S } -- tail -n 50 wp-content/debug.log`, 'allow' ],
	[ `${ S } -- "tail -n 200 wp-content/debug.log | grep -E 'PHP Fatal'"`, 'allow' ],
	[ `${ S } -- php -l wp-content/themes/x/functions.php`, 'allow' ],
	[ `${ S } -- php -r "echo 1;"`, 'ask' ],
	[ `${ S } -- cat wp-config.php`, 'deny' ],
	[ `${ S } -- "echo x > wp-content/themes/a/f.php"`, 'deny' ],
	[ `${ S } -- "sed -i s/a/b/ wp-content/themes/a/f.php"`, 'deny' ],
	[ `${ S } -- cp a b`, 'deny' ],
	[ `${ S } -- rm a.php`, 'deny' ],
	[ `${ S } -- "curl -o x.php http://e.com"`, 'deny' ],
	[ `${ S } -- "find . -name a -delete"`, 'deny' ],
	[ `${ S } -- "find . -name a"`, 'ask' ],
	[ `${ S } test`, 'pass' ],
	[ 'node - <<EOF\n' + `${ S } -- wp db drop\nEOF`, 'pass' ],
	[ `echo "${ S } -- sudo ls"`, 'pass' ],
	[ 'node ".claude/skills/project-ops/scripts/ssh-exec.mjs" -- wp plugin list', 'pass' ],
	[ 'node "D:/Other Project/.claude/skills/project-ops/scripts/ssh-exec.mjs" -- wp db drop --yes', 'deny' ],
	[ 'cd "D:/Other Project" && node "D:/Other Project/.claude/skills/project-ops/scripts/ssh-exec.mjs" --stage -- wp plugin install a --activate', 'ask' ],
] ) {
	check( `guard-wpcli ${ c.split( '\n' )[ 0 ].replace( S, 'SSH' ) }`, run( 'guard-wpcli.mjs', sh( c ) ), want );
}

// guard-wpcli: stage — без сервера автодамп не удаётся, поэтому меняющее остаётся ask (allow — только после дампа);
// db import и произвольный код — ask и на stage.
for ( const [ c, want ] of [
	[ `${ S } --stage -- wp option update blogname x`, 'ask' ],
	[ `${ S } --stage -- wp db import a.sql`, 'ask' ],
	[ `${ S } --stage -- wp eval "echo 1;"`, 'ask' ],
	[ `${ S } --stage -- wp db drop --yes`, 'deny' ],
	[ `${ S } --stage -- wp plugin list`, 'pass' ],
] ) {
	check( `guard-wpcli ${ c.replace( S, 'SSH' ) }`, run( 'guard-wpcli.mjs', sh( c ) ), want );
}

// guard-wpcli: локальный сайт (local-exec.mjs) разбирается так же, как сервер.
const L = 'node .claude/skills/project-ops/scripts/local-exec.mjs';
for ( const [ c, want ] of [
	[ `${ L } -- wp plugin list`, 'pass' ],
	[ `${ L } -- wp option update blogname x --yes`, 'ask' ],
	[ `${ L } -- wp db drop --yes`, 'deny' ],
	[ `${ L } -- wp search-replace a b --dry-run`, 'pass' ],
	[ `${ L } status`, 'pass' ],
] ) {
	check( `guard-wpcli ${ c.replace( L, 'LOCAL' ) }`, run( 'guard-wpcli.mjs', sh( c ) ), want );
}

// session-start: напоминание есть всегда (проект настроен — сверка, нет — project-init).
const ss = spawnSync( process.execPath, [ join( hooks, 'session-start.mjs' ) ], { input: JSON.stringify( { cwd: root } ), encoding: 'utf8', env, timeout: 30000 } );
check( 'session-start: напоминание project-init для ненастроенного проекта', /project-init/.test( ss.stdout ) ? 'pass' : 'fail', 'pass' );

// session-start: sessions/ и backups/edit/ старше 30 дней удаляются, свежие и backups/db/ — нет.
const st = join( root, '.claude', '.state' );
const old = new Date( Date.now() - 40 * 86400000 );
for ( const rel of [ 'sessions/old.json', 'sessions/new.json', 'backups/edit/old/a.php', 'backups/db/old.sql' ] ) {
	mkdirSync( join( st, rel, '..' ), { recursive: true } );
	writeFileSync( join( st, rel ), 'x' );
}
for ( const rel of [ 'sessions/old.json', 'backups/edit/old', 'backups/db/old.sql' ] ) {
	utimesSync( join( st, rel ), old, old );
}
spawnSync( process.execPath, [ join( hooks, 'session-start.mjs' ) ], { input: JSON.stringify( { cwd: root } ), encoding: 'utf8', env, timeout: 30000 } );
const pruned = ! existsSync( join( st, 'sessions/old.json' ) ) && ! existsSync( join( st, 'backups/edit/old' ) ) && existsSync( join( st, 'sessions/new.json' ) ) && existsSync( join( st, 'backups/db/old.sql' ) );
check( 'session-start: чистка sessions/ и backups/edit/ старше 30 дней, дампы не трогает', pruned ? 'pass' : 'fail', 'pass' );

rmSync( root, { recursive: true, force: true } );
console.log( `\n${ total - failed } из ${ total } прошли` );
process.exit( failed ? 1 : 0 );
