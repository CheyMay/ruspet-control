import {createHash} from 'node:crypto';
import type {Request,Response} from 'express';
import {z} from 'zod';
import {transaction} from './db.js';
import {assert} from './domain.js';

export async function taskWrite<T>(req:Request,res:Response,status:number,run:()=>Promise<T>){
 const key=req.get('Idempotency-Key');
 if(key===undefined)return res.status(status).json(await run());
 const requestId=z.uuid().parse(key);
 const actor=req.actor.id;
 const fingerprint=createHash('sha256').update(JSON.stringify([req.method,req.path,req.body])).digest('hex');
 const result=await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['task-write:'+actor+':'+requestId]);
  const receipt=(await db.query<{fingerprint:string;result:T}>(
   'SELECT fingerprint,result FROM task_write_receipts WHERE actor_id=$1 AND request_id=$2',[actor,requestId]
  )).rows[0];
  if(receipt){
   assert(receipt.fingerprint===fingerprint,409,'Этот ключ уже использован для другого действия.');
   return receipt.result;
  }
  const result=await run();
  await db.query('INSERT INTO task_write_receipts(actor_id,request_id,fingerprint,result) VALUES($1,$2,$3,$4)',
   [actor,requestId,fingerprint,JSON.stringify(result)]);
  return result;
 });
 return res.status(status).json(result);
}
