import {AppError} from './domain.js';

export type TelegramMethod='getMe'|'getWebhookInfo'|'getUpdates'|'sendMessage'|'editMessageText'|'answerCallbackQuery'|'sendDocument';
const reasons:[RegExp,string][]=[
 [/button_url_invalid|button url|wrong http url|url host is empty/i,'Некорректная ссылка в кнопке. Проверьте PUBLIC_ORIGIN.'],
 [/button_data_invalid|callback data|callback_data/i,'Некорректные данные кнопки.'],
 [/can't parse inline keyboard|inline keyboard expected|button_type_invalid/i,'Некорректная клавиатура сообщения.'],
 [/can't parse entities|can't find end of the entity|unsupported start tag|entity bounds/i,'Ошибка разметки сообщения.'],
 [/message is too long|message_too_long/i,'Текст сообщения превышает лимит Telegram.'],
 [/message text is empty|message must be non-empty/i,'Пустой текст сообщения.'],
 [/chat not found|peer_id_invalid/i,'Telegram не находит личный чат. Сотруднику нужно открыть бота и нажать «Старт».'],
 [/bot was blocked|user is deactivated|bot can't initiate conversation/i,'Получатель заблокировал бота, удалил аккаунт или ещё не открыл чат.'],
 [/query is too old|query id is invalid|response timeout expired/i,'Кнопка устарела. Откройте её заново.'],
 [/message is not modified/i,'Сообщение уже содержит этот текст.'],
 [/message to edit not found|message can't be edited/i,'Исходное сообщение недоступно для изменения.'],
 [/wrong file identifier|file_id_invalid|failed to get http url content|file must be non-empty/i,'Telegram отклонил вложение.'],
 [/webhook.*(active|set)|can't use getupdates.*webhook/i,'Включён webhook. Polling одновременно с webhook не работает.'],
 [/offset.*(invalid|integer)|timeout.*(invalid|integer)|allowed_updates.*(invalid|json)/i,'Некорректные параметры опроса Telegram.']
];

/** Never expose Telegram's raw description: it can echo message text, links or credentials. */
export class TelegramRejected extends AppError {
 readonly method:TelegramMethod;
 readonly telegramCode:number;
 constructor(method:TelegramMethod,data:{error_code?:unknown;description?:unknown},httpStatus=502){
  const code=typeof data.error_code==='number'&&Number.isInteger(data.error_code)&&data.error_code>=400&&data.error_code<=599?data.error_code:
   Number.isInteger(httpStatus)&&httpStatus>=400&&httpStatus<=599?httpStatus:502;
  const description=typeof data.description==='string'?data.description.slice(0,4096):'';
  const known=reasons.find(([pattern])=>pattern.test(description))?.[1];
  const reason=code===401?'Telegram отклонил токен бота.':code===409?'Конфликт: другой polling-процесс или webhook.':code===429?'Telegram ограничил частоту запросов.':known||'Запрос отклонён. Нужна проверка параметров этого метода.';
  super(502,`Telegram · ${method} · ${code}: ${reason}`);
  this.method=method;this.telegramCode=code;
 }
}
