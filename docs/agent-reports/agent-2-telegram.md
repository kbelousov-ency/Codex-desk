# Агент 2 → агент 1: Telegram-пульт, передача работы — 2026-10-13

Реализована часть агента 2 по [контракту](../REMOTE_CONTROL_CONTRACT.md): транспорт long polling,
бот, привязка владельца, хранение токена и два компонента настроек. Общие файлы не редактировались.
Полное описание поведения и границ — [docs/TELEGRAM.md](../TELEGRAM.md).

## Файлы агента 2

Новые, все мои:

```
electron/telegram/storage.mjs    шифрованный токен, атомарная служебная запись, пределы, редакция
electron/telegram/api.mjs        единственное место, собирающее URL Bot API; классификация ошибок
electron/telegram/polling.mjs    long polling, backoff, retry_after, отмена; повторы исходящих
electron/telegram/lock.mjs       признак единственного получателя обновлений для бота
electron/telegram/pairing.mjs    одноразовый код: TTL, лимит попыток, атомарное использование
electron/telegram/authorize.mjs  проверка источника каждого update и смысла каждой кнопки
electron/telegram/format.mjs     разбиение по лимитам Bot API, Unicode, карточки, экранирование
electron/telegram/bot.mjs        кнопки, адресация, сохранённый выбор, вызовы контроллера, уведомления
electron/telegram/service.mjs    createTelegramService, PhoneAccessBridge, состояние соединения
src/PhoneAccessSettings.tsx      + src/phone-access.css
src/TelegramThreadAccess.tsx     + src/telegram-thread-access.css
tests/fixtures/telegram.mjs      fake transport + fake RemoteControl, без токена и сети
tests/telegram-transport.test.mjs  tests/telegram-pairing.test.mjs  tests/telegram-bot.test.mjs
scripts/ui-phone-access.mjs      UI-сценарий обоих компонентов
docs/TELEGRAM.md
```

Я не менял `main.mjs`, `preload.cjs`, `window-session.mjs`, workspace-хранилище, `src/types.ts`,
`App.tsx`, `Workspace.tsx`, `useCodex`/`useMessageQueue`, `package.json`, lockfile.

## Подключение: уже сделано тобой, расхождений нет

Проверил твою интеграцию — она совпадает с моей реализацией один в один:

- `main.mjs:1459` — `createTelegramService({ userData: channelPaths.userData, safeStorage, remote: remoteControl.remote })`.
  Подпись совпадает. `fetch` опционален и по умолчанию берётся встроенный — отдельной зависимости нет.
- `main.mjs:447` — allowlist `getState / setBotToken / clearBotToken / setEnabled / createPairing /
  cancelPairing / unpair` через `telegramService.local[method]`. `onState` по IPC не выставлен —
  правильно, это событие. Фасад `remote` в renderer не уходит.
- `preload.cjs:83` — `window.codex.phoneAccess` ровно с этими методами и событием `phoneAccess:state`.
- `App.tsx:45,46` — **именованные** экспорты. Я отдаю `export function PhoneAccessSettings` и
  `export function TelegramThreadAccess`, плюс default как подстраховку.
- `App.tsx:887` — вкладка «Телефон» в `SettingsDialog`, `App.tsx:870` — toggle у беседы с
  `state / busy / onChange`. Совпадает с props из контракта.

**Типы** я беру из твоего `src/types.ts` (`PhoneAccessState`, `PhonePairing`, `PhoneAccessBridge`,
`RemoteThreadAccessState`, `TelegramThreadAccessProps`, `PhoneAccessSettingsProps`). Свой
дублирующий файл типов я создал и удалил — двух определений нет. `tsc --noEmit` чистый.

### Одно исправление, которое я внёс у себя из-за твоего порядка запуска

`main.mjs:1463` ждёт `await telegramService.start()` **до** `installHandlers()`. Если бы `start()`
дожидался сети, недоступный Telegram задерживал бы запуск приложения на время `getMe` и захвата
замка. Поэтому `start()` теперь ждёт **только** чтение хранилища, а подключение уходит в фон и
сообщает о себе через `onState` (`connection: 'starting' → 'polling' | 'error'`). Менять порядок
в `main.mjs` не нужно. Тест: «startup waits only for storage, never for Telegram to answer».

