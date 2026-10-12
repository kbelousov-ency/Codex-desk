# Coder Portal и AI-tool-cli-proxy

Сверено 8 октября 2026 года по локальным копиям:

- `E:\My projects\Coder-Portal`, `master`, `df728e3`;
- `E:\My projects\AI-tool-cli-proxy`, `master`, `e4e215c`;
- Кузьмич — текущая рабочая ветка `main`.

Это справочная заметка для изменений Кузьмича. Portal и proxy не становятся частью сборки Кузьмича.

Итоговая архитектура Experimental 3 — вход в Portal и программное подключение обоих CLI — в [KUZMICH.md](KUZMICH.md); там же чеклист живой приёмки.

## Система целиком

### Coder Portal

Portal — внутренний BFF-портал: Keycloak SSO, httpOnly-сессия, выпуск персонального ключа `AI-tool-cli-proxy`, генерация конфигураций Claude/Codex/Kilo, статистика, entitlement и отдельный relay для удалённого Codex.

Основные точки: `Coder-Portal/backend/src/api/configs.py`, `Coder-Portal/backend/src/codexcfg.py`, `Coder-Portal/backend/src/api/connect.py`, `Coder-Portal/backend/src/api/relay.py`, `Coder-Portal/relay/agent.mjs`, `Coder-Portal/backend/src/relaysvc.py`.

### AI-tool-cli-proxy

Proxy — отдельный сервис маршрутизации модельного трафика, ключей, подписок, квот и леджера. Он не является Codex App Server.

```text
Кузьмич ?→ локальный codex app-server → router.encycam.com → модель
```

Gateway принимает HTTP/stream/WebSocket, проверяет ключ и каталог; core выбирает upstream-учётку и считает расход; `main_proxy` обслуживает людей, ключи и статистику. Основные точки: `AI-tool-cli-proxy/src/gateway/app.py`, `src/gateway/ws_bridge.py`, `src/gateway/catalog.py`, `src/core/legs/codex.py`, `src/codex_control/`, `src/me_api/router.py`, `src/me_api/ledger.py` и `router_service.py`.

## Codex-конфигурация Portal

`Coder-Portal/backend/src/codexcfg.py` строит персональный `config.toml`:

```toml
model_provider = "router"
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[model_providers.router]
name = "ENCY OmniRoute"
base_url = "https://router.encycam.com/v1"
experimental_bearer_token = "<персональный ключ>"
wire_api = "responses"
http_headers = { "x-openai-actor-authorization" = "ency-router" }
```

Проверенные правила:

- ключ идёт в `experimental_bearer_token`, не в `api_key`;
- `wire_api` — `responses`;
- Portal владеет только ограниченным набором верхнеуровневых полей и сохраняет остальные пользовательские настройки;
- MCP дописывается в `[mcp_servers.*]` и `http_headers`;
- `GET /api/config/codex` защищён portal-сессией.

Для Кузьмич нельзя бездумно заменять весь TOML и нельзя получать его из renderer. Нужны host-only preview, allowlist полей и передача профиля существующему `CodexClient` через временные `-c` overrides.

## Relay

Relay — отдельная функция удалённого управления, не обязательный transport локального чата. `Coder-Portal/relay/agent.mjs` запускает:

```text
codex app-server --listen ws://127.0.0.1:<port>
```

Поток: клиент → WS `/api/relay/client` → Portal → WS `/api/relay/agent` → relay-agent → локальный Codex App Server. Portal перекладывает JSON-RPC-кадры и не разбирает протокол; relay может ограничивать `thread/read`.

Кузьмич уже имеет локальный вариант: `electron/codex-client.mjs` запускает App Server через stdio, а `electron/window-session.mjs` управляет RPC, потоками, approvals, MCP и восстановлением. Relay не должен заменять этот transport.

## Каталог моделей

Proxy строит каталог по политике конкретного ключа:

- Codex IDs имеют prefix `cx/`, Claude IDs — `cc/`;
- варианты `-low`, `-medium`, `-high`, `-xhigh`, `-max`, `-ultra` могут приходить отдельными строками;
- gateway сворачивает варианты в базовую модель и отдаёт уровни в `capabilities.effort_tiers`;
- суффиксные IDs остаются допустимым путём запроса.

