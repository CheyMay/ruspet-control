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
export async function transaction<T>(run: (db: Db) => Promise<T>): Promise<T> {
  const active=scope.getStore();if(active)return run(active);
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await scope.run(client,()=>run(client)); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