## Что нужно от тебя

1. **`package.json`** — добавить скрипт (файл твой, я не трогал):
   ```json
   "test:phone-access": "node scripts/ui-phone-access.mjs"
   ```
   Node-тесты подхватываются существующим `tests/*.test.mjs` автоматически.
2. **`scripts/check.mjs`** — если он перечисляет UI-сценарии явно, включить `ui-phone-access`.
3. **Поведение `RemoteControl`, на которое я опираюсь** (подтверди при приёмке):
   - `listThreads()` даёт `title` и `projectLabel` **только** для действующих разрешений; отозванная
     беседа исчезает из списка. Я на этом строю отказ «доступ больше не разрешён» без раскрытия названия.
   - `RemoteTarget.generation` меняется durable при отзыве/перепривязке. Я сравниваю её с
     поколением, записанным в адресацию reply и в кнопку, и при расхождении **предлагаю выбрать
     беседу заново**, а не отправляю в текущую выбранную.
   - Повтор одного `requestId` возвращает ту же операцию без второй отправки; иной payload при том
     же ID — `request_conflict`. На этом держится вся идемпотентность после сбоя.
   - `execute` с `ok:false, stale_target` означает «RPC не было». Я сообщаю об устаревшем адресе
     и не повторяю с новым адресом.
   - `readEvent` заново проверяет разрешение и поколение. Я вызываю его **перед каждым фрагментом**
     длинного ответа и прекращаю отправку при `access_denied`.
   - `getLastAnswer` возвращает уже готовый результат и никогда не вызывает модель.
4. **Отзыв разрешения беседы** должен приводить к её исчезновению из `listThreads` немедленно —
   у меня нет собственного кеша списка, я вызываю `listThreads` перед каждым действием.

## Проверено

Фикстурно, изолированно, без реального токена, сети и запросов модели:

- `node --test tests/telegram-transport.test.mjs` — 21 passed.
- `node --test tests/telegram-pairing.test.mjs` — 15 passed.
- `node --test tests/telegram-bot.test.mjs` — 24 passed.
- `node --test tests/*.test.mjs` — **1192 passed, 2 платформенных skipped, 0 failed** (регрессий нет).
- `npx tsc --noEmit` — чисто.
- `node scripts/ui-phone-access.mjs` — прошёл. Снимки: `artifacts/phone-access-pairing.png`,
  `phone-access-420.png`, `phone-access-settings-dialog.png`, `telegram-thread-access.png`.

Покрыто по твоему списку требований: посторонний пользователь, группа, канал, правка сообщения,
business/guest/inline, бот-отправитель, совпавший username; поддельный и устаревший callback,
кнопка прежнего поколения; истёкший и повторно присланный код, лимит попыток, гонка привязки;
повтор update и callback, восстановление после сбоя между вызовом и коммитом; переключение
выбранной беседы между получением и обработкой текста; старый и забытый reply, отзыв доступа,
отсутствие fallback; ошибка Telegram-ответа без повторного запуска агента; длинные ответы,
Unicode и эмодзи в пределах 4096 UTF-16, rate limit, конфликт polling, единственный получатель
для нескольких окон/каналов; отсутствие токена в публичных DTO, ошибках, журнале и снимках;
доступность компонентов (role/aria, клавиатура, фокус, 420 px).

### Чего НЕ проверено

- **Живого Telegram не было вовсе**: ни настоящего `getUpdates`, ни настоящей отправки, ни
  настоящего `getMe`. Нужен явно предоставленный тестовый бот и отдельное поручение.
- Настоящего запроса модели через цепочку телефон → контроллер → CLI не было.
- Упакованного Nightly с этой функцией нет. `npm run check`, `package`, перенос в Release и
  публикацию я не запускал — по заданию это твоя часть.
- Пользовательские токены, найденные в системе, не использовались; рабочих сообщений не отправлялось.

## Решения, о которых стоит знать при разборе

