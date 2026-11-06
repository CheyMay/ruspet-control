import {pool} from '../server/db.js';

// Read-only diagnostic: no Bot API calls, polling, messages or credential output.
try{
 const runtime=await pool.query(`SELECT s.enabled AS bot_enabled,r.username AS bot_username,
  r.last_poll_at,r.heartbeat_at,r.error,
  round(extract(epoch FROM now()-r.last_poll_at))::int AS seconds_since_poll
  FROM telegram_settings s LEFT JOIN telegram_runtime r ON r.id=s.id WHERE s.id=1`);
 console.table(runtime.rows);
 const locks=await pool.query(`SELECT count(*)::int n FROM pg_locks
  WHERE locktype='advisory' AND classid=0 AND objid=431009 AND granted
  AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`);
 console.log('Активных polling-lock в этой БД:',locks.rows[0].n);
 console.log('Polling панели отключён:',process.env.TELEGRAM_WORKER_DISABLED==='true');
}catch{
 console.error('Не удалось прочитать состояние Telegram из БД. Проверьте окружение приложения.');process.exitCode=1;
}finally{await pool.end();}
