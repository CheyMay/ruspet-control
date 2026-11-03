import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
import type {Report} from '../shared/types.js';
import {reportText,publicOrigin} from './report-content.js';
import {reportLink} from '../shared/report-links.js';
import {reportKindLabels} from '../shared/report-parameters.js';
export async function reportPdf(report:Report):Promise<Buffer>{
 const doc=new PDFDocument({size:'A4',margin:42,info:{Title:'РУСПЭТ · '+(reportKindLabels[report.kind||'snapshot']||'Отчёт'),Author:'РУСПЭТ'}});
 doc.registerFont('Regular',fileURLToPath(new URL('./assets/DejaVuSans.ttf',import.meta.url)));doc.registerFont('Bold',fileURLToPath(new URL('./assets/DejaVuSans-Bold.ttf',import.meta.url)));doc.font('Regular');
 const chunks:Buffer[]=[];const result=new Promise<Buffer>((resolve,reject)=>{doc.on('data',b=>chunks.push(b));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject)});
 const content=reportText(report,false);doc.font('Bold').fontSize(18).text('РУСПЭТ · '+reportKindLabels[report.kind||'snapshot']);doc.moveDown();doc.font('Regular').fontSize(10);
 for(const line of content.text.split('\n').slice(1)){doc.text(line,{lineGap:3});}
 if(report.summary&&report.summary.team.length>0){doc.moveDown().font('Bold').fontSize(15).text('Все сотрудники');doc.moveDown().font('Regular').fontSize(10);for(const t of report.summary.team)doc.text(`${t.name}: фронт ${t.expected}, из него закрыто ${t.frontClosed}, осталось ${t.frontRemaining}; обработано ${t.processed}, закрыто ${t.closed}, сдано ${t.submitted}, переносов ${t.transfers}, просрочки ${t.overdue}; действовал лично: ${t.processedByActor}.`,{lineGap:6});}
 if(report.summary?.stateAvailable&&report.summary.trend.length){doc.moveDown().font('Bold').fontSize(13).text('Тенденция закрытия');doc.moveDown(.5).font('Regular').fontSize(9);for(const b of report.summary.trend)doc.text(`${b.label} — закрытий ${b.closed}, сдано ${b.submitted}, накопительно ${b.cumulativeClosed}`);}
 doc.moveDown();doc.fillColor('#285347').text('Открыть отчёт и перейти к задачам',{link:reportLink(publicOrigin(),report.id),underline:true});doc.fillColor('#333333').moveDown().fontSize(8).text(`Снимок: ${report.id}. Действия учитываются по журналу системы; подтверждение напоминания не считается обработкой задачи.`);
 doc.end();return result;
}
