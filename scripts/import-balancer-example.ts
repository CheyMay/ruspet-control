import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {parseBalancerExample,saveBalancerFiles} from '../server/balancer-config.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{apply:{type:'boolean',default:false}}});
try{
 if(positionals.length!==1)throw Error('source');
 const settings=parseBalancerExample(await readFile(positionals[0],'utf8'));
 const files=await saveBalancerFiles('/opt/ruspet/.secrets',settings,values.apply);
 console.log(JSON.stringify({portalMatches:true,balancerHttps:true,applied:values.apply,files},null,2));
 console.log('Значения ключей и URL не выводятся. Транспорт не включён автоматически.');
}catch{console.error('Импорт не подтверждён. Проверьте четыре строковые константы, портал, каталог .secrets с правами 700 и отсутствие других настроек в выходных файлах. Исходник не исполнялся; существующие файлы не перезаписываются.');process.exitCode=1;}
