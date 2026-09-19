# Импорт MCP из текста

Запрос: пользователь вставляет TOML вроде `[mcp_servers.atlassian]` и `[mcp_servers.atlassian.http_headers]`, приложение добавляет подключения в конфигурацию установленного Codex. Ранее приложение не писало config.toml; по этому запросу добавлена явная операция импорта. Модель/effort, авторизация, провайдер и другие разделы не заменяются. Примерный адрес/токен пользователя не зашит в исходники и не добавлялся в его реальную конфигурацию во время разработки.

## Поток и UI

`McpSettings.tsx` / `mcp-settings.css` находится в начале существующего окна настроек. Список показывает только базовый пользовательский слой: имя, transport, очищенный адрес, enabled, названия headers/env без значений. Импорт: «Добавить из текста» → «Проверить текст» → предпросмотр → «Сохранить MCP». Для совпадающих имён требуется checkbox «Обновить существующие серверы»: заменяется целиком только выбранный server, включая удаление старых параметров другого transport. Cancel не пишет файл. Исходный textarea очищается сразу при preview, закрытии/смене вкладки; ошибки parser не содержат исходный фрагмент.

После сохранения показывается путь резервной копии. Применение/проверка подключения — отдельные действия, не автоматический запуск инструментов. Текущая вкладка перечитывает MCP через `config/mcpServer/reload`, затем проверка читает `mcpServerStatus/list` с `detail:'toolsAndAuthOnly'`. Ответ в renderer содержит только name/authStatus/runtimeStatus/toolCount. Неизвестный runtimeStatus не объявляется успехом. Модель, effort, thread ID, черновик и вложения сохраняются. Другие процессы вкладок/внешнего CLI нужно обновлять отдельно; новые читают конфиг при запуске.

Busy/pending mutation/boot/approval/compact/terminal → deferred без скрытой очереди: пользователь нажимает снова после завершения. `WindowSession.mcpRefreshing` резервирует обновление синхронно и блокирует старт нового хода/терминала. События `type:'mcp'` инвалидируют кэш и автопинг. Ни `turn/start`, ни MCP tool call при импорте/проверке не используются.

## Host и запись

`McpConfigService` создаёт отдельный CodexClient из executable/cwd своей сессии. Полная конфигурация и диагностика служебного процесса не публикуются в renderer/chat. Замена CLI/cwd, stop и dispose уничтожают service и pending preview. Scoped IPC: `getMcpConfig`, `previewMcpImport`, `saveMcpImport`, `reloadMcp`, `checkMcp`; generic RPC allowlist не расширяется до записи произвольного конфига.

`McpConfigManager` получает `config/read {includeLayers:true}` и выбирает единственный доступный `name.type:'user'`, `profile:null` (отсутствующее поле также допустимо), `name.file` + version. Путь не вычисляется из home предположительно: используется ответ Codex. Слой disabled/отсутствующий/неоднозначный → ошибка без записи.

TOML разбирается `@iarna/toml@2.2.5`. Каноническая структура содержит только корневой `mcp_servers`, 1…100 серверов, максимум 256 КБ текста, имена `[a-zA-Z0-9_-]{1,128}`. HTTP: url/http_headers/env_http_headers/bearer_token_env_var/auth; stdio: command/args/env/env_vars/cwd. Общие: enabled/required/startup_timeout_sec/tool_timeout_sec/enabled_tools/disabled_tools/default_tools_approval_mode/tools. Неизвестные поля отклоняются с именем поля, без его значения. Credentials/query/fragment URL, args, header/env values не возвращаются в preview. Таймер preview 10 минут, одноразовый UUID token, secrets хранятся только в памяти host до истечения/нового preview/dispose.

Preview сохраняет version и SHA-256 исходных bytes. Save повторно читает config/layer/bytes, требует тот же путь/version/hash, при конфликтах требует replaceExisting:true. Перед записью исходные bytes сохраняются `config.toml.backup-<timestamp>-<uuid>` с `wx`, mode 0600. Если исходного файла нет, backupPath=null. Ошибка backup прекращает операцию. Резервные копии могут содержать секреты и автоматически не удаляются.

Запись через native `config/batchWrite`: edits по `mcp_servers.NAME`, mergeStrategy:'replace', filePath базового user слоя, expectedVersion, reloadUserConfig:false. Это атомарная запись Codex с защитой от изменения после preflight. Неподтверждённая/ошибочная запись инвалидирует preview, возвращает общее сообщение без raw error. `okOverridden` сообщает о переопределении другим уровнем без раскрытия metadata. Никакого ручного regex-дописания TOML, правки SQLite или перезаписи глобального объекта config.

Упаковка теперь включает host dependency `@iarna/toml`: `scripts/package.mjs` копирует parser в staged node_modules и записывает его в минимальный manifest. Старое утверждение «main использует только Node/Electron» больше не полное; прежняя причина staging (исключить артефакты корня из сканирования) сохраняется.

## Источники и проверки

Проверены https://developers.openai.com/codex/mcp/ и https://developers.openai.com/codex/app-server/, локальные ConfigReadResponse/ConfigLayerSource/ConfigBatchWriteParams/MergeStrategy/ConfigWriteResponse и MCP status schemas. Официальные страницы сохранены в `artifacts/mcp-doc.html` / `mcp-app-server-doc.html`.

