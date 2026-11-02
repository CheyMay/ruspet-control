import pg from 'pg';
import {readFile,writeFile} from 'node:fs/promises';
// One-time switch to a separate database; the initial fictional database is retained.
const credentials=JSON.parse(await readFile('.local/connection.json','utf8'));
const connection=new pg.Client({connectionString:credentials.url});await connection.connect();
if(!(await connection.query("SELECT 1 FROM pg_database WHERE datname='ruspet_source'")).rowCount)await connection.query('CREATE DATABASE ruspet_source');
await connection.end();const url=new URL(credentials.url);url.pathname='/ruspet_source';credentials.url=url.toString();await writeFile('.local/connection.json',JSON.stringify(credentials),{mode:0o600});console.log('Local connection switched to ruspet_source; the initial demo database is preserved.');
