import {assert} from './domain.js';

export function checkWorkbookZip(data:Buffer){
 assert(data.length>22&&data.length<=3*1024*1024,400,'Выберите XLSX размером до 3 МБ.');
 const end=data.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));assert(end>=0&&end+22<=data.length,400,'Некорректный XLSX.');
 const count=data.readUInt16LE(end+10);let cursor=data.readUInt32LE(end+16),total=0;assert(count>0&&count<=1000,400,'Слишком сложный XLSX.');
 for(let i=0;i<count;i++){
  assert(cursor+46<=data.length&&data.readUInt32LE(cursor)===0x02014b50,400,'Некорректный архив XLSX.');
  const size=data.readUInt32LE(cursor+24);total+=size;assert(size<=8*1024*1024&&total<=24*1024*1024,400,'Слишком большой распакованный XLSX.');
  cursor+=46+data.readUInt16LE(cursor+28)+data.readUInt16LE(cursor+30)+data.readUInt16LE(cursor+32);
 }
}
