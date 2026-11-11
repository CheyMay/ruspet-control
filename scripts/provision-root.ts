import {readFileSync} from 'node:fs';
import {pool,transaction} from '../server/db.js';
import {hashPassword,verifyPassword} from '../server/passwords.js';

const id='owner-root';
try{
 const password=readFileSync(0,'utf8').trim();
 if(!/^[A-Za-z0-9_-]{24,80}$/.test(password))throw new Error('Pass a generated root password on stdin.');
 const created=await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431026)');
  const owner=(await db.query(`SELECT u.id,a.password_hash,a.enabled,a.password_login FROM users u
   LEFT JOIN login_accounts a ON a.user_id=u.id AND a.username='root' WHERE u.root_access`)).rows[0];
  if(owner){
   if(owner.id===id&&owner.enabled&&owner.password_login&&await verifyPassword(password,owner.password_hash))return false;
   throw new Error('An owner already exists. Existing credentials were preserved.');
  }
  const occupied=await db.query("SELECT 1 FROM users WHERE id=$1 UNION ALL SELECT 1 FROM login_accounts WHERE username='root'",[id]);
  if(occupied.rowCount)throw new Error('The owner ID or root login is already in use.');
  await db.query("INSERT INTO users(id,name,role,branch_id,position,root_access) VALUES($1,'Владелец','admin','','Владелец системы',true)",[id]);
  await db.query("INSERT INTO login_accounts(username,user_id,password_hash) VALUES('root',$1,$2)",[id,await hashPassword(password)]);
  return true;
 });
 console.log(created?'Root account created.':'Root account already configured.');
}catch(error){
 console.error(error instanceof Error&&error.constructor===Error?error.message:'Could not provision root.');
 process.exitCode=1;
}finally{
 await pool.end();
}