- **`callback_data` ограничен 64 байтами**, поэтому в кнопке только короткий случайный nonce;
  смысл берётся из durable записи (владелец, поколение привязки, адресат, поколение разрешения,
  действие, `expectedTurnId`). Ничего присланного клиентом не принимается без этой сверки.
- **Ошибки Bot API различаются по числовому коду**, не по тексту `description`: справочник прямо
  предупреждает, что это человекочитаемая свободная строка. 409 покрывает и чужой polling, и
  webhook — различаю только через read-only `getWebhookInfo`. Чужой webhook не удаляется.
- **Однократный 401 повторяется дважды**, фатален только устойчивый: 401 бывает временным.
- **Замок единственного получателя лежит вне `userData`** (общий пользовательский каталог, имя —
  дайджест токена), иначе Release и Nightly не увидели бы друг друга и устроили бы 409-пинг-понг.
- **`maxUpdateId` не используется как фильтр дублей.** Справочник: после недели без обновлений
  следующий `update_id` выбирается случайно — постоянная высокая метка однажды проглотила бы
  законный новый update. Дубли ловит журнал (7 дней, заведомо больше 24-часового хранения
  Telegram), а offset старше 36 часов отбрасывается.
- **Остановка в два шага**: кнопка подтверждения привязана к ходу из показанной карточки, поэтому
  повторное нажатие даёт тот же `requestId`, а более новый ход старой кнопкой не останавливается.
- **Ответ агента уходит без `parse_mode`** — код и Markdown внутри ответа невозможно испортить.
  Свои карточки — HTML с экранированием каждого подставленного значения.
- `requestId` для выбора «уточнить / после завершения» берётся от `update_id` **исходного текста**,
  поэтому повтор нажатия идемпотентен, а нажатие второй кнопки отклоняется (сохранённое действие
  одноразовое). Устаревшее уточнение не превращается в новую задачу: предлагается отдельная
  явная кнопка «Отправить как новую задачу» с новым `requestId`.

## Замечание не по моей части

Все `scripts/ui-*.mjs` в репозитории задают `timeout: 30_000` на первом `page.goto`, а холодный
старт vite здесь занимает **~32 с** (замер 31 738 мс): скан зависимостей падает из-за сотен
посторонних `.html` в `artifacts/**`, `release/**/LICENSES.chromium.html` и `output/**`. Сообщение
«Failed to scan for dependencies from entries» не фатально (`ui-memory-rules` при нём проходит),
но существующие сценарии на грани случайного отказа. У себя я поставил 120 с. Настоящее лечение —
чистка `artifacts/` и `release/` от мусорных html; это твои/общие каталоги, я их не трогал.
Побочно: `optimizeDeps: { entries: ['index.html'] }` как обход **не работает** — меняет хеш
конфига, вызывает пересборку и подвешивает загрузку страницы совсем (проверено).

Готов участвовать в разборе проблем своей части после интеграции.

---

# Агент 2 → агент 1: исправлена тихая потеря входящего сообщения — 2026-10-13

Подтверждённый дефект закрыт. Ниже исходная причина, новая семантика обработки ошибок,
результаты регрессий и точные команды проверки. Файлы — только мои:
`electron/telegram/bot.mjs`, `electron/telegram/storage.mjs`,
`tests/telegram-inbound-persistence.test.mjs`, `docs/TELEGRAM.md` и этот отчёт.
`main.mjs`, `preload.cjs`, `App.tsx`, workspace writer, `package.json`, lockfile и общие
тесты я не трогал. Новый node-тест подхватывается существующим `tests/*.test.mjs`,
отдельный скрипт в `package.json` не нужен.

## Исходная причина

`_execute` правильно ждал durable запись `update → requestId/исходная команда` **до**
`remote.execute`. Но отказ этой записи был обычным исключением, а общий `try/catch`
в `handleUpdates` считал **любое** исключение завершением обработки:

```js
} catch (error) {
  await this._finish(updateId, 'failed', String(error?.message || 'ошибка').slice(0, 200), updateId + 1);
}
```

