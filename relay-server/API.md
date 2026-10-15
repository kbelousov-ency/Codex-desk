# Mini App API v1 — этапы 1–5

Bridge wire остаётся в неизменяемом [RELAY_CONTRACT.md](../docs/RELAY_CONTRACT.md).
Этот файл фиксирует только Mini App ⇄ relay и локальные fixture-интерфейсы.

**Готовность:** production wire 2.3 использует Ed25519 и notice-события. ПК создаёт ключевую пару,
`pair_start.publicKey` — canonical base64url SPKI DER, 44 байта. Relay хранит только
публичный ключ и проверяет `hello.proof` как Ed25519-подпись 64 байт над UTF-8
`kuzmich-bridge-v2\n<installationId>\n<serverNonce>`. Challenge действует 30 секунд,
погашается перед первой попыткой проверки; HMAC fallback и fixture verifier отсутствуют.
`pair_complete` не содержит секрета. Прежнее противоречие hash-only/HMAC разрешено
решением владельца о переходе на Ed25519; 2.0 не была развёрнута и не принимается.

## Общие правила

- HTTPS/WSS снаружи. HTTP/WS допускается на loopback; возможны собственный TLS
  или HTTPS-туннель/прокси с явно включённым `RELAY_TRUST_LOOPBACK_PROXY=1`.
- JSON, UTF-8. Время наружу — UTC ISO 8601, внутри SQLite — epoch milliseconds.
- Все `/api/*` запросы, кроме входа и локальной dev-фикстуры, требуют
  `Authorization: Bearer <session_token>`. Токен не передаётся в URL или cookie.
- Чужой и несуществующий `installation_id` одинаково дают 404.
- CORS — точный список `RELAY_ALLOWED_ORIGINS`; default localhost/127.0.0.1:4174 и :5173.
- Query string в API и WebSocket URL запрещён; параметры запуска статической Mini App разрешены.
- HTTP ошибки: `{ "error": { "code": "session_expired", "message": "session_expired" } }`.
  Клиент переводит стабильные коды. В ошибках нет сырого запроса, stack, путей или секретов.
- Обычное тело HTTP ≤16 КиБ, command POST ≤256 КиБ; Mini App WS ≤16 КиБ; bridge WS ≤256 КиБ.

## Авторизация

`POST /api/auth`, `{ "initData": "<Telegram.WebApp.initData>" }`.

Ответ 200: `{ "session_token": "<opaque 256-bit base64url>", "expires_at": "2026-10-14T12:15:00.000Z" }`.

На сервере проверяются HMAC-SHA256 Telegram Bot API и возраст auth_date ≤300 секунд
(допуск часов в будущее 30 секунд). Canonical data исключает только `hash`; `signature`,
если есть, включается. Повторы ключей, некорректное кодирование и unsafe-поля отвергаются.
Сессия действует 15 минут, максимум 10 на пользователя; хранится только SHA-256 токена.
Откройте Mini App заново для нового initData после истечения его пяти минут.

## Состояние

`GET /api/installations` возвращает полный снимок:

```json
{
  "revision": 12,
  "installations": [{
    "installation_id": "<UUID>", "label": "Рабочий ПК", "online": true,
    "last_seen": "2026-10-14T12:00:00.000Z", "revision": 4,
    "tabs": [{ "tab_id": "t_opaque", "title": "Проверка", "agent": "codex", "project": "CodexDesk", "status": "idle", "queueLength": 2, "updatedAt": "2026-10-14T12:00:00.000Z", "queuePaused": true }]
  }]
}
```

`last_seen` может быть null. Внешняя `revision` — durable счётчик вида пользователя:
растёт при изменениях и после перезапуска relay. Клиент отбрасывает меньшие ревизии.
Ревизия установки относится к bridge epoch и может сброситься при новом epoch;
для порядка Mini App использует только внешнюю `revision`.

