import { localDatabase } from './local-db.js';
const pg=await localDatabase();
const {migrate}=await import('./migrate.js');await migrate();
const {importSource}=await import('./import-source.js');await importSource();
const {createApp}=await import('../server/app.js');const {pool}=await import('../server/db.js');
const {startAutomation}=await import('../server/automation.js');const stopAutomation=startAutomation();
// External integrations intentionally disabled for the local MVP.
const {startPilot}=await import('../server/telegram-pilot.js');const stopTelegram=startPilot();
const host=process.env.HOST||'127.0.0.1';if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Demo server must bind to loopback.');
const port=Number(process.env.PORT||4310);const server=createApp().listen(port,host,()=>console.log(`РУСПЭТ готов: http://${host}:${port}`));
let stopping=false;async function stop(){if(stopping)return;stopping=true;stopAutomation();stopTelegram();server.close();await pool.end();await pg?.stop();process.exit(0);}process.on('SIGINT',stop);process.on('SIGTERM',stop);
