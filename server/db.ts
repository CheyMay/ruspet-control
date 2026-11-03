import {AsyncLocalStorage} from 'node:async_hooks';
import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
pg.types.setTypeParser(1184, value => new Date(value).toISOString());
pg.types.setTypeParser(1082, value => value);
export const connectionString = process.env.DATABASE_URL || (existsSync('.local/connection.json') ? JSON.parse(readFileSync('.local/connection.json','utf8')).url : 'postgresql://localhost:5432/ruspet');
export const pool = new pg.Pool({ connectionString, max: 4 });
export type Db = Pick<pg.PoolClient, 'query'>;
const scope=new AsyncLocalStorage<Db>();
export const transactionActive=()=>!!scope.getStore();
export async function transaction<T>(run: (db: Db) => Promise<T>): Promise<T> {
  const active=scope.getStore();if(active)return run(active);
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await scope.run(client,()=>run(client)); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Acquire the report request lock before the snapshot, using one pooled connection. */
export async function reportTransaction<T>(key:string,run:(db:Db)=>Promise<T>):Promise<T>{
 const current=scope.getStore();if(current){await current.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',[key]);return run(current);}
 const client=await pool.connect();let locked=false;
 try{
  await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)',[key]);locked=true;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const result=await scope.run(client,()=>run(client));await client.query('COMMIT');return result;
 }catch(e){await client.query('ROLLBACK');throw e;}finally{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)',[key]);client.release();}
}