Кузьмич получает каталог через `model/list` App Server и пока имеет ручную добавку `gpt-6.1-sol` в `electron/window-session.mjs`. При интеграции нужна проверенная синхронизация с каталогом ключа без скрытой смены модели. Claude discovery включается через `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`; модели с окном 1M помечаются `[1m]`.

## Квоты и расход

Proxy различает `used_credits` (серверная отсечка), `remaining_credits` и `limit_credits` (квота), `ledger_used_credits` (наш леджер) и `last_24h.credits` (суточный расход, не доля недельной квоты).

`/v1/me/limit` отдаёт квоты, `/v1/me/overview` объединяет статус/reset/суточную статистику, `/v1/me/limit/agents` даёт расход по агентам. Кузьмич читает overview и limit в `electron/router-usage.mjs`, UI рисует их в `src/RouterUsage.tsx`. Нельзя смешивать `used_credits` с `ledger_used_credits` или заменять квоту суточным расходом; при наличии обоих показателей их лучше показывать раздельно.

## Границы безопасности

- Keycloak token не должен попадать в renderer.
- Router/API keys нельзя включать в snapshots, историю, diagnostics и UI-события.
- Секреты не передавать через argv, если доступен временный host-only config.
- Глобальный `config.toml` менять только с backup/CAS и подтверждением.
- Не заменять App Server прямыми вызовами модели и не редактировать SQLite Codex.
- Preview должен иметь TTL, generation/ownership и явное применение.

## План интеграции в Кузьмича

1. Добавить host-модуль `portal-connection` рядом с `electron/codex-connections.mjs`.
2. Определить browser/device flow Portal: `/api/config/codex` требует web-сессию.
3. Получать конфиг в main process и проверять origin, URL, provider и токен.
4. Показывать preview модели, URL, MCP и TTL, но не сам ключ.
5. Хранить credentials в существующем зашифрованном host-хранилище.
6. Собирать профиль `CodexClient` без полной замены `config.toml`.
7. При смене источника возобновлять тот же thread/session и сохранять черновик.
8. Добавить host/UI smoke-тесты preview, отказа, отмены, restart и секретов.
9. Оставить relay отдельной задачей после стабильной локальной интеграции.

## Не делать

- Не подключать renderer напрямую к `router.encycam.com`.
- Не считать Portal relay заменой `codex-client.mjs`.
- Не копировать в Кузьмича весь backend Portal, entitlement или админские ручки.
- Не использовать `/v1/connect/*` без проверки его kit-auth контракта.
- Не считать серверный каталог доказательством, что локальный CLI уже умеет модель без соответствующего provider/model mapping.
## Боцман

Проверено по локальным исходникам Coder-Portal 8 октября 2026 года:

- Windows-установщик выдаётся авторизованному пользователю через `POST /api/boatswain/connect`; ответ содержит одноразовый путь `/api/boatswain/setup/<token>.exe` и TTL 3600 секунд.
- Файл скачивается без cookie через `GET /api/boatswain/setup/<token>.exe`; повторная загрузка возможна до истечения токена.
- При первом запуске установщик обменивает токен через `POST /api/boatswain/claim/<token>` и получает Portal origin, Router URL и Router key. Кузьмич не читает `%LOCALAPPDATA%\Boatswain\boatswain.json`.
- Локального HTTP-порта нет: постоянный клиент использует `wss://<portal>/api/relay/boatswain` и Router key в заголовке `Authorization`.
- Состояние машин проверяется через `GET /api/relay/boatswain/machines`; нормализованные лимиты Codex/Claude — через `GET /api/relay/limits`.
- Для подключения конкретного CLI Portal использует `POST /api/boatswain/switch` и одноразовые product-specific connect tokens.

Исходники контракта: `Coder-Portal/backend/src/api/boatswain.py`, `Coder-Portal/backend/src/boatswainsvc.py`, `Coder-Portal/relay/boatswain/Setup.cs`, `Coder-Portal/relay/boatswain/Settings.cs`, `Coder-Portal/relay/boatswain/Link.cs`.

Установщик Кузьмич не встраивает `boatswain.exe` как статический файл: канонический поток требует Portal-сессии и одноразовой ссылки. Поэтому установка Боцмана должна выполняться из host-only Setup Wizard после авторизации через Portal; передавать Router key в renderer, argv, URL, snapshots или diagnostics нельзя.

