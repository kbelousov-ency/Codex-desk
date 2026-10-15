# Relay Кузьмича — локальная разработка

Новый самостоятельный пакет Node.js 24+ + TypeScript, встроенный `node:sqlite` и WebSocket.
Корневой package.json, desktop и Coder-Portal не используются для запуска relay.
API Mini App описан в [API.md](API.md), bridge — в [контракте](../docs/RELAY_CONTRACT.md).

**Реализован production wire 2.3 с Ed25519, командами и notice-событиями.** ПК создаёт ключевую пару; relay получает
и хранит только публичный ключ. Приватный ключ не покидает ПК. Подпись одноразового
challenge проверяется штатным Node crypto, включая после перезапуска relay.
Pairing, HTTP, WS и UI используют один production-путь; тестового verifier больше нет.
Для разрешённых вкладок доступны send/stop/get_state/get_last_answer и уведомления этапа 4.

Причина перехода сохранена в [решениях приёмки](../docs/TELEGRAM_MINIAPP_PLAN.md):
прежний HMAC по исходному deviceSecret был несовместим с hash-only хранилищем.
Владелец выбрал Ed25519; 2.0 нигде не развёрнута, совместимость с её HMAC не требуется.
Локальная фикстура отличается synthetic Telegram identity и fake bridge, не криптопроверкой.

## Запуск одним файлом для владельца

Для первого живого прогона запустите двойным щелчком
[`start-live.cmd`](start-live.cmd). Скрипт собирает production Mini App с выключенными
fixture-режимами, находит `cloudflared` (затем `ngrok`, а при отсутствии обоих ставит
официальный пакет Cloudflare через `winget` или скачивает официальный Windows-релиз
с GitHub), поднимает Quick Tunnel и сам связывает его origin с relay. Если Node/npm
зависимости Mini App ещё не установлены, скрипт выполнит `npm.cmd ci --ignore-scripts`.

После запуска скрипт спросит только token отдельного тестового бота BotFather
(вводится скрыто и передаётся только дочернему relay) и username бота без `@`.
Token, username и `RELAY_COMMAND_PAYLOAD_KEY` не пишутся в репозиторий или логи;
ключ хранится защищённым DPAPI-файлом в `%LOCALAPPDATA%\KuzmichRelay`, база там же.
На экране появятся ровно три строки: HTTPS-ссылка для Main Mini App/кнопки меню
 BotFather, чистый `wss://<origin>` для поля «Адрес сервера» (хвост `/bridge/v2`
 дописывается автоматически) и напоминание
не закрывать окно. Mini App может открыться не сразу, а через пару минут после запуска:
имя Quick Tunnel иногда ждёт распространения DNS. Пока это окно открыто, работают relay и туннель; остановка —
`Ctrl+C`, после чего оба процесса завершаются.

Для безопасной проверки без Telegram предусмотрен только внутренний smoke-режим:
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-live.ps1 -SyntheticTest`
с фиксированными synthetic token/username и автоматическим завершением. Этот режим
не принимает реальные credentials и не публикует Mini App в Telegram.

## Всё на одном ПК, без Telegram и токенов

Нужен Node 24+ (проверено на 24.16.0). Используется strip-only запуск `.ts` средствами
Node; `tsc` проверяет в том числе `erasableSyntaxOnly`. SQLite не требует native addon.

Первый PowerShell:

```powershell
Set-Location 'E:\My projects\CodexDesk\relay-server'
npm.cmd ci --ignore-scripts
npm.cmd run fixture
```

Запуск слушает `127.0.0.1:8787`, создаёт SQLite в памяти и выполняет полный локальный
pairing с fake bridge. Появляются две разрешённые вкладки; snapshot обновляется каждые
8 секунд. Fake bridge поддерживает состояние, последний ответ, отправку и остановку
конкретного хода; отправка заканчивается синтетическим ответом через 2,5 секунды.
Текст пользователя не выводится в консоль и не записывается в БД в открытом виде. Реальная модель
не вызывается. Второй компьютер и установленный Кузьмич для этого не требуются.
`TELEGRAM_BOT_TOKEN` должен отсутствовать: скрипт откажется при заданном реальном токене.
`Ctrl+C` останавливает только созданные fixture-процессы. При новом запуске состояние новое.

Второй PowerShell:

```powershell
Set-Location 'E:\My projects\CodexDesk\miniapp'
npm.cmd ci --ignore-scripts
$env:VITE_LOCAL_RELAY = '1'
npm.cmd run dev -- --host 127.0.0.1 --port 5173
```

Откройте `http://127.0.0.1:5173/`. Vite проксирует `/api` и WebSocket на порт 8787.
Mini App получает свежий подписанный synthetic initData из `/api/dev/init-data`, затем
проходит обычный HMAC-SHA256 вход по Telegram initData; устройство проверяется через
Ed25519, без HMAC fallback. Официальный Telegram SDK в этом локальном режиме не загружается.
Для полностью автономного UI без backend остановите Vite, выполните
`Remove-Item Env:VITE_LOCAL_RELAY -ErrorAction SilentlyContinue`, запустите его снова
и откройте `http://127.0.0.1:5173/?fixture=1`.

