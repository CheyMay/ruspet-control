import {startWorkDesign} from './work-design.js';
import {closeOkb} from './okb.js';
import {startPilot} from './telegram-pilot.js';
import { createApp } from './app.js';
import { pool } from './db.js';
import {startAutomation} from './automation.js';

const host=process.env.HOST||'127.0.0.1';
if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('MVP uses demo login; bind to loopback only. Production authentication is not implemented.');
const server=createApp().listen(Number(process.env.PORT||4310),host,()=>console.log(`РУСПЭТ: http://${host}:${process.env.PORT||4310}`));
const stopAutomation=startAutomation(),stopTelegram=startPilot(),stopWorkDesign=startWorkDesign();
async function stop(){stopAutomation();stopTelegram();stopWorkDesign();server.close();await closeOkb();await pool.end();process.exit(0);}process.on('SIGINT',stop);process.on('SIGTERM',stop);
