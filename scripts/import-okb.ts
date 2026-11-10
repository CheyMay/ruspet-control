import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {AppError,assert} from '../server/domain.js';
import {closeOkb} from '../server/okb.js';
import {importOkbExport} from '../server/okb-import.js';

try{
 const {positionals,values}=parseArgs({allowPositionals:true,options:{apply:{type:'boolean'},sha256:{type:'string'}}});
 assert(positionals.length===1,400,'Укажите путь к XLSX. Запись требует --apply --sha256 SHA из предварительной проверки.');
 const [path]=positionals;
 const info=await stat(path);
 assert(info.isFile()&&info.size<=3*1024*1024,400,'Ожидался файл XLSX до 3 МБ.');
 const data=await readFile(path),sha256=createHash('sha256').update(data).digest('hex');
 assert(!values.apply||values.sha256===sha256,409,'Файл отличается от предварительно проверенной выгрузки.');
 console.log(JSON.stringify({sha256,...await importOkbExport(data,!!values.apply)}));
}catch(error){
 console.error(error instanceof AppError?error.message:'Импорт ОКБ не выполнен. Проверьте файл, схему и доступ к отдельной базе.');
 process.exitCode=1;
}finally{await closeOkb();}