Чтобы запустить пустой локальный relay с файловой БД вместо готового демонстрационного
bridge, задайте `RELAY_DEV_FIXTURE=1` и стабильный `RELAY_COMMAND_PAYLOAD_KEY`, затем
`npm.cmd start`. База по умолчанию `data/relay.sqlite`. Ключ нужен для зашифрованных
исходных запросов, чтобы replay работал после перезапуска relay. Сгенерировать ключ
один раз без вывода его в консоль текущего PowerShell можно так:

```powershell
$env:RELAY_COMMAND_PAYLOAD_KEY = (node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
```

Сохраните это значение в защищённой конфигурации окружения сервиса и используйте тот
же ключ после перезапуска. Команда выше задаёт только текущую сессию PowerShell;
повторная генерация для существующей БД даст `command_payload_key_mismatch`.
Ключ не помещают в репозиторий, Vite-переменные, URL или журналы. Это отдельный ключ
relay, он не связан с bot token или Ed25519-ключом устройства.
Публичные ключи переживают перезапуск relay: ПК с прежним приватным ключом сможет
подключиться снова. Скрипт `fixture` намеренно держит собственные ключи и БД в памяти
и начинает демонстрацию заново при новом запуске. Сырые secrets в БД не появляются.

## Команды и уведомления

Relay хранит и отдаёт wire-статусы дословно: `queued`, `accepted`, `executed`,
`uncertain`, `rejected`. Только у `executed` есть `outcome: succeeded | interrupted | failed`,
у остальных `outcome: null`. Отдельного серверного статуса `failed` нет.
До ACK статус null; HTTP 202 и транспортный `dispatchState` не подтверждают исполнение.
`executed`/`rejected` терминальны и атомарно удаляют зашифрованное тело команды;
`uncertain` требует проверки ПК и остаётся нетерминальным. Офлайн-команды отвергаются:
серверной очереди и действия `enqueue` нет, а Mini App отправляет только в `idle`.

В Mini App настраиваются четыре категории (`GET/PUT /api/notifications`), все включены
по умолчанию: `turnCompleted`, `actionRequired`, `commandFailed`, `presence`.
Первые две используют только нормативный `notice` 2.3: поля `tabId`, `noticeKind`,
`turnId` (строка или null), `occurredAt` прямо в `event`. Обёртка `payload` и неизвестный
`noticeKind` игнорируются без разрыва соединения. `commandFailed` сообщает о
`rejected`, `executed + outcome: failed` и необходимости проверки при `uncertain`.
Presence сообщает об отключении дольше 60 секунд и последующем возвращении;
короткий reconnect отменяет ожидающее уведомление. Dedup переживает reconnect/replay,
при Bot API 429 соблюдается `retry_after`. Relay вызывает только `sendMessage`,
используя `TELEGRAM_BOT_TOKEN` из environment; в пушах только названия установки/вкладки,
без текста команд, ответов, путей и причин. Подробности — в [API.md](API.md).

## Автопроверки

```powershell
Set-Location 'E:\My projects\CodexDesk\relay-server'
npm.cmd run check
npm.cmd test
Set-Location '..\miniapp'
npm.cmd run check
```

