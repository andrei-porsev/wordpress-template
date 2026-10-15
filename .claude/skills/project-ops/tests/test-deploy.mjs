/**
 * Проверка deploy на протоколе local: план, выкатка, тег, стоп-условия, откат всей пачки.
 * node .claude/skills/project-ops/tests/test-deploy.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'sftp-sync.mjs' );
const base = join( tmpdir(), 'wp-template-test-deploy' );
const proj = join( base, 'project' );
const remote = join( base, 'remote' );
rmSync( base, { recursive: true, force: true } );

const put = ( root, rel, text ) => {
	mkdirSync( dirname( join( root, rel ) ), { recursive: true } );
	writeFileSync( join( root, rel ), text );
};
const read = ( root, rel ) => ( existsSync( join( root, rel ) ) ? readFileSync( join( root, rel ), 'utf8' ) : null );
const sh = ( cmd, ...args ) => spawnSync( cmd, args, { cwd: proj, encoding: 'utf8' } );
const run = ( ...args ) => {
	const r = spawnSync( process.execPath, [ SCRIPT, ...args ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};
const commit = ( msg ) => {
	sh( 'git', 'add', '-A' );
	sh( 'git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg );
};

const T = 'wp-content/themes/demo/';
put( proj, '.vscode/sftp.json', JSON.stringify( {
	protocol: 'local',
	remotePath: remote.replace( /\\/g, '/' ),
	ignore: [ '/*', '!/wp-content', '/wp-content/*', '!/wp-content/themes', '/wp-content/themes/*', '!/wp-content/themes/demo' ],
} ) );
put( proj, '.gitignore', '.claude/\n' );
for ( const [ rel, text ] of [ [ 'a.php', '<?php // a v1\n' ], [ 'b.css', '.b{}\n' ], [ 'c.php', '<?php // c\n' ] ] ) {
	put( proj, T + rel, text );
	put( remote, T + rel, text );
}
sh( 'git', 'init', '-q' );
commit( 'baseline' );

// 1. Без тега — отказ.
let r = run( 'deploy' );
check( '1 без baseline / deploy-* — отказ', r.code === 1 && /Нет тега baseline/.test( r.out ), r.out );
sh( 'git', 'tag', 'baseline' );
run( 'compare' );

// 2. План: изменён a, добавлен new, удалён c.
put( proj, T + 'a.php', '<?php // a v2\n' );
put( proj, T + 'new.php', '<?php // new\n' );
rmSync( join( proj, T + 'c.php' ) );
r = run( 'deploy' );
check( '2 незакоммиченное — отказ', r.code === 1 && /Незакоммиченные/.test( r.out ), r.out );
commit( 'v2' );
r = run( 'deploy' );
check( '2 план без --yes', r.code === 0 && /ПЛАН/.test( r.out ) && /залить 2, удалить 1/.test( r.out ), r.out );
check( '2 сервер не тронут планом', read( remote, T + 'a.php' ).includes( 'v1' ) );

// 3. Выкатка.
r = run( 'deploy', '--yes' );
check( '3 выкатка прошла', r.code === 0 && /OK deploy: залито 2, удалено 1/.test( r.out ), r.out );
check( '3 a и new на сервере', read( remote, T + 'a.php' ).includes( 'v2' ) && read( remote, T + 'new.php' ) !== null );
check( '3 c удалён на сервере', read( remote, T + 'c.php' ) === null );
check( '3 тег deploy-*', /^deploy-/m.test( sh( 'git', 'tag', '--list', 'deploy-*' ).stdout ) );
r = run( 'deploy' );
check( '3 повторно — нечего выкатывать', /Нечего выкатывать/.test( r.out ), r.out );

// 4. Чужая правка на сервере — стоп.
put( remote, T + 'b.css', '.b{color:red} /* клиент */\n' );
put( proj, T + 'a.php', '<?php // a v3\n' );
commit( 'v3' );
r = run( 'deploy', '--yes' );
check( '4 чужая правка — отказ', r.code === 1 && /правки не из git/.test( r.out ) && /b\.css/.test( r.out ), r.out );
check( '4 a не залит', read( remote, T + 'a.php' ).includes( 'v2' ) );
put( remote, T + 'b.css', '.b{}\n' );

// 5. Синтаксическая ошибка PHP — стоп (если есть локальный php).
if ( spawnSync( 'php', [ '-v' ] ).status === 0 ) {
	put( proj, T + 'bad.php', '<?php echo "x" \n' );
	commit( 'bad' );
	r = run( 'deploy', '--yes' );
	check( '5 php -l — отказ, ничего не залито', r.code === 1 && /php -l/.test( r.out ) && read( remote, T + 'a.php' ).includes( 'v2' ), r.out );
	rmSync( join( proj, T + 'bad.php' ) );
	commit( 'fix bad' );
} else {
	console.log( 'SKIP 5 — локального php нет' );
}

// 6. Сбой посреди пачки — откат всей пачки.
mkdirSync( join( remote, T + 'z.php' ), { recursive: true } );
put( proj, T + 'z.php', '<?php // z\n' );
commit( 'z' );
r = run( 'deploy', '--yes' );
check( '6 сбой заливки — отказ с откатом', r.code === 1 && /откат всей пачки/.test( r.out ), r.out );
check( '6 a откачен к v2', read( remote, T + 'a.php' ).includes( 'v2' ), read( remote, T + 'a.php' ) );

console.log( fails ? `ПРОВАЛЕНО: ${ fails }` : 'Все проверки deploy прошли' );
process.exit( fails ? 1 : 0 );
