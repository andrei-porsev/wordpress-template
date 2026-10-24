/**
 * Проверка gen-whitelist: слаги → .gitignore и sftp.json; вёрстка макета (markup) — в git и sftp-stage.json, но не в sftp.json прода.
 * node .claude/skills/project-ops/tests/test-gen-whitelist.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'scripts', 'gen-whitelist.mjs' );
const proj = join( tmpdir(), 'wp-template-test-gen-whitelist' );
rmSync( proj, { recursive: true, force: true } );
mkdirSync( join( proj, '.vscode' ), { recursive: true } );
mkdirSync( join( proj, 'project-base' ), { recursive: true } );

const json = ( p ) => JSON.parse( readFileSync( p, 'utf8' ) );
const write = ( p, d ) => writeFileSync( p, typeof d === 'string' ? d : JSON.stringify( d ) );
const run = () => {
	const r = spawnSync( process.execPath, [ SCRIPT ], { cwd: proj, encoding: 'utf8' } );
	return { code: r.status, out: ( r.stdout + r.stderr ).trim() };
};
let fails = 0;
const check = ( name, ok, detail = '' ) => {
	console.log( `${ ok ? 'OK  ' : 'FAIL' } ${ name }${ ok ? '' : ' — ' + detail }` );
	fails += ok ? 0 : 1;
};

const gitignore = '/*\n!/.gitignore\n# >>> project.json (генерируется, не править вручную)\n# <<< project.json\n';
const project = ( extra = {} ) => write( join( proj, 'project-base', 'project.json' ), { stem: 'acme', themes: [ 'acme' ], plugins: [], muPlugins: [], blocks: [], scss: [], ...extra } );
write( join( proj, '.gitignore' ), gitignore );
write( join( proj, '.vscode', 'sftp.json' ), { host: 'prod.example', ignore: [] } );
write( join( proj, '.vscode', 'sftp-stage.json' ), { host: 'stage.example', ignore: [] } );
write( join( proj, '.vscode', 'settings.json' ), '{\n\t"liveSassCompile.settings.includeItems": []\n}\n' );

project();
let r = run();
check( 'без markup — запуск', r.code === 0, r.out );
check( 'без markup — в .gitignore нет markup/', ! readFileSync( join( proj, '.gitignore' ), 'utf8' ).includes( '/markup/' ) );
check( 'без markup — в sftp-stage.json нет markup', ! json( join( proj, '.vscode', 'sftp-stage.json' ) ).ignore.includes( '!/markup' ) );

project( { markup: true, scss: [ '/wp-content/themes/acme/assets/scss/*.scss', '/markup/assets/scss/*.scss' ] } );
r = run();
check( 'markup — запуск, entry SCSS в /markup/ принят', r.code === 0, r.out );
check( 'markup — в .gitignore', readFileSync( join( proj, '.gitignore' ), 'utf8' ).includes( '!/markup/**' ) );
const prod = json( join( proj, '.vscode', 'sftp.json' ) ).ignore;
const stage = json( join( proj, '.vscode', 'sftp-stage.json' ) ).ignore;
check( 'markup — в sftp.json прода нет (deploy не выкатит)', ! prod.some( ( l ) => l.includes( 'markup' ) ), JSON.stringify( prod ) );
check( 'markup — в sftp-stage.json открыт после /*', stage[ 0 ] === '/*' && stage.includes( '!/markup' ) && stage.includes( '!/markup/**' ), JSON.stringify( stage ) );
check( 'markup — includeItems с entry вёрстки', readFileSync( join( proj, '.vscode', 'settings.json' ), 'utf8' ).includes( '/markup/assets/scss/*.scss' ) );

project( { scss: [ '/markup/assets/scss/*.scss' ] } );
r = run();
check( 'entry в /markup/ без "markup": true — отказ', r.code === 1 && /markup/.test( r.out ), r.out );

rmSync( proj, { recursive: true, force: true } );
console.log( fails ? `\nПровалено: ${ fails }` : '\nВсе проверки gen-whitelist прошли' );
process.exit( fails ? 1 : 0 );