Relay tests используют `node:test`, локальные HTTP/WS и synthetic identity. Проверяются
фиксированный независимый HMAC-вектор (Python hashlib/hmac), malformed/duplicate/tampered
initData, фиксированные RFC 8032/независимые wire-векторы Ed25519, replay/неверный ключ,
TTL и лимит pairing, single-use, nonce/claimant confirmation, public-key storage, ACL,
несколько установок, отзыв, presence/heartbeat, replacement connection, epoch/revision,
gap/resync и restart, восемь metadata-полей, короткая WS-сессия, session eviction,
миграция старой SQLite, pair-scoped userRef, idempotency/conflict, offline/sync gate,
wire-статусы, stale stop, transient read payload, abort/timeout/revocation races,
командные лимиты и отсутствие plaintext в SQLite/WAL. Fingerprint и encrypted original
пишутся до отправки. Повтор POST не отправляет второй фрейм, а transport replay после
нового соединения сохраняет тот же ID и проверяется подставным desktop ledger:
две доставки дают одно исполнение. Проверяются key mismatch, AAD/ciphertext corruption,
потерянный результат, restart relay, stale snapshot, once-per-connection и все pending статусы.
Ни один тест не обращается к Telegram. Реальные запросы модели и упаковка desktop не запускаются.

## Туннель + отдельный тестовый бот

Ниже инструкция для владельца. По его подтверждению перед этапом 5 живая проверка
пушей, stop, обрыва Wi-Fi и закрытия Кузьмича пройдена; автоматические тесты ниже
используют synthetic fixtures, а не настоящий Telegram или модель.
Fixture mode нельзя публиковать: localhost guard отвергает Host/Forwarded заголовки туннеля.
Путь Ed25519, команды и notice-события согласованы контрактом 2.3.

1. В BotFather вручную создайте отдельного тестового бота (`/newbot`), не production-бота.
   Его token передайте только серверному процессу через `TELEGRAM_BOT_TOKEN`.
   Имя без `@` задайте в `TELEGRAM_BOT_USERNAME`: оно возвращается ПК в `pair_pending`.
   Не используйте `VITE_*`, `.env` в репозитории, CLI-аргумент, URL или лог для токена.
2. Отключите локальные режимы перед сборкой Mini App:
   `Remove-Item Env:VITE_LOCAL_RELAY -ErrorAction SilentlyContinue` и
   `Remove-Item Env:VITE_TELEGRAM_FIXTURE -ErrorAction SilentlyContinue`, затем
   `npm.cmd run build` в `miniapp`. Это сборка только web-пакета, не desktop package/release.
3. В серверном окружении задайте `RELAY_DEV_FIXTURE=0`, `RELAY_HOST=127.0.0.1`,
   `RELAY_PORT=8787`, `RELAY_STATIC_DIR=../miniapp/dist`, `RELAY_TRUST_LOOPBACK_PROXY=1`.
   Задайте собственный постоянный `RELAY_COMMAND_PAYLOAD_KEY` (32 случайных байта base64url).
   Запустите `npm.cmd start` из `relay-server`. Bot token остаётся только в этом процессе.
4. В отдельной консоли владельца запустите **один** установленный туннель:
   `cloudflared tunnel --url http://127.0.0.1:8787` либо `ngrok http 8787`.
   Скопируйте выданный HTTPS origin и задайте его как `RELAY_ALLOWED_ORIGINS`, затем
   перезапустите relay. Прокси должен добавлять `X-Forwarded-Proto: https`;
   relay доверяет этому заголовку только от loopback и только при явной настройке.
5. Через настройки BotFather назначьте HTTPS URL Main Mini App/кнопке меню тестового
   бота. В bridge задайте тот же сервер с `wss://…`; путь `/bridge/v2`, подпротокол
   `kuzmich-bridge.v2`. Затем проведите привязку с явным согласием на телефоне и ПК.
6. Откройте Mini App на телефоне. Все компоненты по-прежнему работают на ПК; HTTPS/WSS
   публикует туннель. Если URL изменился, обновите BotFather и allowed origins.
   Telegram webhook и long polling не нужны: уведомления отправляются relay напрямую через
   Bot API; токен остаётся только в environment серверного процесса.

Для собственного TLS вместо прокси задайте `RELAY_TLS_CERT` и `RELAY_TLS_KEY` путями
к файлам сертификата/ключа. Незащищённый внешний listener не разрешается.
Постоянный сервер нужен после проверки этой ступени; она здесь ещё не выполнялась.

## Конфигурация и данные