`POST /api/boatswain/connect` (cookie Portal-сессии) и ручной путь «скачайте установщик в «Загрузки»» в Кузьмиче **не используются**: их заменил `/api/relay/boatswain/kuzmich/bootstrap` с Bearer-ключом, см. ниже. `electron/boatswain-client.mjs` остался только для чтений по ключу (`/api/relay/limits`, `/api/relay/boatswain/machines`), `electron/boatswain-setup.mjs` — только для состояния уже установленного Боцмана и чтения Claude-подключения.

## Experimental 3: автоматическая установка Кузьмича

Отклонено 2026-10-09: портал не меняем, см. KUZMICH_PLAN.md

Требование пользователя (9 октября 2026): внешний браузер не используется, приложение само скачивает всё необходимое, **от человека — только авторизация**. Поэтому поток такой:

1. Пользователь выбирает и при необходимости устанавливает нужные CLI (`setup:install`).
2. `GET /api/kuzmich/capabilities` — предварительная проверка; `version` должен быть `1`.
3. `POST /api/kuzmich/device` с `{host}` → `device_code`, `user_code` (`XXXX-XXXX` из алфавита без гласных), `verification_uri_complete`.
4. Кузьмич открывает `verification_uri_complete` **в своём окне** (`electron/portal-auth-window.mjs`): отдельный `partition`, `sandbox`, запрет разрешений и загрузок, навигация только по `https`. Адрес проверяется строго: origin портала, путь `/device`, единственный параметр `code`, равный `user_code`.
5. `POST /api/kuzmich/device/token` опрашивается по RFC 8628 (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`) → `{api_key, access}` один раз. Окно входа закрывается. Закрытие окна человеком = отмена, а не вечный опрос.
6. `POST /api/relay/boatswain/kuzmich/bootstrap` (Bearer) → `{version, access, download, sha256, size}`.
7. Кузьмич скачивает `/api/boatswain/setup/<token>.exe` сам, сверяет размер и SHA-256 и только после этого запускает `boatswain-setup-<token>.exe --kuzmich-setup <token>` — безоконная установка (`Setup.RunManaged`), код 0 только после выхода Боцмана на связь. Если Боцман уже установлен и онлайн, шаг пропускается.
8. `boatswain.exe --kuzmich-version` должен ответить `{"version":1}`, затем `--kuzmich-configure` печатает `GET /api/relay/boatswain/kuzmich/config` как есть.
9. Кузьмич валидирует `connections` по белому списку полей и пишет `config.toml` Codex и `settings.json` Claude Code с резервной копией каждого файла. Остальные настройки (MCP, права, прочие env) сохраняются; `ANTHROPIC_API_KEY` удаляется, иначе он перебил бы ключ роутера.
10. Для настроенных агентов обновляется `connectionSource: 'router'`, Claude-подключение попадает в `routerConnections`, вкладки переподключаются.

Router key живёт только в main process: в renderer уходят лишь `stage`, `message`, `providers`, `userCode`, `loginOpen`.

Claude настраивается только если Portal выдал `connections.claude`. Если доступен только Codex, настраивается Codex, и установка завершается успешно.

### Чего ещё нет на проде

Проверено 9 октября 2026: `GET https://coder-portal.encycam.com/api/kuzmich/capabilities` → **404**. В локальном `Coder-Portal` (`df728e3`) `backend/src/api/kuzmich.py`, `backend/tests/test_kuzmich.py` и `relay/boatswain/Kuzmich.cs` ещё **не закоммичены**, а установленный `boatswain.exe` (сборка от 9 октября) команд `--kuzmich-*` не имеет: `--kuzmich-version` завершается кодом 0 без вывода, то есть падает в обычный путь трея. Поэтому сквозная проверка потока невозможна до выката Portal и Боцмана; на непригодном портале Кузьмич показывает «Portal пока не поддерживает автоматическую установку».

Отдельная замеченная щель на стороне Portal: `kuzmich._claude_connection` отдаёт только `baseUrl`, `apiKey`, `modelAliases` и `modelNames`, без `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, `ENABLE_PROMPT_CACHING_1H`, `ENABLE_TOOL_SEARCH` и `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, которые есть в `claudecfg.env`. Кузьмич их не додумывает: набор env принадлежит Portal.