Tab status: `idle | running | blocked | unavailable | ambiguous`, agent: `codex | claude`.
Таблица вкладок и API содержат ровно восемь полей metadata. `queueLength` — целое
0..50, `queuePaused` — boolean, `updatedAt` — UTC ISO 8601 исходного состояния вкладки.
Пауза сообщает только факт остановки очереди; её причины остаются на ПК.
Нет текстов переписки, ответов, путей, настроек, approvals или credentials.

`GET /api/installations/:id` возвращает одну такую установку с проверкой владельца.
`DELETE /api/installations/:id` отзывает credential и удаляет серверные вкладки,
отвечает `{ "ok": true }`; bridge получает `revoked` и закрытие 4002. Локальные
разрешения на ПК этот API не меняет. Чужая установка — 404 без побочных эффектов.

## Живые обновления

`WS /api/events`. В течение пяти секунд первый фрейм:
`{ "type": "authenticate", "session_token": "..." }`.

Сервер отвечает `{ "type": "snapshot", "revision": 12, "installations": [...] }`
и присылает полный снимок при каждом изменении. `{ "type": "resync" }` запрашивает
полный снимок повторно. Reconnect всегда начинает новую аутентификацию и full snapshot.
Истёкшая/вытесненная сессия закрывается 4001; каждый push заново проверяет session store.
Ошибка WS: `{ "type": "error", "error": { "code": "...", "message": "..." } }`.
При изменении команды дополнительно приходит
`{ "type": "command_updated", "installationId": "<UUID>", "command": { ... } }`.
Это только metadata описанного ниже DTO. Текст и читающий payload в WS не передаются.
Входящих команд и других мутаций через этот сокет нет.

## Настройки уведомлений

`GET /api/notifications` возвращает четыре пользовательских переключателя (по
умолчанию все `true`): `turnCompleted`, `actionRequired`, `commandFailed` и
`presence`. `PUT /api/notifications` принимает любое непустое подмножество этих
полей, каждое только boolean, и возвращает полный сохранённый объект. Bot API
вызывается только relay с токеном из серверного environment. В уведомлениях
используются только название установки и название вкладки; текст команды,
ответа, пути и причины не передаются.

Категории и источники:
- `turnCompleted` — `noticeKind: turn_completed` («Задача завершена»), без утверждения об успехе;
- `actionRequired` — `noticeKind: action_required` («Требуется действие на компьютере»);
- `commandFailed` — `rejected` или `executed` с `outcome: failed` («Команда не выполнена»),
  а также `uncertain` («Требуется проверка на компьютере»);
- `presence` — наблюдение relay: отключение дольше 60 секунд и возвращение после
  отправленного offline-уведомления; краткий reconnect отменяет ожидающий offline-пуш.

Bridge 2.3 передаёт `tabId`, `noticeKind`, `turnId` (строка или null), `occurredAt`
непосредственно в `event` рядом с `kind: notice`. Обёртка `event.payload` не поддерживается:
такое уведомление игнорируется без разрыва соединения, как неизвестный `noticeKind`.
Dedup-ключи сохраняются в SQLite и переживают reconnect/replay; при Bot API 429
relay соблюдает `retry_after`. Переключатели доступны в настройках Mini App.

## Команды

`POST /api/installations/:id/commands`:

```json
{ "commandId": "client-generated-uuid", "tabId": "t_opaque", "action": "send", "text": "Проверь сборку" }
```

Действия: `send`, `stop`, `get_state`, `get_last_answer`. `text` обязателен только для
`send`, `expectedTurnId` — только для `stop`. Для чтения оба поля запрещены. Неизвестные
поля (`model`, `cwd`, `attachments`, `deadline` и другие) отвергаются. `commandId` —
1..64 `[A-Za-z0-9_-]`; текст непустой после trim, до 32 000 UTF-16 units, multiline
разрешён и передаётся без изменения whitespace. Текст с `/` после trim не допускается.

