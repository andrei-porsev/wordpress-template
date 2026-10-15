/**
 * Личная папка ~/.wp-template/ (вне проектов): machine.json — итог проверки машины, servers.json — профили своих серверов.
 * Агент её не читает и не правит своими инструментами — только скрипты. WP_TEMPLATE_HOME — другая папка (тесты).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function homeDir() {
	return process.env.WP_TEMPLATE_HOME || join( homedir(), '.wp-template' );
}

export function readHome( name ) {
	const path = join( homeDir(), name );
	if ( ! existsSync( path ) ) {
		return null;
	}
	return JSON.parse( readFileSync( path, 'utf8' ) );
}

export function writeHome( name, data ) {
	mkdirSync( homeDir(), { recursive: true } );
	writeFileSync( join( homeDir(), name ), JSON.stringify( data, null, '\t' ) + '\n' );
}
