import {migrateOkb,closeOkb} from '../server/okb.js';
try{await migrateOkb();console.log('Схема ОКБ готова.');}
catch{console.error('Не удалось подготовить ОКБ. Проверьте отдельную БД и её права.');process.exitCode=1;}
finally{await closeOkb();}