`_finish` в одном write ставил терминальный статус **и** продвигал offset. Если сама запись
команды была единственной неудачной (временная блокировка файла), следующий write проходил,
offset уходил за update, и Telegram больше его не присылал. Итог: dispatch'а нет, ответа
в Telegram нет, на компьютере тоже ничего — сообщение исчезало. Воспроизведено через настоящий
`handleUpdates` (update 950, падает только запись команды): `handleUpdates` успешно
завершался, `offset=951`, `status=failed`, `requestId=null`, `executed=0`, `sent=0`.

Вторая, скрытая часть той же причины: адресат сообщения существовал только в памяти. Даже если
бы update вернулся, повторная обработка заново выводила бы адресата из **текущего** `selection`,
то есть могла отправить текст в другую беседу.

## Новая семантика

1. **Отказ обязательной записи — не обработка.** Такой update не получает терминального статуса,
   offset за него не продвигается, пакет **останавливается** на нём (offset — одно число, поэтому
   коммит более позднего update подтвердил бы и этот), и ошибка уходит наружу
   `UpdateHandlingError` → `UpdatePoller` → `onStatus({fatal:true})` → `connection:'error'`
   с безопасным текстом. `enabled` не меняется; после устранения причины Telegram присылает
   те же updates заново.
2. **Различаются два класса отказов.** Отказ по сути — вложение, slash, пустой/длинный текст,
   неизвестный reply, невыбранная беседа, неподдержанный источник, а также `UpdateRejected`
   («команда принадлежит другой привязке», «привязка изменилась») — подтверждается, иначе
   заведомо неисполнимый update навсегда заблокировал бы все следующие. Всё остальное,
   включая непредвиденное исключение, fail closed: не подтверждается.
   Деталь в журнале теперь фиксированная фраза, а не `error.message`.
3. **Адресат доказывается записью.** `_route()` решает «кому» синхронно, до первого await, из того
   же снимка, в котором update пришёл, и результат пишется в ту же запись, что admit'ит update
   (`routing`, плюс `ownerGeneration`). Повтор берёт сохранённого адресата. Смена `selection`,
   отзыв разрешения или перепривязка между попытками не перенаправляют сообщение; при отзыве бот
   говорит «доступ больше не разрешён» и предлагает выбрать беседу заново, не раскрывая названия.
   Запись прежней привязки (`ownerGeneration` не совпал) подтверждается и отбрасывается.
   Если запись открыта, а адресат в ней не сохранён (запись от прежней сборки), бот **не угадывает**,
   а просит выбрать беседу и прислать текст заново.
4. **После возможного принятия команды повтора «на удачу» нет.** При `replay` сначала read-only
   `getOperation` с сохранённым `requestId`; `not_found` — доказательство ядра, что отправки
   не было, и только тогда `execute`. Прежний код при `thread.target === null` пропускал сверку
   и вызывал `execute` вслепую — теперь это сообщение «Требуется действие на компьютере».
5. `TelegramStorageError` (новый класс в `storage.mjs`) помечает именно не состоявшуюся запись;
   `store.update` бросает его при отказе atomic write и при нечитаемой записи. Ошибка мутатора
   (логический отказ) проходит как есть и остаётся различимой.

Что сохранено без изменений: проверки владельца/поколения/разрешения/активности после pacing
и внутри каждой попытки отправки; `requestId = tg:<botId>:<chatId>:<updateId>:<действие>`
и идемпотентность; одноразовость сохранённого выбора; «неудачная отправка в Telegram никогда
не повторяет запрос агенту»; отсутствие токена, URL Bot API и текста команды в диагностике.

## Регрессии

`tests/telegram-inbound-persistence.test.mjs` — 15 тестов, все через настоящий
`TelegramBot.handleUpdates`, настоящий `UpdatePoller` и настоящий `createTelegramService`
с подставным транспортом и реальным `TelegramStore` на временном каталоге. Запись ломается
точечно: мутатор прогоняется, а commit не состоится — ровно как при занятом/переполненном диске.
До исправления падали 10 из 15 (три проходили как контрольные: подтверждение ожидаемых отказов
входа, отказ команды чужой привязки, ошибка Telegram-ответа).

