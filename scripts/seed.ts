import { randomUUID } from 'node:crypto';
import { pool, transaction } from '../server/db.js';
import { defaultRules } from '../server/domain.js';
import { runChecks, requestApproval, event } from '../server/service.js';
import type { User } from '../shared/types.js';
export const demoUsers:User[]=[
 {id:'director',name:'Александр Воронов',role:'director',branch_id:'Москва',position:'Генеральный директор'},
 {id:'admin',name:'Дарья Белова',role:'admin',branch_id:'Москва',position:'Администратор системы'},
 {id:'head',name:'Наталья Соколова',role:'sales_head',branch_id:'Москва',position:'Руководитель продаж'},
 {id:'lead-msk',name:'Михаил Орлов',role:'branch_manager',branch_id:'Москва',position:'Руководитель филиала'},
 {id:'lead-kzn',name:'Елена Морозова',role:'branch_manager',branch_id:'Казань',position:'Руководитель филиала'},
 {id:'anna',name:'Анна Лебедева',role:'employee',branch_id:'Москва',position:'Менеджер по работе с клиентами'},
 {id:'ivan',name:'Иван Миронов',role:'employee',branch_id:'Москва',position:'Менеджер по работе с клиентами'},
 {id:'olga',name:'Ольга Крылова',role:'employee',branch_id:'Казань',position:'Менеджер по работе с клиентами'},
 {id:'denis',name:'Денис Волков',role:'employee',branch_id:'Казань',position:'Менеджер по работе с клиентами'}];
const titles=['Согласовать спецификацию для «Волна Пак»','Подготовить договор поставки для «Ладога»','Подтвердить график отгрузок на ноябрь','Рассчитать доставку партии для «Исток»','Получить чертёж горловины от клиента','Передать образцы преформ на испытания','Сверить дебиторскую задолженность','Подготовить предложение для «Аква Лайн»','Уточнить объём месячной потребности','Закрыть рекламацию по упаковке','Обновить прогноз закупок клиента','Согласовать резерв на складе','Отправить паспорт качества на партию','Проверить подписанные приложения','Подготовить план встреч с клиентами','Подтвердить получение тестовой партии','Сверить условия повторного заказа','Получить итоговый протокол испытаний','Подготовить расчёт новой спецификации','Проверить готовность к отгрузке','Согласовать цвет опытной партии','Завершить сверку с «Берегом»','Передать документы в бухгалтерию','Подвести итоги пилотной поставки'];
export async function seed() {
 const inserted=await transaction(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(431004)');if((await db.query('SELECT 1 FROM users LIMIT 1')).rowCount)return false;
  for(const u of demoUsers)await db.query('INSERT INTO users(id,name,role,branch_id,position) VALUES($1,$2,$3,$4,$5)',[u.id,u.name,u.role,u.branch_id,u.position]);
  await db.query('INSERT INTO rule_versions(config,author_id) VALUES($1,$2)',[JSON.stringify(defaultRules),'admin']);
  const now=new Date(), dayStart=new Date(new Date(now.getTime()+3*3600000).toISOString().slice(0,10)+'T18:00:00+03:00');
  for(let i=0;i<titles.length;i++) {
   const owner=demoUsers[5+i%4], id=String(2401+i),deadline=i===8?null:new Date(dayStart.getTime()+(i<6?-(i%3+1):i<12?0:i<18?i%3+1:-1)*86400000).toISOString();
   const status=i>=20?'completed':i===13||i===17?'review':'active';
   const task=(await db.query('INSERT INTO tasks(id,title,description,branch_id,assignee_id,creator_id,deadline,original_deadline,planned_end,status,priority,code,important,customer_risk,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *',[id,titles[i],`Демонстрационная задача. Согласовать условия, зафиксировать договорённости и передать результат ответственному сотруднику. Клиент и все участники вымышлены.`,owner.branch_id,owner.id,'head',deadline,i===12?new Date(now.getTime()-86400000).toISOString():deadline,status,i<3?'high':'normal',i===9?'?':'РПМ*',i===10?null:i<3,false,new Date(now.getTime()-(9+i%5)*86400000),status==='completed'?new Date(now.getTime()-i%3*86400000):null])).rows[0];
   await db.query('INSERT INTO mock_provider_tasks(id,snapshot,revision) VALUES($1,$2,1)',[id,JSON.stringify(task)]);
   await event(db,id,'head','created','Задача получена из тестового источника',{source:'mock',version:1});
   if(i<6)await db.query('INSERT INTO comments(id,task_id,author_id,body) VALUES($1,$2,$3,$4)',[randomUUID(),id,owner.id,i%2?'Уточняю доступное окно отгрузки. Ответ логистики ожидаю сегодня.':'Клиент прислал замечания к спецификации. Исправления переданы технологу.']);
  }return true;
 });
 if(inserted) {
  await runChecks(demoUsers[0]);
  for(const id of ['2401','2402','2403']) {const task=(await pool.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];await requestApproval(demoUsers.find(u=>u.id===task.assignee_id)!,id,{type:'deadline',reason:'Клиент уточнил технические требования к партии. Требуется повторная проверка спецификации.',plan:'Получить заключение технолога, согласовать исправления и отправить документы клиенту.',proposedDeadline:new Date(Date.now()+3*86400000).toISOString(),expectedVersion:1});}
  console.log('Seed: 24 fictional tasks, 9 users, 3 approval routes.');
 }
}
if(process.argv[1]?.endsWith('seed.ts')){await seed();await pool.end();}
