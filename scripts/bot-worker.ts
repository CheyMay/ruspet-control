import {pool} from '../server/db.js';
import {startPilot} from '../server/telegram-pilot.js';
await pool.query('SELECT 1');
const stop=startPilot();
console.log('Personal Telegram worker started');
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;stop();await pool.end();process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