В протоколе v1 нет `enqueue`: Mini App разрешает отправку только в `idle`.
Для занятой (`running`/`blocked`) беседы кнопка отключена с пояснением:
«Беседа занята. Отправка станет доступна, когда задача закончится.»

Новый `send`/`stop` возвращает HTTP 202; читающий POST ждёт максимум 10 секунд.
Полученный за это время читающий payload даёт HTTP 200; иначе HTTP 202 без payload.
Таймаут заканчивает только HTTP-ожидание и не меняет статус команды.

```json
{
  "command": {
    "commandId": "client-generated-uuid", "tabId": "t_opaque", "action": "send",
    "status": null, "outcome": null, "dispatchState": "sent", "detail": null,
    "createdAt": "2026-10-14T12:00:00.000Z", "updatedAt": "2026-10-14T12:00:00.000Z",
    "replayUnavailable": null
  },
  "duplicate": false
}
```

HTTP 202 — квитанция relay, не ACK агента. `status` остаётся null до фрейма bridge.
`dispatchState: sent | delivery_unknown` описывает только транспорт; sent не означает
исполнение. После потери соединения/рестарта может быть delivery_unknown без смены
wire-статуса. Повтор телефонного POST и транспортное восстановление разделены:
POST не отправляет второй фрейм; новое соединение bridge запускает replay принятых команд.

Статусы сохраняются дословно: `queued`, `accepted`, `executed`, `uncertain`, `rejected`.
У executed outcome — `succeeded | interrupted | failed`, у остальных — null.
`uncertain` не является отказом; только новый фрейм bridge может разрешить его,
включая поздний ACK accepted. Терминальные executed/rejected не откатываются старым ACK.
Detail содержит только разрешённый `code`, такое же безопасное `message` для перевода
клиентом и `requiresComputer`. Произвольный bridge message/reason не сохраняется.

Тот же installation + commandId + **точно тот же** payload возвращает HTTP 200,
`duplicate: true` и текущий статус, без второй отправки и без читающего payload.
Изменение action/tab/text/expectedTurnId при том же ID — HTTP 409 `command_conflict`.
Fingerprint и зашифрованный исходный запрос записываются до первой попытки WS-отправки.
Неопределённая доставка не разрешает повтор из POST. `GET /api/installations/:id/commands/:commandId` возвращает
`{ "command": { ... } }`, всегда status-only, в том числе при офлайн-компьютере.

Новая команда требует владельца, актуальную разрешённую вкладку и реальное OPEN
соединение bridge >=2.2 после полного snapshot. 45-секундный presence grace не даёт
права отправлять. Офлайн/нет snapshot — HTTP 409 `not_connected`, bridge 2.1 —
`commands_unsupported`, отсутствующая/чужая установка или вкладка — 404. Запись команды
при таком отказе не создаётся; новой офлайн-очереди нет.

После каждого нового `welcome` и **применённого более нового full snapshot** relay
повторно доставляет все ранее принятые нетерминальные команды установки: null, queued,
accepted и uncertain. executed/rejected исключены. Тот же commandId, tabId, action,
исходный text/expectedTurnId и userRef сохраняются; bridge сверяет свой журнал/getOperation
перед execute. Replay — один раз на команду в соединении, с интервалом 500 мс. Повторные
snapshot/resync в том же соединении не запускают второй проход; замена соединения
останавливает старый проход. Stale/equal snapshot не открывает replay.

Если ранее разрешённая вкладка отсутствует в новом snapshot, её уже принятую команду
relay всё равно доставляет в ту же установку: свежая проверка bridge должна вернуть
unknown_tab. Новые POST остаются запрещены. Отвязка всей установки запрещает replay
и удаляет её активные зашифрованные тела. Read payload по-прежнему требует текущего
разрешения и исходного HTTP waiter; replay чтения без waiter обновляет только статус.

