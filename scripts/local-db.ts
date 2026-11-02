import 'dotenv/config';
import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
export async function localDatabase() {
 if(process.env.DATABASE_URL)return null;
 await mkdir('.local',{recursive:true});let credentials:{password:string;url:string};
 try {credentials=JSON.parse(await readFile('.local/connection.json','utf8'));} catch { const password=randomBytes(24).toString('hex');credentials={password,url:`postgresql://ruspet:${password}@127.0.0.1:55439/postgres`};await writeFile('.local/connection.json',JSON.stringify(credentials),{mode:0o600}); }
 const pg=new EmbeddedPostgres({databaseDir:resolve('.local/postgres'),user:'ruspet',password:credentials.password,port:55439,persistent:true,authMethod:'scram-sha-256',initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1','-c','max_parallel_workers=0','-c','max_worker_processes=2','-c','shared_buffers=32MB'],onLog:()=>{},onError:(msg:unknown)=>{if(String(msg).includes('FATAL'))console.error(String(msg));}});
 try{await access('.local/postgres/PG_VERSION');}catch{await pg.initialise();}
 await pg.start(); process.env.DATABASE_URL=credentials.url;return pg;
}
if(process.argv[1]?.endsWith('local-db.ts')) {const pg=await localDatabase();console.log('Local PostgreSQL ready at 127.0.0.1:55439');const stop=async()=>{await pg?.stop();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);setInterval(()=>{},60000);}