Пример имён переменных — [.env.example](.env.example); файл автоматически не загружается.
`RELAY_DATABASE` задаёт путь SQLite. Сессии и nonce pairing хранятся как SHA-256;
установка содержит только публичный Ed25519-ключ, без секрета или приватного ключа.
Audit содержит событие, IDs и время,
очищается через 30 дней. Тексты переписки, ответы, пути, approvals и настройки ПК
не сохраняются. Command endpoint и точные DTO описаны в [API.md](API.md).
В `command_ledger` находятся IDs, immutable fingerprint, action, wire status/outcome
и зашифрованный AES-256-GCM оригинал нетерминального запроса. Plaintext текста команды,
expectedTurnId, текста ответа и remote error.message не записывается в SQLite/WAL.
Читающий ответ никогда не сохраняется и существует только до выдачи исходному HTTP POST.
При executed/rejected ciphertext/nonce/tag удаляются атомарно со статусом; uncertain
остаётся нетерминальным. Отвязка всей установки тоже очищает активные encrypted bodies.
Это логическая очистка активных строк, без обещания физического удаления старых ciphertext
из WAL/backup/носителя; резервные копии БД и серверный ключ должны храниться отдельно.

Новая команда отклоняется немедленно, если нет OPEN соединения bridge >=2.2 после
полного snapshot; presence grace не создаёт очередь новых офлайн-команд. GET и повтор
одинакового POST возвращают metadata без второй отправки и без payload. После каждого
нового welcome + применённого full snapshot relay повторно доставляет ранее принятые
null/queued/accepted/uncertain команды, по одной попытке на соединение, с интервалом 500 мс.
ID, action, tab, исходный текст/turnId и userRef не меняются; bridge проверяет journal/getOperation.
Повторные snapshot того же соединения не запускают новый проход; executed/rejected исключены.
Даже отсутствующая теперь вкладка получает уже принятую команду для свежего unknown_tab
от bridge. Новая команда в такую вкладку запрещена; read payload без текущего grant не выдаётся.
Потеря ACK не становится выдуманным rejected/uncertain: wire-статусы меняет только bridge.

Миграция v3 не удаляет старые записи: новые поля старого кэша остаются NULL, и такие
вкладки не выдаются до нового полного snapshot. Legacy HMAC hash сохраняется инертным,
не используется для проверки и не записывается новыми привязками. Для старой установки
без публичного ключа нужна новая привязка. UserRef хранится отдельно для каждой пары
владелец + установка, стабилен после входов/перезапусков и не равен Telegram ID.
Будущий переход на protocol 3 должен сохранить приём 2.x минимум на 90 дней.

SQLite v4 архивирует прежнюю таблицу `commands` как `legacy_commands_v3` без изменения
её строк. Новый ledger использует дословные queued/accepted/executed/uncertain/rejected
и outcome, не прежнее отображение в failed. По решению владельца минимальные
ID/fingerprint/status живут не меньше установки; в v1 TTL нет, включая сохранённую
запись установки после отвязки. Старый ID не может стать новой командой. Audit — 30 дней.

SQLite v5 добавляет encrypted originals. Старые hash-only send/stop записи нельзя
восстановить из fingerprint: metadata показывает `replayUnavailable: legacy_payload_missing`.
Точное повторение исходного POST может безопасно дописать недостающее encrypted body,
но не отправляет его — replay ждёт следующего соединения. Терминальная команда тело
не восстанавливает. Старое read-действие восстанавливается из известных полей только
при совпадении fingerprint. Повреждённый ciphertext/неверный ключ блокируют отправку
с явным кодом; ни текст, ни expectedTurnId не угадываются.

Сервис предназначен для одного процесса: SQLite и presence/socket registry пока не
распределяются между несколькими инстансами. Запуск второго процесса с той же БД не поддерживается.
Резервировать БД следует штатными средствами SQLite/при остановленном процессе, с учётом WAL.

Зависимости минимальны: runtime `ws` нужен для серверного WebSocket upgrade, frame limits
и корректного RFC6455; встроенный Node WebSocket предоставляет только клиент.
Dev `typescript`, `@types/node`, `@types/ws` нужны только для строгой проверки типов.
HTTP, HTTPS, криптография, SQLite, тестовый runner и генерация случайных значений — Node built-ins.