| Обязательный пункт | Тест |
| --- | --- |
| 1. Разовый сбой записи до dispatch | `a failed required write before dispatch neither dispatches nor acknowledges the update` |
| 2. Восстановление: адресат, requestId, одно выполнение | `recovery after the failure keeps the original addressee and request id and executes once` |
| 3. Пакет: поздний offset не подтверждает ранний | `a later update in the same batch cannot acknowledge the earlier unhandled one` |
| 4. Постоянный отказ записи | `a permanent write failure…` + `the service shows the storage failure in its own state…` |
| 5. Отказ сохранения после принятия команды | `a write failure after the command was accepted reconciles instead of executing twice` + `an accepted command is never re-sent blindly while its conversation is unavailable` |
| 6. Смена selection / отзыв / владелец между попытками | `a revoked conversation stops the replay…`, `an update admitted under a previous pairing is dropped…`, `an open entry whose addressee was never proven asks the owner instead of guessing` |
| 7. Ошибка Telegram-ответа | `a failed Telegram confirmation never repeats the request to the agent` |

Дополнительно: `expected refusals of the input are acknowledged so polling never loops on them`
(не зацикливаемся на заведомо неподдерживаемом), `a command that belongs to a different pairing
is refused once and acknowledged`, `a decision taken on a button survives a failed write without
a second execution` (кнопка «Уточнить»: requestId остаётся от исходного текста),
`the poller leaves its offset alone and reports the failure as fatal` (один `getUpdates`,
`poller.offset` не сдвинут, фатальный статус без токена и текста команды).

## Результаты (всё фикстурно, 0 запросов модели, живого Telegram нет)

```
node --test tests/telegram-inbound-persistence.test.mjs        15 passed
node --test tests/telegram-inbound-persistence.test.mjs tests/telegram-bot.test.mjs \
            tests/telegram-pairing.test.mjs tests/telegram-transport.test.mjs \
            tests/remote-telegram-boundaries.test.mjs          86 passed (71 прежних + 15 новых)
node --test tests/*.test.mjs                 1242 passed, 2 платформенных skipped, 0 failed
npx tsc --noEmit                                              чисто
npm.cmd run test:remote-control-host                          PASS, modelCalls 0, telegramNetwork false
```

Прогон полного набора включал твои текущие рабочие правки (в том числе изменённый
`tests/workspace-state.test.mjs`). В промежуточном прогоне один раз упал
`tests/release-publication.test.mjs` с `EPERM` на `rename` внутри `artifacts/publication-test-*`;
отдельным прогоном и в итоговом полном прогоне он прошёл — Windows-гонка sharing в захламлённом
`artifacts/` (та же причина, что у ~32-секундного холодного старта vite-сценариев), к Telegram
отношения не имеет.

Не запускал: `scripts/ui-phone-access.mjs` (компоненты не менялись), `npm.cmd run check`,
`package`, Nightly. Живого бота, настоящего `getUpdates`/`sendMessage` и запроса модели через
эту цепочку по-прежнему не было; пользовательские токены не использовались.

## Что проверить при интеграции

- Контракт ядра, на который опирается п. 4: `getOperation` с **свежим** target того же
  `grantId/provider/projectKey/threadId` возвращает сохранённую операцию, а `not_found` означает,
  что команда не была допущена (отметка `dispatching` пишется до RPC). Если `not_found` может
  вернуться для уже отправленной команды — скажи, я уберу переход к `execute`.
- Фатальный статус получателя гасит polling до действия пользователя: после устранения причины
  нужен `setEnabled(false/true)` (или перезапуск). Если хочешь автоматический повтор reconcile
  по таймеру — это твоя часть (`service.reconcile` вызывается из `background`), скажи, добавлю
  со своей стороны seam.
- Новые поля записи `updates[]`: `ownerGeneration`, `routing` (только `mode` и `grantId`/
  `generation`/`fromReply`, без текста). Старые записи читаются: отсутствие `routing` у открытой
  записи трактуется как «адресат не доказан» и приводит к вопросу владельцу, а не к отправке.

Команды для твоей проверки — ровно те, что в блоке результатов выше; Nightly собираешь ты
после объединения обеих частей.
