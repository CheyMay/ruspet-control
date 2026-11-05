# Проверка документации Битрикс24 для РУСПЭТ

Проверка 5 ноября 2026. Источник — официальный публичный репозиторий `bitrix-tools/b24-rest-docs`, commit `d70113767dff358a655cbfb29dc572ec654cb7ed`. Актуальные файлы получены в отдельный временный checkout; код примеров не выполнялся, к рабочему порталу обращений не было.

Весь справочник проиндексирован по структуре: **41 верхний раздел API, 2815 Markdown-страниц** (включая обзоры и события, это не количество методов). Углублённая проверка ограничена подтверждённым пользователем составом: задачи и связанные данные CRM, пользователи/структура, проекты, файлы, авторизация, события, лимиты. Это не заявление о построчном прочтении всех материалов про магазин, телефонию и остальные неиспользуемые продукты.

## Проверенные контракты и решения

| Тема | Официальный источник на проверенной версии | Вывод для реализации |
|---|---|---|
| Интенсивность, ресурсоёмкость, 60 секунд | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/limits.md) | Устойчивые 2/5 HTTP-запросов в секунду зависят от тарифа; общий IP учитывается. operating — отдельный бюджет метода. Не обещать нулевые 429/503. |
| Большие выборки | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/settings/performance/huge-data.md) | ID-курсор и start=-1 применимы только к поддерживающим это методам. Не переносить приём на IM/таймлайн/сложный ключ адреса. |
| Пакетные вызовы | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/settings/how-to-call-rest-api/batch.md) | До 50 команд; batch не отменяет ресурсоёмкость. В первом проходе безопаснее последовательная очередь. |
| Метаданные задач | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/tasks-task-get-fields.md) | Получать каталог, явно выбирать UF. Поля и доступы не угадывать по старой выгрузке. |
| Список задач | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/tasks-task-list.md) | Нет фильтра по текущему дню/статусу/двум менеджерам для полного архива. Размер страницы и стабильный ID. |
| Полная карточка | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/tasks-task-get.md) | Отдельный get по каждому найденному ID; RELATED_TASKS и CHAT_ID имеют специальный смысл. |
| История | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/tasks-task-history-list.md) | Хранить полный list как источник, не изобретать ID и не подменять историю событиями нашего приложения. |
| Результаты | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/result/tasks-task-result-list.md) | Классический list без пагинации; WITH_FILE_INFO/WITH_USER_INFO. Нулевой commentId допустим в новой карточке. |
| REST 3.0 | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/rest-v3.md) | Другой URL и контракты, не автоматическая замена всех методов на /api/. |
| Новая карточка задач | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/tasks-new.md) | Добавление комментария даёт MESSAGE_ID/TASK_ID/ID=0; update/delete старых комментариев не работают. |
| Чаты | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/chats/messages/im-dialog-messages-get.md) | Только участник чата; LAST_ID/FIRST_ID, LIMIT до 50, возможно больше непрочитанных; сохранять users/files. |
| Учёт времени | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/elapsed-item/task-elapsed-item-get-list.md) | Позиционные параметры; NAV_PARAMS, размер страницы до 50. |
| Чек-лист | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/tasks/checklist-item/task-checklist-item-get-list.md) | Соблюдать порядок параметров; не путать вложенные чек-листы с фильтром названия задачи. |
| Компании и поля | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/crm/companies/crm-company-list.md) | * не покрывает все UF/множественные поля. Описания fields и явные имена доступны через REST. |
| Связи контактов | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/crm/companies/contacts/crm-company-contact-items-get.md) | Контакты компании — отдельная коллекция, не только primary ID; аналогично сделкам и лидам. |
| Таймлайн | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/crm/timeline/comments/crm-timeline-comment-list.md) | Фильтры ENTITY_TYPE+ENTITY_ID обязательны, >ID игнорируется. Использовать start/next, не придумывать keyset. |
| Смарт-процессы | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/crm/universal/crm-item-list.md) | select допускает только имена либо *, а не UF_*. useOriginalUfNames=Y фиксирует исходные имена. |
| Пользователи | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/user/user-get.md) | FILTER.ID для конкретного пользователя; select и ADMIN_MODE. При недостаточном scope поля могут быть пропущены. |
| Проекты | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/sonet-group/sonet-group-get.md) | IS_ADMIN=Y действует только администратору; состав читается отдельным sonet_group.user.get. |
| Привязки файлов | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/disk/attached-object/disk-attached-object-get.md) | ID связи не равен ID Disk. Получить OBJECT_ID и метаданные, не гадать по одинаковому числу. |
| Файл | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/disk/file/disk-file-get.md) | Получать подтверждённый DOWNLOAD_URL; проверять размер/хост. Токены URL не выводить. |
| Обзор событий | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/index.md) | Онлайн-доставка не повторяется после сбоя; быстрый обработчик сохраняет событие и возвращает ответ. |
| Регистрация событий | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/event-bind.md) | Только контекст приложения; входящий вебхук даёт WRONG_AUTH_TYPE. Проверять event.get перед повторной регистрацией. |
| Офлайн-очередь | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/offline-events.md) | Это coalesced изменения объектов, не полный журнал; не строить историю закрытий только по ней. |
| Резервирование | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/event-offline-get.md) | Только clear=0, проверить rest_offline_extended. Нельзя удалять до постоянной локальной записи. |
| Подтверждение | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/event-offline-clear.md) | Пустой process_id опасен; непустой process_id и конкретные message_id. Не очищать чужую очередь приложения. |
| Восстановление пакетов | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/event-offline-list.md) | Недеструктивное чтение PROCESS_ID для восстановления после сбоя между ответом и записью. |
| Защита приёмника | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/api-reference/events/safe-event-handlers.md) | Проверять application_token и портал, не доверять присланным endpoint URL, не сохранять auth. |
| Продление OAuth | [Документация](https://github.com/bitrix-tools/b24-rest-docs/blob/d70113767dff358a655cbfb29dc572ec654cb7ed/settings/oauth/auto-renewal.md) | Access — час, refresh — 180 дней; сохранять новую пару атомарно, не повторять неизвестную ротацию вслепую. |

Проверены также контракты contact/deal/lead list/get/fields, их контактных привязок и товарных строк; requisite/bankdetail/address list/fields, department.get, user.admin, crm.type.list/crm.item.fields, task/user/project/CRM события. Код загрузчика содержит только документированные методы; изменение чужих прав/состава чатов для расширения чтения не выполняется.

## Что подтвердить на реальном портале

1. Кто устанавливает отдельное приложение, его реальные scope и тарифная возможность `rest_offline_extended`.
2. Доступ к обсуждениям выбранных задач: admin задач и членство в IM — разные проверки.
3. Совместимость методов/структуры ответа с версией портала и балансировщиком, поддержка REST 3.0 и отсутствие небезопасных внутренних повторов POST шлюза.
4. Реальные ID двух менеджеров и руководителей, проект пилота и код обязательной цены; совпадение фамилии не считается подтверждением ID.
5. Масштаб, файлы/размеры/хосты, нестандартные типы UF, неизвестные файловые привязки и доступные старые комментарии/история.
6. Разделы без надёжных событий (включая изменения/удаления сообщений новой карточки): частота адресной сверки и приемлемая задержка. Удалённые до подключения данные не восстанавливаются из отсутствующих источников.

Полный архив и рабочая проекция — разные операции. Результат чтения должен сначала пройти контроль полноты и сопоставлений, затем включаться в рабочую систему. Реальные данные из Excel в этот отчёт не перенесены, кроме двух прямо согласованных участников в инструкции пилота.

## Карта всего справочника

Ниже инвентаризация, а не список внедрённых подсистем. Непрофильные части сохранены в карте, чтобы не выдавать задачи/CRM за полный экспорт всех продуктов Битрикс24.

| Раздел API | Markdown-страниц |
|---|---:|
| ai | 4 |
| biconnector | 31 |
| bizproc | 26 |
| booking | 64 |
| calendar | 34 |
| catalog | 357 |
| chat-bots | 112 |
| chats | 88 |
| common | 26 |
| crm | 834 |
| departments | 36 |
| disk | 45 |
| document-generator | 40 |
| entity | 22 |
| event-log | 6 |
| events | 13 |
| files | 4 |
| forum | 14 |
| iblock | 5 |
| imopenlines | 80 |
| landing | 144 |
| lists | 24 |
| log | 16 |
| mail | 28 |
| mailservice | 7 |
| messageservice | 6 |
| note | 37 |
| outdated | 39 |
| pay-system | 16 |
| sale | 185 |
| scopes | 3 |
| sign | 26 |
| sonet-group | 60 |
| tasks | 168 |
| telephony | 48 |
| timeman | 24 |
| user | 14 |
| user-consent | 4 |
| vibe | 5 |
| vote | 11 |
| widgets | 109 |