- `tests/mcp-config.test.mjs`: parse/validation/redaction, multiple imports, conflicts, exact backup, missing config, stale/replayed/expired previews, native error masking и CAS parameters.
- `tests/mcp-runtime.test.mjs` / preload tests: scoped IPC, busy deferral, synchronous reservation, filtered inventory and recovery.
- `test:mcp`: renderer fake bridges, secrets cleared, confirmation/cancel/errors, same-dialog state.
- `test:mcp-host`: Electron/preload/IPC + отдельные JSONL-процессы и временный CODEX_HOME. Реальный пользовательский config не затрагивается. Поддержан CODEX_DESK_PACKAGED.
- `test:mcp-native`: установленный Codex в отдельном CODEX_HOME под artifacts. Все MCP disabled, без model turns; подтверждены native replace, сохранность комментариев/модели/effort/других MCP, backup, detection внешнего изменения до snapshot и native expectedVersion при изменении после snapshot. Артефакт `artifacts/mcp-native-KpRSxv`.

Подключение к корпоративному серверу пользователя не проверялось. Предоставленный в разговоре токен не копировался в код/тесты/документы.

Поставка 2026-09-17: 110 Node-тестов, build, `test:mcp`, регрессии архива и кэша прошли. `npm.cmd run package -- --config.directories.output=release/mcp-settings` обновил exe и active-build. Packaged `test:mcp-host` прошёл (`artifacts/mcp-host-mruP9i`), встроенный TOML parser доступен. Все host/preload и dist assets в app.asar сверены побайтно. Настоящий packaged bootstrap подтвердил 6 моделей, Astra/Ultra и PNG без model turn. Пользовательские config/история не менялись; запущенное пользовательское окно не закрывалось.

## JSON из корпоративной инструкции

Следующий пример пользователя был JSON `{ "mcpServers": { "имя": { "type": "http", "url": "…", "headers": { … } } }`. Первая версия принимала только TOML, поэтому выдавала «Некорректный TOML, строка 1» ещё до подключения. Это ограничение импортера, не ошибка MCP-сервера. Первая попытка исправления была заблокирована служебной ошибкой среды `helper_sandbox_lock_failed / SetNamedSecurityInfoW … 5`; изменение выполнено после восстановления среды.

`normalizeJsonImport` преобразует единственный корневой `mcpServers` в `mcp_servers`, `headers` — в `http_headers`. Типы `http`/`streamable-http` требуют url без command; `stdio` требует command без url. Опциональный type удаляется только после проверки, остальные поля проходят прежний канонический validator. Без type транспорт определяется по url/command. Одновременные headers/http_headers, неизвестный type, лишние разделы, неверные объекты/значения отклоняются; неизвестные настройки не теряются молча.

Парсер распознаёт raw JSON по начальной `{`, поддерживает BOM/пробелы и markdown fences json/toml без изменения TOML-совместимости. JSON.parse error не выводится пользователю: он может цитировать секрет из входа. Внешние словари создаются с null prototype; пользовательские ключи не меняют прототип объекта. Значения заголовков/аргументов/env остаются буквальными; переменные не раскрываются, локальные команды на этапе preview не выполняются. Путь записи, backups, CAS, ограничения и явное сохранение общие для обоих форматов. Вставленный пользовательский токен не используется в fixtures и не записывается в реальный config во время проверки.

Проверка JSON-исправления: 114 Node-тестов и `test:mcp` прошли. Native smoke с JSON HTTP/stdio в отдельном CODEX_HOME подтвердил запись штатным Codex и прежнюю TOML-совместимость (`artifacts/mcp-native-zltlNX`, все серверы disabled). Готовая сборка `release/mcp-json/win-unpacked/Codex Desk.exe` прошла `test:mcp-host` (`artifacts/mcp-host-8uQ6mT`); активный путь обновлён упаковкой. Host/preload/dist и наличие TOML parser в app.asar проверены. Корпоративный сервер не вызывался, пользовательские конфиг и история не менялись.

## Формы подключений (elicitation) — 2026-09-19

Раньше запрос `mcpServer/elicitation/request` можно было только отклонить. Теперь карточка «Запрос от подключения» рендерит форму по `requestedSchema` (плоский объект примитивов MCP 2025-11-25, типы из `protocol/v2/McpElicitation*.ts`): строки с `format` email/uri/date/date-time и границами длины, number/integer с minimum/maximum, boolean, одиночный выбор (`enum`+`enumNames` или `oneOf` const/title) и множественный выбор (`array` с `items.enum`/`items.anyOf`, minItems/maxItems). Обязательные поля отмечены; невалидная форма не отправляется и показывает ошибки у полей. Значения по умолчанию из схемы подставляются.

Ответ `{ action: 'accept', content, _meta: null }` содержит только введённые значения (числа — числами, множественный выбор — массивом). «Отклонить» и «Отменить» отправляют `decline`/`cancel` без content. Режим `url` показывает адрес и ждёт явного «Готово»; оболочка не открывает ссылку сама. Схемы `openai/form`/`openaiForm` рендерятся тем же способом, если укладываются в примитивы, иначе показывается JSON и доступен только отказ. Данные передаются исключительно этому serverRequest и не попадают в текст сообщения.

Проверка: `scripts/ui-scenarios.mjs` — форма с required/oneOf/integer/boolean/array, отказ невалидной отправки, точный content принятого ответа и decline для url-режима. Настоящих MCP-серверов и модели сценарий не вызывает.
