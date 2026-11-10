import {createApp} from '../server/app.js';
import {pool} from '../server/db.js';
// HTTP only: no polling, schedules, automation or external-sync workers.
const target=(await pool.query('SELECT current_database() AS db,current_user AS role')).rows[0];
if(target.db!=='ruspet_manager_preview'||target.role!=='ruspetpreview'||process.env.DEMO_AUTH!=='false'||process.env.TELEGRAM_WORKER_DISABLED!=='true'||process.env.TASK_PROVIDER!=='mock'||process.env.BITRIX_WRITE_ENABLED!=='false'){
 await pool.end();throw Error('Isolated manager preview configuration required');
}
const server=createApp({managerPreview:true}).listen(4320,'127.0.0.1',()=>console.log('Manager preview listening on loopback port 4320'));
async function stop(){server.close();await pool.end();process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
