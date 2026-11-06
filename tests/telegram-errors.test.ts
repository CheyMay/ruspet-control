import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramRejected} from '../server/telegram-errors.js';

test('Telegram diagnostics identify method and distinguish bad requests, polling conflict and invalid tokens',()=>{
 assert.match(new TelegramRejected('sendMessage',{error_code:400,description:'Bad Request: BUTTON_URL_INVALID'}).message,/sendMessage · 400:.*PUBLIC_ORIGIN/);
 assert.match(new TelegramRejected('sendMessage',{error_code:400,description:"Bad Request: can't parse entities: Unsupported start tag"}).message,/разметки/);
 assert.match(new TelegramRejected('getUpdates',{error_code:409,description:'Conflict'}).message,/getUpdates · 409:.*polling/);
 assert.match(new TelegramRejected('getMe',{error_code:401}).message,/getMe · 401:.*токен/);
 assert.match(new TelegramRejected('sendDocument',{error_code:400,description:'Bad Request: file must be non-empty'}).message,/вложение/);
 assert.match(new TelegramRejected('sendMessage',{error_code:429}).message,/частоту/);
 assert.match(new TelegramRejected('answerCallbackQuery',{error_code:400,description:'query is too old and response timeout expired'}).message,/Кнопка устарела/);
});

test('raw upstream descriptions and malformed codes never leak messages, links or secrets to diagnostics',()=>{
 const secret='FICTIONAL_CREDENTIAL',description=`Unexpected https://private.example/${secret} private message text`;
 for(const error of [new TelegramRejected('sendMessage',{error_code:400,description}),new TelegramRejected('getUpdates',{error_code:description,description}),new TelegramRejected('getMe',{error_code:NaN,description:{}},Infinity)]){
  assert(!error.message.includes(secret));assert(!error.message.includes('private message'));assert(!error.message.includes('https://'));
  assert(Number.isInteger(error.telegramCode));assert(error.message.length<200);
 }
 const known=new TelegramRejected('sendMessage',{error_code:400,description:`Bad Request: can't parse entities in ${secret}`});assert(!known.message.includes(secret));assert.match(known.message,/разметки/);
});
