import {randomUUID} from 'node:crypto';
import {pool} from '../server/db.js';
import {botView} from '../server/bot.js';
import {getReport,listReports,visibleTasks} from '../server/service.js';
import {reportPdf} from '../server/report-pdf.js';
import type {User} from '../shared/types.js';

const channel='benchmark:'+randomUUID();
async function median(run:()=>Promise<unknown>){
 const times:number[]=[];
 for(let i=0;i<8;i++){
  const start=performance.now();await run();
  if(i)times.push(performance.now()-start);
 }
 return Math.round(times.sort((a,b)=>a-b)[3]*10)/10;
}
try{
 const user=(await pool.query<User>("SELECT * FROM users WHERE role='admin' ORDER BY id LIMIT 1")).rows[0];
 if(!user)throw new Error('Administrator required');
 const task=(await visibleTasks(user))[0],report=(await listReports(user,{page:0})).items[0];
 console.log(JSON.stringify({samplesPerScenario:7,menuMs:await median(()=>botView(user,channel)),
  taskMs:task?await median(()=>botView(user,channel,{op:'task',id:task.id})):null,
  pdfMs:report?await median(async()=>reportPdf(await getReport(user,report.id))):null}));
}finally{
 try{await pool.query('DELETE FROM bot_buttons WHERE channel=$1',[channel]);}finally{await pool.end();}
}