Успешное чтение добавляет в ответ исходного POST `payload`, строго по 2.2:

- `get_state`: `{ "state": { tabId,title,agent,project,status,queueLength,queuePaused,updatedAt,activeTurnId,actions:{send,stop} } }`.
- `get_last_answer`: `{ "answer": null }` либо `{ "answer": { answerId,turnId,text,truncated,completedAt } }`.

Answer text — plain text до 100 000 символов; completedAt nullable. State имеет ровно
10 полей и actions ровно 2, без blockers/reason. Payload получает только инициатор
этого POST, после повторной проверки session/owner/tab/live connection перед выдачей.
HTTP abort, timeout, отвязка, удаление вкладки (включая full snapshot) и истечение
сессии удаляют waiter. Поздний ответ не кэшируется, не рассылается и не replay-ится.

## Pairing

ПК создаёт nonce и показывает `https://t.me/<bot>?startapp=<nonce>` согласно контракту.
После явного согласия в Mini App: `POST /api/pairings/claim`,
`{ "nonce": "<43 base64url characters>", "confirm": true }`.
Ответ: `{ "pairing_id": "<UUID>", "label": "ПК", "status": "phone_confirmed", "expires_at": "<UTC ISO>" }`.

Поиск идёт по SHA-256 UTF-8 строки nonce; исходный nonce в БД и pairing registry не записывается.
`pair_pending` передаёт ПК `botUsername` из серверной конфигурации для сборки deep-link.
Claimant берётся только из проверенной сессии. После `pair_claimed` ПК явно подтверждает
`pair_confirm {pairingId, nonce, claimantUserId}`: сервер сравнивает SHA-256 nonce
с сохранённым хэшем constant-time и требует тот же Telegram ID. До этого installation
и credential не создаются. TTL 10 минут, пять достигших записи попыток; шестая удаляет
запись. Закрытие pairing-сокета отменяет сессию; после рестарта нужна новая привязка.

## Лимиты и хранение

IP: 120 HTTP/мин, 10 входов/мин, 30 WS upgrade/мин. Пользователь: 120 API/мин,
10 claim/10 минут поверх пяти попыток каждой pairing-записи. WS: 10 фреймов/с.
Коды: `rate_limited`, `pairing_locked`, `pairing_expired`, `pairing_claimed`,
`pairing_desktop_unavailable`, `confirmation_required`, `origin_not_allowed`.
Ответ 429/WS 4006 означает backoff; raw frame в журнал не записывается.

`audit` хранит только event/IDs/time pairing и отвязок, retention 30 дней.
Истёкшие sessions удаляются; pairing records — через сутки после TTL.
Новые команды: 30/мин на пользователя, одновременно не более 5 ожидающих чтений.
Дубликаты не расходуют лимит новых команд. Command POST body ≤256 КиБ, чтобы вместить
32 000 UTF-16 units с JSON escaping; остальные HTTP bodies по-прежнему ≤16 КиБ.
`command_ledger` хранит immutable fingerprint, IDs, action, wire status/outcome, timestamps
и AES-256-GCM ciphertext исходного запроса до executed/rejected. Ключ — отдельная
env-переменная `RELAY_COMMAND_PAYLOAD_KEY`: canonical base64url ровно 32 случайных байт,
не bot token и не ключ устройства. AAD связывает ciphertext с версией формата, владельцем,
installationId, commandId, userRef и fingerprint; после расшифровки поля и fingerprint
проверяются заново. Каждая запись получает случайный 12-байтный nonce и 16-байтный tag.
Plaintext text/expectedTurnId, answer и remote detail.message не пишутся в SQLite/WAL.
Терминальный статус и удаление ciphertext/nonce/tag выполняются атомарно. uncertain
сохраняет зашифрованное тело для следующего reconnect. Это логическое удаление активной
записи, не обещание физического стирания старых ciphertext в WAL, backup или на носителе.
Audit содержит только event/IDs/time, включая command_id; body в журнал не попадает.
Таймер никогда не меняет wire-статус; история и терминал отсутствуют. Уведомления
Bot API отправляются только для включённых пользовательских категорий и не содержат
текстов команд, ответов, путей или причин.

`userRef` — случайный `u_…`, стабильный для пары владелец + установка, `[A-Za-z0-9_-]`,
не более 64 символов. Хранится в installations.user_ref; повторная сессия и перезапуск
его не меняют. Разные установки получают разные ссылки. Telegram ID не заменяет userRef.
Неизвестные commandId и чужие tabId из `command_result`/`command_updated` игнорируются.
Payload из event игнорируется всегда; содержимое существует только при прямом ответе
на текущее чтение. По решению владельца ключи идемпотентности живут не меньше установки:
в v1 TTL нет. Ключи и минимальные metadata сохраняются в namespace установки, включая
её запись после отвязки: старый ID не становится новой командой.
Audit по-прежнему 30 дней. Никакой таймер не переводит queued/accepted/uncertain в иной статус.

При будущем переходе на protocol 3 relay сохраняет приём 2.x не менее 90 дней.
Миграция SQLite v3 добавляет публичные ключи, userRef и новые поля вкладок. Старые
пять metadata-полей сохраняются с NULL в новых колонках; неполные записи скрыты из API
до authoritative snapshot. Не создаётся фиктивная активность/очередь. Legacy HMAC hashes
сохраняются как неиспользуемые старые данные, не читаются для аутентификации и не
записываются заново; установки без публичного ключа требуют новой привязки.

## Локальная фикстура

`GET /api/dev/init-data` существует только в `RELAY_DEV_FIXTURE=1`/`npm run fixture`.
Возвращает `{ "initData": "<fresh signed synthetic fixture>" }`. Следующий `/api/auth`
проходит обычную HMAC-SHA256 проверку Telegram initData, не устройства.
Устройство и в фикстуре проходит Ed25519-проверку. Фикстурный user — 10001; token — публичный synthetic
маркер из `src/fixtures.ts`, непригодный для Telegram. Весь fixture relay принимает
только loopback peer + localhost Host/Origin без Forwarded/X-Forwarded*/CF-Connecting-IP,
Via и подобных прокси-заголовков. Публикация через туннель в этом режиме не работает.
SQLite v4 сохраняет прежнюю четырёхстатусную таблицу под именем `legacy_commands_v3`
без перекодировки или потери строк; API её не использует. Новый ledger имеет только
wire-статусы и nullable статус до ACK. Bridge 2.1 продолжает работать в режиме чтения списка.

SQLite v5 добавляет зашифрованные оригиналы и сохранённый userRef каждой команды.
Старая hash-only send/stop-запись не содержит исходного текста/turnId: relay не угадывает их,
а отдаёт metadata `replayUnavailable: "legacy_payload_missing"`. Совпадающий исходный POST
может восстановить недостающее encrypted body после проверки fingerprint, **без отправки**;
доставка произойдёт только на следующем reconnect. Терминальные дубликаты тело не восстанавливают.
Старые get_state/get_last_answer восстанавливаются из известных action/tab/ID при совпадении fingerprint.

Другие replayUnavailable: `command_payload_key_required`, `command_payload_corrupt`,
`replay_identity_changed`, `installation_revoked`. Они не меняют wire status/outcome.
Некорректный ключ даёт `command_payload_key_invalid`, ключ другой БД —
`command_payload_key_mismatch` при открытии, без попытки dispatch. `src/main.ts` требует
стабильный env-ключ для файловой БД; :memory: fixtures получают отдельный ephemeral key.
Низкоуровневый Store без ключа может читать старые metadata, но не создавать/расшифровывать тела.
`GET /health` показывает `{ "ok": true, "bridge_ready": true, "server_protocol": "2.3" }`.
