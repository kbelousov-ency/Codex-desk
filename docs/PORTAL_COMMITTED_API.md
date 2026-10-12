# Закоммиченный контракт ручек Coder Portal (для Кузьмича)

Задача В1 плана [KUZMICH_PLAN.md](KUZMICH_PLAN.md). Документ описывает **только то, что
закоммичено** в `E:\My projects\Coder-Portal` и, следовательно, живёт на проде
`coder-portal.encycam.com`.

**Источник истины.** Всё ниже прочитано через `git show HEAD:<путь>` в
`E:\My projects\Coder-Portal`, `HEAD = df728e34ec5d08f0683e17ea0219925f7ede0e9d`
(«Боцман: починил сбой сертификата при переносе в лоцию»). Рабочая копия портала не
читалась (её откатывают параллельно), репозиторий не изменялся. Ссылки вида
`backend/src/api/me.py:33` — это строки **в этом коммите**.

Незакоммиченного контракта Кузьмича (`api/kuzmich.py`, `relay/boatswain/Kuzmich.cs`,
`/api/relay/boatswain/kuzmich/*`) в HEAD **нет** — проверено `git ls-tree -r HEAD`.
Ничего из раздела «Experimental 3» в [PORTAL_INTEGRATION.md](PORTAL_INTEGRATION.md)
использовать нельзя.

---

## 0. Общие правила: сессия, CSRF, формат ошибок

### Cookie-сессия

| Что | Значение | Где |
|---|---|---|
| Имя cookie | `coder_session` (перебивается `COOKIE_NAME`) | `backend/src/config.py:94` |
| Тип | подписанный **httpOnly** cookie Starlette `SessionMiddleware`, токен Keycloak внутрь не кладётся | `backend/src/main.py:119-126`, `backend/src/auth/routes.py:1-6` |
| `SameSite` | `lax` — обязателен, иначе возврат с Keycloak (cross-site 302) не донесёт cookie | `backend/src/main.py:122` |
| `Secure` | `COOKIE_SECURE`, по умолчанию = `APP_BASE_URL.startswith("https://")` → на проде **да** | `backend/src/config.py:93` |
| Время жизни | `SESSION_MAX_AGE`, по умолчанию **8 часов** (`8*60*60`) | `backend/src/config.py:91`, передаётся в `max_age` — `backend/src/main.py:125` |
| Подпись | `SESSION_SECRET`; пусто → предупреждение в лог и `"dev-insecure-secret-change-me"` | `backend/src/config.py:90`, `backend/src/main.py:91-92,121` |
| Содержимое | `session["user"] = {email, login_email, name, sub}`, плюс `session["id_token"]` для RP-logout и временный `session["next"]` | `backend/src/auth/routes.py:118-125`, `:77` |
| Публичный адрес | `APP_BASE_URL` (`http://localhost:8080` по умолчанию) | `backend/src/config.py:57` |

`max_age` у `SessionMiddleware` — это и срок cookie, и `max_age` проверки подписи:
просроченный cookie отвергается сервером, даже если браузер его прислал. Является ли
окно скользящим (Starlette переставляет `Set-Cookie` на каждом ответе с непустой
сессией), **по коду Starlette в этой задаче не проверялось** — считать это фактом
нельзя, см. «Открытые риски».

### CSRF: заголовок `X-Requested-With`

`csrf_guard` — HTTP-middleware (`backend/src/main.py:147-167`):

- срабатывает только на `POST`/`PUT`/`PATCH`/`DELETE` **и** только на путях
  `/api/*` (`main.py:155-159`);
- если заголовка `x-requested-with` нет (любое непустое значение годится — проверяется
  лишь присутствие, `main.py:161`) → **403**, тело
  `{"type":"error","error":{"type":"csrf","message":"Missing X-Requested-With header"}}`
  (`main.py:162-166`);
- фронт портала ставит `X-Requested-With: fetch` (`frontend/src/api/client.ts:17`) и
  `credentials: 'include'` (`:28`).

Исключения:

- `CSRF_EXEMPT_PATHS = {"/api/v1/upload_pulse", "/api/device/codex", "/api/device/codex/token", "/api/plane/sync"}`
  — `backend/src/main.py:136-138`;
- `CSRF_EXEMPT_PREFIXES = ("/api/relay/",)` — **вся ветка релея/Боцмана**,
  `backend/src/main.py:144`.

**Вывод для Кузьмича:** любая cookie-мутация (`POST /api/key`,
`POST /api/connect/{product}`, `POST /api/boatswain/connect`, `POST /api/boatswain/switch`)
обязана нести `X-Requested-With`. GET-ручки (`/api/me`, `/api/config/codex`,
`/api/config/claude`, `/api/key`, `/api/cabinet`) заголовка **не требуют** — но
ставить его безвредно.

### Два разных формата ошибок

1. **Любой `HTTPException`** портала конструируется как
   `HTTPException(status_code=…, detail={"type":"error","error":{"type":…,"message":…}})`
   (например `backend/src/api/configs.py:33-39`). FastAPI оборачивает это в `detail`,
   поэтому на проводе:
   ```json
   {"detail": {"type": "error", "error": {"type": "no_key", "message": "Сначала получите API-ключ"}}}
   ```
2. **`csrf_guard`** и **device-flow** отдают `JSONResponse` напрямую, **без** обёртки
   `detail`: `{"type":"error","error":{…}}` (`main.py:162-166`) и `{"error":"access_denied"}`
   (`backend/src/api/device.py:63`).

Фронт портала разбирает оба варианта: `j?.error?.message || j?.detail?.error?.message`
(`frontend/src/api/client.ts:33`). Кузьмич должен делать то же.

### Нет сессии

`get_current_user` (`backend/src/deps.py:14-28`) — единственная зависимость всех
`/api/*`-ручек кабинета. Без `session["user"]["email"]` → **401**
`{"detail":{"type":"error","error":{"type":"not_authenticated","message":"Требуется вход через SSO"}}}`
(`deps.py:21-27`). Это JSON-401, **не** редирект на страницу входа — значит, детект
«вход слетел» по коду ответа надёжен.

---

## 1. Вход: `/auth/*`

Роутер без префикса `/api`, на него `csrf_guard` не распространяется
(`backend/src/auth/routes.py:23`, подключение — `backend/src/main.py:176`).

### `GET /auth/login`

| | |
|---|---|
| Авторизация | не нужна (это и есть вход) |
| Параметры | `switch` (`1/true/yes` → `prompt=login`, `routes.py:33-35,79`), `next` (куда вернуть; только локальный путь, `_local_path` — `routes.py:49-54,77`) |
| Ответ | **302** на Keycloak (`authorize_redirect`, `routes.py:80`); `redirect_uri = f"{APP_BASE_URL}/auth/callback"` (`routes.py:78`) |
| Побочный эффект | Authlib кладёт `state`+PKCE в ту же сессию-cookie (`routes.py:59`) |
| Ошибка | **503** `not_configured`, если `KEYCLOAK_*` не заданы (`routes.py:38-46`) |

Лазейка `TEST_LOGIN_EMAIL` (`routes.py:26-30,66-73`) работает **только** при
`COOKIE_SECURE=false` и хосте `127.0.0.1/localhost/::1` — на проде недоступна.

### `GET /auth/callback`

| | |
|---|---|
| Авторизация | state/PKCE из cookie |
| Поведение | обмен кода на токены (`routes.py:88`), проверка домена email по `ALLOWED_EMAIL_DOMAINS` (`config.py:143-162`, вызов `routes.py:109`), запись `session["user"]` (`routes.py:118-123`) |
| Ответ | **302** на `session.pop("next")` или `/` (`routes.py:131`) |
| Отказы | `OAuthError` (протухший state) → **302** `/auth/login` (`routes.py:92`); нет email → **502** `no_email` (`routes.py:98-104`); домен не разрешён → `session.clear()` + **302** `/?auth_error=email_domain` (`routes.py:109-112`) |

Важно: `email` сессии может **отличаться** от `login_email` — `identitysvc.account_email`
сводит второй вход того же человека на основной аккаунт (`routes.py:114-123`).

### `GET /auth/logout`

Чистит сессию и, если Keycloak сконфигурирован, редиректит на его `end_session_endpoint`
с `post_logout_redirect_uri={APP_BASE_URL}/` и `id_token_hint`
(`routes.py:134-155`). То есть локальный выход — побочный эффект **GET-редиректа**, без CSRF.

### Как программно понять «вход выполнен» и кем

Единственный надёжный способ в закоммиченном коде — **`GET /api/me`** (см. §2).
Цепочка окна входа:

```
окно → GET {APP_BASE_URL}/auth/login?next=/        (302 на Keycloak)
     → … форма Keycloak (единственное действие человека) …
     → GET {APP_BASE_URL}/auth/callback?code=…     (302, Set-Cookie coder_session)
     → GET {APP_BASE_URL}/api/me                   (200 → вошли; 401 → нет)
```

Редиректов на чужие хосты по `next` не будет: `_local_path` отбрасывает всё, что не
начинается с одного `/` (`routes.py:49-54`).

---

## 2. «Кто я»: `GET /api/me` — лучшая ручка детекта входа

`backend/src/api/me.py:17-45`, роутер `prefix="/api"` (`me.py:14`), подключён
`main.py:177`.

| | |
|---|---|
| Метод/путь | `GET /api/me` |
| Авторизация | **cookie-сессия** (`Depends(get_current_user)`, `me.py:19`) |
| Заголовки | ничего обязательного (GET → CSRF не применяется) |
| Тело | нет |

**Точная форма ответа** (`me.py:33-45`):

```ts
{
  email: string            // почта основного аккаунта (не обязательно login_email)
  name: string             // name из Keycloak или email
  has_key: boolean         // есть неотозванная запись ключа
  key_approved: boolean | null   // null, если ключа нет
  is_admin: boolean
  is_superadmin: boolean
  rights: string[]         // sorted
  entitlements: {          // ключи: "codex", "claude"
    [product: string]: {
      product: string
      enabled: boolean            // РЕШЕНИЕ root для этого продукта
      configured_enabled: boolean // портальный переключатель, НЕ право доступа
      access_source: "shared" | "none" | null
      access_reason: string | null   // "product_disabled", "unknown_access_state", …
      desired_enabled: boolean | null
      control_state: string          // "NONE", если пусто
      control_pending: boolean
      control_error: string | null
      activated_at: string | null
      expires_at: string | null
      updated_at: string | null
    }
  }
}
```

Форма `entitlements[*]` — `entitlementsvc.entitlement_dict` (`backend/src/entitlementsvc.py:220-242`);
`enabled` берётся из ответа root (`access_for_user`, `:170-177`), а не из локального флага.

**Побочные эффекты (важно!)** `/api/me` не только читает: он регистрирует пользователя
(`adminsvc.ensure_user`, `me.py:24`), пишет факт входа (`identitysvc.record_login`,
`me.py:27`), создаёт строки entitlement (`me.py:28`) и **ходит в root** за доступом
(`me.py:30`). То есть это не бесплатный health-check — дёргать его в цикле не нужно.

Ошибка: **401** `not_authenticated` (`deps.py:21-27`).

### Альтернатива: `GET /api/cabinet`

`backend/src/api/cabinet.py:38-81`, cookie-сессия. Отвечает `email`, `name`,
`key: {state, held_by, key_name, created_at}` (`state` ∈ `active|pending|none|held_elsewhere`,
`cabinet.py:32-35`), `seat`/`seat_error` и по каждому продукту
`{available: boolean, connected: статус последнего удачного подключения | null}`
(`cabinet.py:69-74`). `available = ключ одобрен И access.enabled` — удобный
однозначный флаг «можно подключать».

**Чем лучше для детекта входа:** `/api/me` — потому что он возвращает `email`, `has_key`,
`key_approved` и `entitlements` одним вызовом и не зависит от доступности
пользовательского API роутера (`/api/cabinet` дополнительно ходит в `mesvc` за `seat`,
`cabinet.py:75-80`). Для «можно ли подключать» удобнее `/api/cabinet.{codex,claude}.available`.

---

## 3. Свой ключ роутера: `/api/key`

`backend/src/api/keys.py`, роутер `prefix="/api"` (`keys.py:15`), подключён `main.py:178`.

### `GET /api/key` — получить СВОЙ ключ по сессии

| | |
|---|---|
| Метод/путь | `GET /api/key` (`keys.py:67-87`) |
| Авторизация | **cookie-сессия** (`Depends(get_current_user)`, `keys.py:69`) |
| Обязательные заголовки | нет (GET → CSRF не применяется) |
| Тело запроса | нет |

**Точная форма ответа — два разных объекта, различать по `has_key`.**

Ключ есть (`keys.py:81-87`):

```ts
{
  has_key: true,
  api_key: string,     // РАСШИФРОВАННЫЙ персональный ключ роутера (decrypt(rec.api_key_enc))
  key_name: string,    // rec.omniroute_key_name — имя ключа у роутера
  created_at: string,  // ISO
  approved: boolean    // rec.approved_at is not None
}
```

Ключа нет (`keys.py:80`):

```ts
{ has_key: false, held_by: string | null }   // held_by — почта, на которой ключ уже выдан
```

`held_by` считает `identitysvc.other_key_holder(session, email, sub)` (`keys.py:79`):
это второй вход того же человека, у которого ключ лежит на другой почте.

**Когда 404 / 409.** `GET /api/key` **не отдаёт ни 404, ни 409 никогда** — в
`keys.py:67-87` нет ни одного `raise`. Отсутствие ключа — это **200** с
`has_key: false`, а не 404. Единственный отказ — **401** `not_authenticated` от
`get_current_user` (`deps.py:21-27`), если cookie нет или она просрочена. 404 от этого
пути можно получить только как «маршрута нет» (чужой путь), а 405 — другим методом.

`keysvc.get_existing` отдаёт запись, если она есть и **не отозвана**; `approved_at`
здесь не проверяется (`backend/src/keysvc.py:37-41`). Значит, `GET /api/key` может
вернуть ключ с `approved: false` — такой ключ **не работает** ни в роутере, ни в дверях
релея: `keysvc.owner_of` пропускает только записи с непустым `approved_at`
(`keysvc.py:50-70`, условие на `:62`). Проверять `approved` обязательно.

### `POST /api/key` — выдать ключ (идемпотентно)

| | |
|---|---|
| Метод/путь | `POST /api/key` (`keys.py:32-64`) |
| Авторизация | **cookie-сессия** (`keys.py:34`) |
| Обязательные заголовки | **`X-Requested-With`** — мутация `/api/*`, пути нет в исключениях (`main.py:136-138,155-159`) |
| Тело запроса | **нет** (ручка не принимает `Body`) |

Ответ **200** (`keys.py:58-64`):

```ts
{
  api_key: string,     // сырой ключ
  key_name: string,    // rec.omniroute_key_name
  created_at: string,  // ISO
  reused: boolean,     // true — ключ уже был, выдан тот же
  approved: boolean    // rec.approved_at is not None
}
```

Повторный вызов идемпотентен и отдаёт тот же ключ с `reused: true`
(`keys.py:37`, `keysvc.get_or_create` `:98-113`).

**Когда 404 / 409.**

- **404 — никогда.** В `keys.py:32-64` нет ни одного `raise` с 404.
- **409 `key_on_other_email`** — единственный отказ самой ручки (`keys.py:18-29`,
  бросается на `:47-50`): ключа на этой почте нет, но `identitysvc.other_key_holder`
  нашёл ключ того же человека (по `sub` из Keycloak) на **другой** почте. Тело:
  ```json
  {"detail":{"type":"error","error":{
     "type":"key_on_other_email",
     "message":"На вас уже выдан ключ на почту <почта>. Войдите под ней. Если это не вы - напишите в поддержку роутера.",
     "email":"<почта>"}}}
  ```
  Поле `email` — машиночитаемая подсказка, под какой почтой входить.
- **403 `csrf`** без `X-Requested-With` (тело **без** обёртки `detail`, `main.py:162-166`).
- **401 `not_authenticated`** без сессии.
- Прочие 5xx — сбой создания ключа на стороне роутера (`keysvc.get_or_create` ходит
  в `proxy_create_key`, `keysvc.py:116-120`); отдельного типизированного кода у него нет.

Критично: не-админу ключ выдаётся **на паузе** — `approved: false` (`keys.py:37-46`,
`keysvc.get_or_create` `:98-107`). `auto_approve` = `adminsvc.is_admin(...)`
(`keys.py:51`). Пока админ портала не снимет паузу, ключ не работает, и его блокируют
`POST /api/connect/*` (`connect.py:90-92`), `POST /api/boatswain/connect`
(`boatswain.py:341-343`) и все двери `/api/relay/*` (`keysvc.owner_of` `:62`).

Побочный эффект: `POST /api/key` ставит задачу назначения ключа в control plane
(`codexcontrol.queue_new_key_assignment`, `keys.py:55-57`) — вызывать его в цикле нельзя.

---

## 4. Конфигурации по cookie: `/api/config/{codex,claude}`

`backend/src/api/configs.py`, роутер `prefix="/api/config"` (`configs.py:28`), подключён
`main.py:184`. Общие стражи:

- `_require_key` → **409** `no_key` «Сначала получите API-ключ», если записи ключа нет
  (`configs.py:31-39`). **`approved_at` здесь не проверяется** — конфиг выдаётся и по
  неодобренному ключу;
- `_require_product` → **403** `product_disabled` «{product} выключен для этого ключа.»,
  если `effective_access(...)["enabled"]` ложно (`configs.py:42-53`).

### `GET /api/config/codex`

| | |
|---|---|
| Путь | `GET /api/config/codex` (`configs.py:106-147`) |
| Авторизация | **cookie-сессия** (`configs.py:114`) |
| Заголовки запроса | нет обязательных |
| Query | `scope` ∈ `local|global`, **по умолчанию `global`** (`configs.py:109-113`) |
| Заголовок ответа | `Cache-Control: no-store` — в теле персональные bearer'ы MCP (`configs.py:128`) |
| Проверки | ключ (`configs.py:130-132`) + продукт `codex` (`:132`) |

Ответ (`configs.py:137-147`):

```ts
{
  filename: "config.toml" | "router.config.toml",      // local → router.config.toml
  path: string,        // "%USERPROFILE%\\.codex\\config.toml" (в коде двойные слэши, см. ниже)
  scope: "local" | "global",
  config_text: string, // ГОТОВЫЙ ТЕКСТ TOML
  mcp_servers: string[]// sorted имена серверов, попавших в файл
}
```

**Ключ внутри есть.** `config_text` собирается `codexcfg.build(api_key, f"{OMNIROUTE_PUBLIC_URL}/v1", servers)`
(`configs.py:135`) и содержит строку
`experimental_bearer_token = "<персональный ключ>"` (`backend/src/codexcfg.py:86-105`,
конкретно `:99`). Отдельного поля `api_key` в ответе **нет** — ключ надо вынимать из
TOML или брать из `GET /api/key`.

Состав `config_text` (`codexcfg.build` `:226-232`):

- верхний уровень `codexcfg.TOP_LEVEL` (`codexcfg.py:70-77`): `model = "gpt-5.6-terra"`,
  `model_provider = "router"`, `model_context_window = 1000000`,
  `model_auto_compact_token_limit = 900000`, `model_reasoning_summary = "detailed"`,
  `hide_agent_reasoning = false`;
- таблица `[model_providers.router]` (`codexcfg.py:86-105`): `name = "ENCY OmniRoute"`,
  `base_url`, `experimental_bearer_token`, `wire_api = "responses"`,
  `requires_openai_auth = false`, `supports_websockets = true`,
  `supports_standalone_web_search = true`,
  `http_headers = { "x-openai-actor-authorization" = "ency-router" }`;
- секции `[mcp_servers.*]` + `[mcp_servers.*.http_headers]` (`codexcfg.mcp_block` `:43-64`);
  `lotsia` дополнительно получает `default_tools_approval_mode = "approve"` (`:30-31,56-57`).

`build` **не** содержит маркер `codexcfg.MARKER` и не сводит чужой конфиг — это делает
`codexcfg.merge` (`:188-195`), которой пользуется скрипт подключения, а не эта ручка.
Эталон «какие строки наши» — `TOP_LEVEL` (`:154`) и `owned_tables` (`:133-135`);
`keep_foreign` (`:142-176`) — эталонный разбор чужого конфига, его обязаны повторять
любые свои мержи.

Замечание по полю `path`: в коде оно записано как
`r"%USERPROFILE%\\.codex\\config.toml"` — raw-строка с **двойными** обратными слэшами
(`configs.py:139-143`), то есть на проводе приедет `%USERPROFILE%\\.codex\\config.toml`.
Путь — подпись для человека; на него нельзя опираться как на реальный путь файла.

### `GET /api/config/claude`

| | |
|---|---|
| Путь | `GET /api/config/claude` (`configs.py:56-103`) |
| Авторизация | **cookie-сессия** (`configs.py:61`) |
| Заголовки запроса | нет обязательных |
| Query | `thinking: bool = false` (`configs.py:58`); `scope` ∈ `local|global`, **по умолчанию `local`** (`configs.py:59-60`) |
| Заголовки ответа | `Cache-Control` **не** ставится (в отличие от codex/kilo/mcp) — хотя в теле ключ |
| Проверки | ключ (`configs.py:73-74`) + продукт `claude` (`:75`) |

Ответ (`configs.py:98-103`):

```ts
{
  filename: "settings.json",
  path: "%USERPROFILE%\\.claude\\settings.json" | ".claude/settings.json",
  scope: "local" | "global",
  settings: {                      // ГОТОВОЕ СОДЕРЖИМОЕ settings.json
    alwaysThinkingEnabled?: true,  // только при thinking=1 (configs.py:82)
    env: { …см. ниже… },
    // только при scope=global (configs.py:88-93):
    autoUpdatesChannel?: "latest",
    effortLevel?: "medium",
    model?: "opus"
  }
}
```

**Ключ внутри есть** — в `settings.env.ANTHROPIC_AUTH_TOKEN`
(`claudecfg.env`, `backend/src/claudecfg.py:88-91`). Отдельного поля `api_key` нет.

`settings.env` — ровно `claudecfg.env(api_key, await claudecfg.model_ids(api_key))`
(`configs.py:78`), то есть (`claudecfg.py:77-108`):

| Переменная | Значение |
|---|---|
| `ANTHROPIC_BASE_URL` | `OMNIROUTE_PUBLIC_URL` (`config.py:115-117`) — **без** `/v1` |
| `ANTHROPIC_AUTH_TOKEN` | персональный ключ роутера |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` / `…_NAME` | `cc/<модель>[1m]` / «Opus 5» — только если такая модель открыта (`claudecfg.py:81-87`) |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` / `…_NAME` | то же для `fable` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` / `…_NAME` | всегда (откат на `CLAUDE_MODEL_SONNET`) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `…_NAME` | всегда (откат на `CLAUDE_MODEL_HAIKU`) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `"1"` |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `"1"` |
| `ENABLE_PROMPT_CACHING_1H` | `"1"` |
| `ENABLE_TOOL_SEARCH` | `"true"` |

`ANTHROPIC_SMALL_FAST_MODEL` намеренно не задаётся (`claudecfg.py:96-100`).
Список моделей берётся у роутера личным ключом (`claudecfg.model_ids` `:55-66`,
`mesvc.get(api_key, "/models")`); при `MeUnavailable` — откат на каталог (`:62-66`),
то есть ручка не падает.

**Чего в ответе НЕТ, а скрипт подключения делает:** снятия чужих переменных.
`claudecfg.FOREIGN_AUTH = ("ANTHROPIC_API_KEY",)` (`claudecfg.py:24`) и
`claudecfg.CLEARED` (`:28-34`: `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`,
`…_OPUS_MODEL_NAME`, `…_FABLE_MODEL`, `…_FABLE_MODEL_NAME`) — это список, который
**скрипт** вычищает перед записью (`connectscripts.render_claude` `:110,118`).
Кто пишет `settings.json` сам, обязан повторить это руками: `ANTHROPIC_API_KEY`
перебил бы наш `ANTHROPIC_AUTH_TOKEN` (`claudecfg.py:22-23`).

Настройки **приложения** Claude (не CLI) — `claudecfg.app(ids)` (`:111-140`):
`inferenceModels`, `toolSearchEnabled`, `coworkEgressAllowedHosts`, `claudeAiImport`.
Через `/api/config/claude` они **не отдаются** — только через скрипт подключения
(`connect.py:198`). Полный список ключей приложения — `claudecfg.APP_KEYS` (`:44-52`).

### Соседние ручки того же роутера

- `GET /api/config/mcp?names=a,b` (cookie, `configs.py:224-244`) → `{toml, claude_commands[], missing[]}`,
  `Cache-Control: no-store`. Пригодится, если MCP надо доставить без Боцмана.
- `GET /api/config/kilo` (`:150-216`), `GET /api/config/cline` (`:292-320`),
  `GET|POST /api/config/kilo/mcp[/ack|/reset]` (`:247-289`) — Кузьмичу не нужны.
  Заметка: `cline_config` требует продукт **`claude`** (`:300`) и отдаёт `api_key`
  отдельным полем (`:308`).

---

## 5. Подключение командой: `/api/connect/*`

`backend/src/api/connect.py`, роутер `prefix="/api/connect"` (`connect.py:41`),
подключён `main.py:181`. Две половины: кабинет по сессии выпускает токен, машина по
токену забирает скрипт (`connect.py:1-19`).

### `POST /api/connect/{product}` — выпустить команду

| | |
|---|---|
| Путь | `POST /api/connect/codex` или `POST /api/connect/claude` (`connect.py:105-114`) |
| `product` | только `codex`/`claude` (`connectsvc.PRODUCTS` `:26`), иначе **404** (`connect.py:57-60`) |
| Авторизация | **cookie-сессия** (`connect.py:108`) |
| Обязательные заголовки | **`X-Requested-With`** |
| Query | `target` ∈ `cli|app|off`, по умолчанию `cli` (`connect.py:110`, `connectsvc.TARGETS` `:28`); не из набора → **422** (`connect.py:84-85`); `app` у Claude молча превращается в `cli` (`connect.py:86-87`) |
| Тело | нет |

Ответ (`issue_for` → `connect.py:101-102`):

```ts
{
  commands: { win: string, mac: string },  // connect.py:63-74
  download: string,                        // "/api/connect/{product}/{token}.exe"
  version: string | null,                  // версия Codex CLI на зеркале; у Claude всегда null
  expires_at: string,                      // ISO, +CODEX_CONNECT_TTL_SEC (600 c) — config.py:372
  target: "cli" | "app" | "off"
}
```

`commands.win` = `powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12';irm {APP_BASE_URL}/api/connect/{product}/{token}.ps1|iex"`,
`commands.mac` = `curl -fsSL {…}/{token}.sh | sh` (`connect.py:69-74`).
**Сам токен в ответе не возвращается отдельным полем** — только внутри `commands`/`download`
(формат токена: `secrets.token_urlsafe(32)` → 43 символа `[A-Za-z0-9_-]`,
`connectsvc.py:52`, подтверждено тестом `backend/tests/test_codex_connect.py:906,971`).

Отказы `issue_for` (`connect.py:77-102`), **кроме** `target=off`:

| Код | `type` | Когда |
|---|---|---|
| 409 | `no_key` | ключа нет или `approved_at` пуст — «Сначала нужен одобренный ключ роутера» (`connect.py:90-92`) |
| 403 | `product_disabled` | `effective_access(product).enabled` ложно (`connect.py:93-95`) |
| 503 | `mirror_not_ready` | зеркало Codex не готово (только `codex`+`cli`, `connect.py:47-49,96-99`) |
| 422 | — | неизвестный `target` |
| 404 | — | неизвестный `product` |

При `target=off` ни ключ, ни доступ не нужны (`connect.py:82,87-89`).

### `GET /api/connect/{product}/status` — как идёт последняя попытка

| | |
|---|---|
| Метод/путь | `GET /api/connect/codex/status`, `GET /api/connect/claude/status` (`connect.py:117-125`) |
| Авторизация | **cookie-сессия** (`connect.py:120`) |
| Обязательные заголовки | нет (GET) |
| Тело запроса | нет |

Ответ: `{"attempt": <status_dict> | null}` (`connect.py:125`). `null` — человек этот
продукт ещё ни разу не подключал. Берётся **последняя по `created_at`** попытка
(`connectsvc.latest` `:116-123`), а не последняя удачная.

`status_dict` (`connectsvc.py:153-167`) — точная форма:

```ts
{
  stage: "issued" | "started" | "installing" | "configuring" | "checking"
       | "done" | "failed" | "expired",
  target: "cli" | "app" | "off",      // row.target или "cli", если пусто
  os: "win" | "mac" | null,           // ставится при выдаче скрипта
  message: string | null,             // текст от скрипта, обрезан до 300 символов
  host: string | null,                // COMPUTERNAME, до 100 символов
  version: string | null,             // версия CLI, до 40 символов
  created_at: string,                 // ISO
  expires_at: string,                 // ISO, created_at + 600 c
  updated_at: string                  // ISO
}
```

Семантика стадий:

| `stage` | Кто ставит | Где |
|---|---|---|
| `issued` | портал при выпуске токена (значение по умолчанию строки) | `connectsvc.issue` `:49-62` |
| `started` | портал в момент **выдачи скрипта** | `connectsvc.take_script:83` |
| `installing` / `configuring` / `checking` / `done` / `failed` | **сам скрипт** через `POST …/report` | `connectsvc.REPORT_STAGES:30`, вызовы `connect.ps1:159,180,217,252,263,285`, `claude.ps1:358,391,666,670,673,680` |
| `expired` | **вычисляется на чтении**, в БД не хранится: `fetched_at is None` и `expires_at` в прошлом | `connectsvc.py:156` |

`done` и `failed` — финальные (`FINAL_STAGES` `:31`): после них `report` ничего не
примет (`connectsvc.py:102`).

### `GET /api/connect/{product}/{token}.{ps1|sh}` — сам скрипт, ОДИН раз

| | |
|---|---|
| Метод/путь | `GET /api/connect/codex/{token}.ps1` (и `.sh`, и для `claude`) — `connect.py:162-212` |
| Авторизация | **никакой** — пропуск только одноразовый токен в пути |
| Обязательные заголовки | нет |
| `suffix` → ОС | `ps1` → `win`, `sh` → `mac` (`connect.py:43`); другой суффикс → **404** (`:170-172`) |
| Ответ | **всегда 200 `text/plain`** — PowerShell или sh-скрипт |

**Одноразовость.** `connectsvc.take_script` (`:72-86`) — это и проверка, и гашение в
одной транзакции:

- `row is None` (чужой токен), `row.fetched_at is not None` (**уже брали**),
  `row.product != product` (токен другого продукта) → `None` (`:77-78`);
- `expires_at < now` → `None` (`:79-80`) — TTL **600 секунд** (`config.py:372`);
- иначе ставит `fetched_at = updated_at = now`, `os = os_name`, `stage = "started"`
  и коммитит (`:81-85`).

Поэтому **второй запрос того же `.ps1` ключа уже не получит**. Это защита от команды,
вставленной в чат: её запустит хозяин, а второй человек получит только отказ
(`connectsvc.py:4-6`).

**Отказ — тоже скрипт, а не код ошибки** (`connect.py:166-168`). HTTP-статус остаётся
**200**, в теле — `connectscripts.notice` (`connectscripts.py:211-217`), который печатает
человеку фразу и ждёт Enter. Варианты:

| Когда | Текст | Где |
|---|---|---|
| токен мёртв / уже использован / чужой продукт | «Эта команда уже использована или устарела.» + «Вернитесь на портал и нажмите «Подключить {Codex\|Claude}» ещё раз…» | `connect.py:174-175`, `connectscripts.py:206-208` |
| ключ роутера не активен (нет записи или `approved_at` пуст) | «Ключ роутера не активен.» + «Откройте личный кабинет на портале…»; попытка помечается `failed` | `connect.py:180-183` |
| зеркало Codex не готово | «Зеркало Codex на портале не готово.» + «Напишите администратору портала.»; попытка помечается `failed` | `connect.py:205-210` |

Это значит: **автоматика не может судить об успехе по HTTP-коду.** Признак отказа —
содержимое тела (у `notice` нет ни `$envJson`, ни таблицы провайдера). Именно так и
устроен разбор в Кузьмиче — см. §8.

### `POST /api/connect/{product}/{token}/report` — окно отчётов

| | |
|---|---|
| Метод/путь | `connect.py:215-230` |
| Авторизация | **только токен** — cookie не читается (`connect.py:222`) |
| Обязательные заголовки | **`X-Requested-With`** — путь `/api/*` и **не** в `CSRF_EXEMPT_PATHS` (`main.py:136-138`). Скрипты портала ставят его сами: `X-Requested-With: codex-connect` (`connect.ps1:44`) и `claude-connect` (`claude.ps1:84`) |
| Тело | `{"stage": string, "message"?: string, "host"?: string, "version"?: string}` (`connect.py:224-227`) |
| Ответ | `{"ok": true}` |

Условия приёма (`connectsvc.report` `:89-113`) — любое нарушение даёт **404** без
подробностей (`connect.py:228-229`):

1. `stage` ∈ `REPORT_STAGES` = `installing|configuring|checking|done|failed`
   (`connectsvc.py:30,99-100`) — `issued`/`started`/`expired` присылать нельзя;
2. строка токена существует **и** `fetched_at is not None` — то есть скрипт уже был
   выдан (`:102`);
3. текущая стадия не финальная (`:102`);
4. **окно отчётов: 1 час** от `fetched_at` — `REPORT_WINDOW = timedelta(hours=1)`
   (`connectsvc.py:33`, проверка `:104-105`). Окно с запасом, потому что установка на
   медленной сети — сотни мегабайт (`:32`).

Обрезка полей: `message` → 300 символов, `host` → 100, `version` → 40 (`:107-109`);
пустые `host`/`version` не затирают прежние (`:108-109`).

Отдельного секрета у отчёта нет и быть не должно: токен знает только тот, кто запустил
команду, а отчёт ничего не открывает — он лишь пишет строку статуса
(`connectsvc.py:10-11`).

### `GET /api/connect/{product}/{token}.exe`

| | |
|---|---|
| Путь | `connect.py:142-159` |
| Авторизация | **никакой** — только живой токен (`connectsvc.alive` `:65-69`: не погашен, тот же продукт, не истёк) |
| Ответ | `application/octet-stream`, `filename={product}-connect-{token}.exe`; файл — `RELAY_EXE_DIR/connect.exe`, иначе `relay.exe` (`connect.py:154-157`) |
| Отказы | **410** `stale` (токен мёртв), **404** `exe_missing` (сборки нет) |

Скачивание токен **не гасит** (`connect.py:149`) — гасит только выдача скрипта.

### `GET /api/connect/codex/installer.{ps1|sh}`

`connect.py:130-139`, без авторизации, `text/plain` — официальный установщик OpenAI,
переставленный на зеркало портала; только `product=codex`, иначе **404**; **503** при
неготовом зеркале.

---

## 5a. Что именно делает выданный PowerShell-скрипт

Сборка — `backend/src/connectscripts.py`, шаблоны — `backend/src/connect_scripts/*`.
Значения подставляются **литералами своего языка** (PowerShell — в одинарных кавычках,
`_ps` `:35-36`; sh — тоже, `_sh` `:39-40`), поэтому `$` и обратные кавычки в них не
раскрываются. Сырые блоки подставляются последними, чтобы чужие `@СЛОВА@` внутри них
не задели метки (`_fill` `:54-61`).

### Codex — `connect.ps1` (`connectscripts.render` `:64-90`)

Подставляемое: `@PORTAL@`, `@TOKEN@`, `@VERSION@`, `@BASE_URL@`, `@KEY@`,
`@MARKER@` (`_values` `:43-51`), `@MANAGED@` — имена «наших» ключей верхнего уровня,
`@TABLES@` — «наши» таблицы (`:78-79`), `@APP@`/`@STORE_ID@`/`@STORE_PACKAGE@` (`:80-82`),
и сырые блоки `@TOP@` = `codexcfg.top_lines()`, `@PROVIDER@` = `codexcfg.tail_lines(...)`,
`@AUTH@` = `codexcfg.auth_json(key)`, `@RESTART_APP@`, `@OLD_COPIES@` (`:83-84`).

Порядок работы `connect.ps1` (`try` на `:150`, этапы помечены комментариями):

1. **Установка CLI с зеркала портала** (`connect.ps1:165-196`).
   Своя установка смотрится первой — `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`
   (`:167-174`), иначе `codex` из PATH. Если `have >= $version` — **не трогает**
   (`:176-177`). Иначе: проверка 64-битной ОС (`Assert-Arch` `:93-100`), `Report
   "installing"`, скачивание **официального установщика OpenAI через портал** —
   `Invoke-RestMethod "$portal/api/connect/codex/installer.ps1"` (`:183`) — и запуск его
   как scriptblock с `CODEX_RELEASE=$version`, `CODEX_NON_INTERACTIVE=1` (`:184-186`).
   После установки: проверка, что `codex.exe` появился (`:187-189`), и **проверка
   подписи Authenticode на `O="?OpenAI`** — иначе `throw` (`:190-193`). Около 150 МБ (`:182`).
2. **Уборка старой копии из npm** (`connect.ps1:198-212`). `Remove-NpmCopy "@openai/codex"`
   (`old-copies.ps1:63`); если npm-копия новее — оставляется (`:201-202`); если убрать не
   удалось — свой каталог выводится вперёд в PATH (`Move-PathFirst`, `:204`) и в
   `message` финального отчёта уезжает `"старый Codex N из npm остался"` (`:205`).
   Другие найденные копии просто перечисляются предупреждением (`:207-211`).
3. **Merge конфига** (`connect.ps1:215-234`).
   `$codexHome = $env:CODEX_HOME ?? %USERPROFILE%\.codex`, каталог создаётся (`:219-220`).
   Если `config.toml` есть — **резервная копия** `config.toml.bak-yyyyMMdd-HHmmss`
   (`:224-226`), затем `Get-ForeignLines` (`:65-91`) — **построчный повтор
   `codexcfg.keep_foreign`** (`codexcfg.py:142-176`; «эталон и тесты там» — комментарий
   `connect.ps1:63-64`). Итоговый файл: `$marker` → `@TOP@` → пустая строка → чужие
   строки → пустая строка → `@PROVIDER@` (`:229-231`), записывается **UTF-8 без BOM**,
   потому что TOML-парсер Codex на BOM спотыкается (`:232-233`).
4. **`auth.json`** — только при `target=app` (`connect.ps1:236-248`): вход по ключу
   роутера вместо аккаунта ChatGPT, с резервной копией прежнего.
5. **Проверка** (`connect.ps1:250-261`): `GET $baseUrl/models` с
   `Authorization: Bearer $key`; отказ → `throw` с кодом ответа.
6. `Report "done"` с `message = $stale` и `version = $have` (`:263`), затем подсказки
   человеку; в `catch` — `Report "failed" $why` (`:283-289`).

### Маркеры и что считается «нашим» в `config.toml`

| Что | Значение | Где |
|---|---|---|
| Маркер первой строки | `# ENCY router: set by the Connect Codex button on the portal` | `codexcfg.MARKER` `:121` |
| «Наши» ключи верхнего уровня (`@MANAGED@`) | `model`, `model_provider`, `model_context_window`, `model_auto_compact_token_limit`, `model_reasoning_summary`, `hide_agent_reasoning` | `codexcfg.TOP_LEVEL:70-77` |
| «Наши» таблицы (`@TABLES@`) | `model_providers.router` + `mcp_servers.<имя>` для каждого **общего** сервера | `codexcfg.owned_tables:133-135`, `PROVIDER_TABLE:79` |
| Что выживает | всё прочее: свои MCP, профили, проекты, свои провайдеры | `codexcfg.keep_foreign:142-176` |

При повторном подключении маркер и наши ключи выкидываются вместе с нашими таблицами,
иначе копились бы по штуке за запуск (`codexcfg.py:119-121`). Подтаблицы наших таблиц
(`model_providers.router.*`) тоже считаются нашими (`_is_ours` `:138-139`).

### Claude — `claude.ps1` (`connectscripts.render_claude` `:93-121`)

Подставляемое: `@PORTAL@`, `@TOKEN@`, `@BASE_URL@`, `@KEY@`, `@VERSION@`/`@MIRROR@`
(версия и URL зеркала, пусто — если зеркала нет), `@SUMS@` (sha256 по платформам),
`@APP_URL@`/`@APP_SUMS@` (приложение Claude с зеркала) — `connectscripts.py:102-113`;
сырые блоки `@ENV@` = `json.dumps(claudecfg.env(...))`, `@DESKTOP@` =
`claudecfg.app(ids)` (на Windows — переведённый в строки реестра `_policy` `:131-134`),
плюс `@RESTART_APP@`, `@OLD_COPIES@`, `@LOG@`, `@SKILLS@` (`:114-116`).

**`@DROP@` — что скрипт сносит** (`connectscripts.py:110` для Windows, `:118` для mac):
это `claudecfg.FOREIGN_AUTH + claudecfg.CLEARED`, то есть ровно шесть имён:

| Имя | Почему снимается | Где |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude Code берёт его **раньше** подписки и спрашивает о нём при каждом запуске — перебил бы наш `ANTHROPIC_AUTH_TOKEN` | `claudecfg.FOREIGN_AUTH:24`, причина `:22-23` |
| `ANTHROPIC_MODEL` | устаревшее | `claudecfg.CLEARED:29` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | место модели, которое человеку без доступа должно остаться встроенным | `CLEARED:30` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL_NAME` | то же | `CLEARED:31` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | то же | `CLEARED:32` |
| `ANTHROPIC_DEFAULT_FABLE_MODEL_NAME` | то же | `CLEARED:33` |

Порядок: **сначала удаляются все имена из `@DROP@`, потом накладывается `@ENV@`**
(`claude.ps1:499-502`). Поэтому Opus/Fable появятся в файле только если портал их
прислал, то есть если модель открыта человеку (`claudecfg.env:81-87`).
«Вернуть подписку» снимает всё, что подключение пишет: `claudecfg.owned()` =
`set(env("", [])) | set(CLEARED)` (`claudecfg.py:143-145`).

Порядок работы `claude.ps1` (`:659-688`):

1. **`Install-ClaudeCode`** (`:345-399`). TLS 1.2 включается явно (`:12`).
   Своя установка — `%USERPROFILE%\.local\bin\claude.exe` (`:31-32`), иначе `claude` из
   PATH. Новее зеркала — оставляется (`:385-386`); старее — обновление.
   `Install-Latest` (`:242-251`): **сначала зеркало портала** (`Install-FromMirror`),
   при сбое — официальный установщик `https://claude.ai/install.ps1` (`Install-Official`
   `:220-240`). Зеркало: ~240 МБ, сверка **sha256 с манифестом Anthropic** (`:202-204`)
   и **подписи Authenticode на `O="?Anthropic`** (`:207-210`), кэш уже скачанной версии в
   `~/.local/share/claude/versions/$version` (`:33,196-200`).
2. **`Remove-OldNpmCopy`**, **`Set-ClaudePath`** (`:661-662`) — уборка npm-копии
   `@anthropic-ai/claude-code` и PATH.
3. **`Install-App`** (`:432-451`) — ставит **приложение Claude**, если его нет, даже
   когда нужен только CLI; сбой не роняет запуск (`Trouble`, `:446-449`).
4. **`Enable-AppVm`** (`:454-471`) — включает компонент Windows
   `VirtualMachinePlatform`, если приложение есть/поставлено, **через
   `Start-Process -Verb RunAs`** (`:325-331`) и требует перезагрузки (`:459-461`).
5. **`Write-Settings`** (`:473-507`) — merge `settings.json`:
   `$claudeHome = $env:CLAUDE_CONFIG_DIR ?? %USERPROFILE%\.claude` (`:476`),
   **резервная копия** `settings.json.bak-yyyyMMdd-HHmmss` (`:481-483`), разбор JSON —
   не JSON или не объект → `throw` с указанием копии (`:486-493`), гарантируется объект
   `env` (`:496-498`), затем удаление `@DROP@` и наложение `@ENV@` (`:499-502`), запись
   **UTF-8 без BOM**, `ConvertTo-Json -Depth 64` (`:504-505`).
   Остальные настройки (права, хуки, MCP, модель) остаются как были (`:6`).
6. **`Write-AppPolicy`** (`:509-542`) — приложение Claude берёт роутер **не из
   `settings.json`**, а из реестра `HKCU:\SOFTWARE\Policies\Claude`: пишутся
   `inferenceProvider = "gateway"`, `inferenceGatewayBaseUrl`, `inferenceGatewayApiKey`
   плюс всё из `@DESKTOP@` (`:512-517`); уже совпадающие значения не перезаписываются
   (`:524`).
7. **`Test-Router`** (`:544-...`) — `GET $baseUrl/models` с `Bearer $key`.
8. `Report "done"` с `message` из `Stale`/`Behind`/`VmNote` (`:673`), `Start-ClaudeApp`,
   `Show-Result`; в `catch` — `Report "failed"` (`:676-683`), в `finally` при сбое
   выгружается лог (`Export-Log`, `:685`).

### Где скрипт требует человека (важно для безоконного запуска)

Это **не** действия на страницах портала, но и не «тихая» установка:

| Что | Поведение | Где |
|---|---|---|
| Финальное `Read-Host "Нажмите Enter, чтобы закрыть окно"` | блокирует процесс **до нажатия Enter**, и в `finally` — то есть и при успехе, и при ошибке | `connect.ps1:290-293`, `claude.ps1:684-688` |
| `Confirm-Close` при запущенной npm-копии | вопрос Y/N, таймаут **60 с**, по умолчанию — **«нет»** (копия остаётся) | `old-copies.ps1:41-59`, вызов `:75` |
| `Enable-VmPlatform` | `Start-Process -Verb RunAs` → **диалог UAC**, затем нужна перезагрузка | `claude.ps1:325-331,454-471` |
| `Install-StoreApp` при `target=app` | если `winget` не справился — открывает Microsoft Store и ждёт нажатия «Получить» **до 20 минут** | `connect.ps1:109-134` |
| отказ (`notice`) | тоже `Read-Host` до Enter | `connectscripts.py:195-200` |

Вывод: штатный connect-скрипт рассчитан на **видимое окно**. Запускать его скрытно и
ждать кода выхода нельзя — он почти наверняка повиснет на `Read-Host`.

---

## 6. Device flow: `/api/device/*` (уже используется приложением)

`backend/src/api/device.py`, роутер `prefix="/api/device"` (`device.py:24`),
подключён `main.py:182`. Константы — `backend/src/devicesvc.py`.

| Ручка | Авторизация | `X-Requested-With` | Коротко |
|---|---|---|---|
| `POST /api/device/codex` (`:32-47`) | нет | **не нужен** (в `CSRF_EXEMPT_PATHS`, `main.py:137`) | тело `{client?, host?}` → `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}`; `verification_uri = {APP_BASE_URL}/device`, `interval = 5`, `expires_in = 600` (`devicesvc.py:26,28`) |
| `POST /api/device/codex/token` (`:50-63`) | нет | **не нужен** (`main.py:137`) | тело `{device_code}`; успех → **200** `{api_key, email}` **один раз**; иначе **400** `{"error": "authorization_pending"|"slow_down"|"access_denied"|"expired_token"}` (`devicesvc.py:33-36`, ответ `device.py:63`) |
| `GET /api/device?code=…` (`:66-82`) | **cookie** | — | `{user_code, client, host, state, expires_at}`; `state` ∈ `pending|approved|denied|expired|taken` (`devicesvc.py:61-68`) |
| `POST /api/device` (`:85-106`) | **cookie** | **нужен** | тело `{code, allow}` → `{state}`; отказы **404** `not_found`, **409** `no_key`/`not_pending`, **403** `product_disabled` |

Важно: выдача ключа через device flow жёстко привязана к **Codex** — и при опросе
(`device.py:59-62`), и при одобрении (`device.py:101-103`). Человеку, у которого открыт
только Claude, device flow ключа **не отдаст**. `user_code` — `XXXX-XXXX` из алфавита
без гласных (`devicesvc.py:30,51-54`).

---

## 7. Боцман и ветка релея

`backend/src/api/boatswain.py`: **два** роутера — `door` с `prefix="/api/relay"`
(`:49`) и `router` с `prefix="/api/boatswain"` (`:50`), подключены `main.py:202-203`.
Вся ветка `/api/relay/` **исключена из CSRF** (`main.py:144`).

Везде в ветке `door` вход — `_owner_or_401` (`backend/src/api/relay.py:97-106`):
ключ берётся из `Authorization: Bearer <key>` либо из `?key=` (`_key_of` `:58-69`,
заголовок предпочтительнее — не пишется в журналы прокси), владелец ищется
`keysvc.owner_of` (`keysvc.py:50-70`: отозванный и **неодобренный** ключ не проходит).
Отказы: **503** `relay_disabled`, если `RELAY_ENABLED` выключен (`config.py:559`),
**401** `unauthorized` «Нужен действующий ключ портала».

### `POST /api/boatswain/connect` — ссылка на установщик

| | |
|---|---|
| Путь | `boatswain.py:334-347` |
| Авторизация | **cookie-сессия** (`:337`) |
| Обязательные заголовки | **`X-Requested-With`** (`/api/boatswain/*` под CSRF) |
| Тело | нет |
| Предусловия | `RELAY_ENABLED` (`_enabled` `:62-64`) и **одобренный** ключ (`:341-343`) |

Ответ (`:345-347`):

```ts
{
  download: "/api/boatswain/setup/{token}.exe",
  command:  "curl -fsSL {APP_BASE_URL}/api/boatswain/setup/{token}.sh | sh",
  expires_in: 3600          // boatswainsvc.TOKEN_TTL — boatswainsvc.py:48
}
```

Токен — `secrets.token_hex(16)`, 32 hex-символа (`boatswainsvc.issue_token` `:386-394`,
regex `TOKEN` `:379`), хранится в памяти процесса по SHA-256.
Отказы: **503** `relay_disabled`, **409** `no_key`.

### `GET /api/boatswain/setup/{token}.exe`

`boatswain.py:350-365`. Авторизация — **никакой**, только живой токен
(`token_alive` **не гасит** его, `boatswainsvc.py:397-400`). Ответ —
`application/octet-stream`, `filename=boatswain-setup-{token}.exe`; файл один и тот же
для всех, различается только имя (`:352-357`). Отказы: **410** `stale`,
**404** `exe_missing`, **503** `relay_disabled`.

Сопутствующие: `GET /api/boatswain/setup/{token}.sh` (`:368-377`, скрипт для мака,
отказ — тоже скрипт), `GET /api/boatswain/setup/{token}/mac-{arch}` (`:380-386`),
`POST /api/boatswain/claim/{token}` (`:389-400`, **гасит** токен, отдаёт
`{portal, url, key}` — где `url` = `wss://…/api/relay/agent`, `relay.py:476-479`,
а `key` — персональный ключ роутера; это делает сам установщик).

### `GET /api/relay/boatswain/machines` — мои Боцманы на связи

| | |
|---|---|
| Путь | `boatswain.py:197-201` |
| Авторизация | **ключ роутера**: `Authorization: Bearer <key>` или `?key=<key>` |
| `X-Requested-With` | не нужен (GET + ветка исключена) |

Ответ: `{machines: Row[]}`, где `Row` (`boatswainsvc.Deck.as_row` `:87-92`,
`Crew.rows` `:124-126`, сортировка по `name`):

```ts
{ machine: string, name: string, since: number /*unix сек*/,
  version: string, outdated: boolean /*старая нога на Node*/, os: "win" | "mac" }
```

Это и есть штатная проверка «установщик встал» (`boatswain.py:199`).

### `GET /api/relay/limits` — остаток лимитов

| | |
|---|---|
| Путь | `boatswain.py:184-194` |
| Авторизация | **ключ роутера** (Bearer или `?key=`) |

Ответ: `{limits: Item[]}` (`boatswainsvc.limits_view` `:325-370`):

```ts
{ name: string,                  // "Codex" или имя провайдера (_PROVIDER_NAMES)
  left: number | null,           // ПРОЦЕНТ ОСТАТКА, round(100 - used%), клип [0,100] — :312-313
  resetAt: string | null,
  blocked: boolean,
  bands: { name: string, left: number, resetAt: string | null, blocked: boolean }[] }
```

Codex попадает в список только при `enabled && home_assigned` (`:332`); закрытые
провайдеры не показываются.

### `POST /api/relay/boatswain/connect/{product}` — connect-токен по Bearer-ключу

Самая важная для Кузьмича ручка ветки `door`: она выдаёт **тот же одноразовый
connect-токен**, что кнопка в кабинете, но **по ключу роутера и без cookie**.

| | |
|---|---|
| Метод/путь | `POST /api/relay/boatswain/connect/codex`, `…/claude` (`boatswain.py:204-223`) |
| Авторизация | **ключ роутера**: `Authorization: Bearer <key>` **или** `?key=<key>` (`_key_of` `relay.py:58-69`, `_owner_or_401` `:97-106`) |
| `X-Requested-With` | **не нужен** — вся ветка `/api/relay/` исключена из CSRF (`main.py:144`) |
| `Content-Type` | `application/json` |
| Тело | `{"target": "on" | "off"}` — `Body(default={})`, то есть тело необязательно, но без валидного `target` будет 400 (`boatswain.py:208,217-219`) |

Ответ **200** (`boatswain.py:223`) — ровно три поля:

```ts
{
  product: "codex" | "claude",     // как пришло в пути
  target:  "cli" | "app" | "off",  // фактически выбранный target (reply["target"])
  token:   string                  // 43 символа [A-Za-z0-9_-] — ТОКЕН ОТКРЫТЫМ ТЕКСТОМ
}
```

Это **единственная** ручка, отдающая connect-токен отдельным полем. Cookie-близнец
`POST /api/connect/{product}` возвращает `commands`/`download`/`expires_at`/`version`,
но не `token` — его там приходится выковыривать из URL (`connect.py:101-102`).
Зато здесь **нет** `expires_at` и `version` — TTL придётся считать самому
(600 с, `config.py:372`).

**Семантика `target` `on`/`off`** (`boatswain.py:212-221`):

- `"off"` → `target = "off"` — «Вернуть подписку»: скрипт убирает роутер из конфига
  агента. Для `off` **не нужны** ни одобренный ключ, ни доступ к продукту
  (`connect.py:82,87-89`) — но `_owner_or_401` всё равно требует **одобренный** ключ,
  чтобы вообще войти в дверь (`keysvc.owner_of:62`);
- `"on"` → `target = await connectsvc.last_target(session, owner, product)`
  (`boatswain.py:220`). То есть **не буквально `cli`**, а «тем же, чем в прошлый раз»
  (`boatswain.py:214`): `connectsvc.last_target` (`:139-150`) берёт последнее удачное
  (`stage == "done"`) подключение с `target != "off"` и возвращает его `target`;
  если такого нет — **`"cli"`**. Практический смысл: кто подключал приложение ChatGPT
  из Store, получит `app` снова, а не CLI;
- любое другое значение, как и `product` вне `codex|claude` → **400** `bad_switch`
  «Нужен codex или claude и on или off» (`boatswain.py:217-219`).

Дальше вызывается тот же `issue_for` (`boatswain.py:221`), поэтому действуют **все его
проверки** (`connect.py:77-102`), кроме случая `off`:

| Код | `type` | Когда |
|---|---|---|
| 503 | `relay_disabled` | `RELAY_ENABLED` выключен — отказ до авторизации (`relay.py:99-101`) |
| 401 | `unauthorized` | ключ не наш, отозван или **не одобрен** (`relay.py:102-105`) |
| 400 | `bad_switch` | неверный `product` или `target` |
| 409 | `no_key` | у владельца ключа нет одобренной записи (`connect.py:90-92`) |
| 403 | `product_disabled` | нет доступа к продукту (`connect.py:93-95`) |
| 503 | `mirror_not_ready` | зеркало Codex не готово (только `codex` + `target=cli`) |

Побочный эффект: запись в журнал портала
`"боцман: меню owner=… product=… target=…"` (`boatswain.py:222`). Боцман на машине для
этой ручки **не нужен** — она не трогает `CREW` и не проверяет, есть ли машина на связи
(сравните с `POST /api/boatswain/switch`, который требует живого Боцмана через `_deck`,
`boatswain.py:319`).

### Прочее в ветке `door` (по ключу)

`GET /api/relay/boatswain/exe` (`:119-126`), `GET /api/relay/boatswain/mac/{arch}`
(`:138-142`), `POST /api/relay/gifts/{drop_id}/join` (`:145-156`),
`POST /api/relay/complaints` (`:159-181`), `GET /api/relay/machines` (`relay.py:84-94`),
WS `/api/relay/boatswain?key=…&machine=…` (`:67-116`).

### Ручки Боцмана по cookie

`GET /api/boatswain` (`:226-231` → `{enabled, machines}`), `GET /api/boatswain/state`
(`:249-253`), `POST /api/boatswain/install` (`:263-289`), `POST /api/boatswain/remove`
(`:292-304`), `POST /api/boatswain/switch` (`:307-331`). Все POST требуют
`X-Requested-With`. `switch` **просит Боцмана** запустить команду, и тот выполнит её
только после подтверждения человеком на машине (`:313-318`) — поэтому как основной путь
он Кузьмичу не годится (решение плана); ответ несёт `{…issue_for reply, machine, asked,
boatswain_error}`.

---

## 8. Чем это уже покрыто в Кузьмиче

Сверено по рабочей копии `E:\My projects\CodexDesk` (ветка `main`, незакоммиченные
правки включены).

### Сводная таблица: ручка портала → кто её зовёт

| Ручка портала | Покрыта в Кузьмиче | Авторизация, которую посылает Кузьмич |
|---|---|---|
| `POST /api/device/codex` | `electron/router-portal.mjs:198` | нет, `credentials: 'omit'` |
| `POST /api/device/codex/token` | `electron/router-portal.mjs:235` | нет, `credentials: 'omit'` |
| `GET /api/codex/provider` | `electron/router-portal.mjs:250` | `Authorization: Bearer <ключ>` |
| `GET /api/codex/defaults` | `electron/router-portal.mjs:251` | `Authorization: Bearer <ключ>` |
| `GET /api/connect/claude/{token}.ps1` | `electron/claude-portal-import.mjs:87` | только токен в пути, `credentials: 'omit'` |
| `GET /api/relay/boatswain/machines` | `electron/boatswain-client.mjs:33` (зовёт `boatswain-setup.mjs:34`) | `Authorization: Bearer <ключ>` |
| `GET /api/relay/limits` | `electron/boatswain-client.mjs:34` и `electron/portal-limits.mjs:39` | `Authorization: Bearer <ключ>` |
| `GET <портал>/#claude` (страница, не API) | `electron/claude-portal-browser.mjs:64` | cookie в одноразовой partition |
| `GET <портал>/device?code=…` (страница) | `electron/portal-auth-window.mjs:47` | cookie в одноразовой partition |
| **`GET /api/me`** | **не покрыта** | — |
| **`GET /api/key`, `POST /api/key`** | **не покрыты** | — |
| **`GET /api/config/codex`** | **не покрыта** (вместо неё — `/api/codex/*` по ключу) | — |
| **`GET /api/config/claude`** | **не покрыта** (вместо неё — разбор `.ps1`) | — |
| **`POST /api/connect/{product}`** | **не покрыта** | — |
| **`GET /api/connect/{product}/status`**, `…/report` | **не покрыты** | — |
| **`POST /api/relay/boatswain/connect/{product}`** | **не покрыта** | — |
| **`POST /api/boatswain/connect`**, `GET /api/boatswain/setup/{token}.exe` | **не покрыты закоммиченным контрактом** — см. ниже про `kuzmich-setup.mjs` | — |

### По файлам

**`electron/router-portal.mjs`** — device flow Codex + настройки по ключу. Единственный
`#request` (`:122`), URL = `` `${PORTAL_ORIGIN}${pathname}` `` (`:135`),
`PORTAL_ORIGIN = 'https://coder-portal.encycam.com'` (`:3`). Заголовки: `Accept`,
`Cache-Control: no-store`, при теле `Content-Type`, при токене `Authorization: Bearer`
(`:136-137`); **`X-Requested-With` не отправляется** — и не нужен: оба device-пути в
`CSRF_EXEMPT_PATHS` (`main.py:137`). Жёстко: `redirect: 'error'`, `credentials: 'omit'`,
`cache: 'no-store'` (`:139`), лимит ответа 64 КиБ (`:4,150,165`). Разбор ошибок device
flow — ровно по RFC 8628 (`:236-247`), `slow_down` +5 с с потолком 300 с. Проверка
`verification_uri`: origin = портал, путь ровно `/device`, единственный параметр
`code == user_code` (`:71-79`) — совпадает с `device.py:40-44`. Берутся поля
`device_code`, `user_code`, `expires_in`, `interval`, `verification_uri`,
`verification_uri_complete` (`:201-212`), `api_key` (`:246`), и из `/api/codex/*` —
белый список полей провайдера (`:46-47`) и шесть обязательных `defaults` (`:51-52`).

**`electron/portal-setup.mjs`** — оркестратор вокруг `RouterPortalClient`, **своих
HTTP-вызовов нет**. Страницу одобрения открывает **во внешнем браузере**
(`openExternal`, `:52,123`) — то есть cookie-сессии портала в этом пути **нет вообще**.
Это прямо противоречит требованию Кузьмича «внешний браузер не используется».

**`electron/portal-config.mjs`** — ручек портала **не зовёт**. Применяет уже полученный
payload через Codex app-server: `config/read` (`:149`) и `config/batchWrite` (`:215`),
принимая только слой `user` без профиля (`:151-164`); ключ пишет как
`experimental_bearer_token` (`:50`) — совпадает с `codexcfg.provider_lines:99`. Делает
резервную копию `${configPath}.backup-<iso>-<uuid>` с `flag:'wx', mode:0o600` (`:208-209`),
preview привязан к `configPath` + `version` + sha256 (`:164,203`), TTL 10 минут (`:5`).
**Это готовый приёмник для `config_text` из `GET /api/config/codex`** — но сейчас он
получает разобранные поля из `/api/codex/*`, а не TOML-текст.

**`electron/claude-portal-browser.mjs`** — **единственное место, где уже живёт
cookie-сессия портала**. `BrowserWindow` с `partition: claude-router-<uuid>` (`:18`),
`sandbox: true`, `contextIsolation: true`; `session = contents.session` (`:21`).
Загружает `${PORTAL_ORIGIN}/#claude` (`:64`). https-редиректы **разрешены** (нужны для
Keycloak), не-https — `preventDefault` (`:58-59`); разрешения запрещены (`:52-53`);
таймаут 10 минут (`:9,26`). «Успех» ловится перехватом загрузки:
`will-download` → `preventDefault()` (`:37-38,51`), URL и имя файла снимаются
синхронно (`:40`), и принимается только если URL — путь установщика Claude **и** имя
файла = `claude-connect-<токен>.exe` (`:41`). Сам HTTP-запрос делается **вне** сессии
окна, без cookie (`main.mjs:631`). Детекта входа по URL здесь нет: закрытие окна = отмена
(`:60`).

**`electron/claude-portal-import.mjs`** — забирает и **разбирает** `.ps1`:
`GET ${PORTAL_ORIGIN}/api/connect/claude/${token}.ps1` с `Accept: text/plain`,
`Cache-Control: no-store`, `redirect: 'error'`, `credentials: 'omit'` (`:87-89`).
Токен — 43 символа, выводится из URL `.exe` (`INSTALLER_PATH` `:6`) или из имени файла
(`INSTALLER_NAME` `:7`, допускает суффикс ` (1)`). Разбор: ровно один here-string
`$envJson = @'…'@` (`:48`) — ноль блоков → `expired`, больше одного → `invalid_response`
(`:49-50`); читаются `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` и
`ANTHROPIC_DEFAULT_{OPUS,FABLE,SONNET,HAIKU}_MODEL[_NAME]` (`:56-65`). Статусы
`401/403/404/410` → `expired`, `429`/`5xx` → `unavailable` (`:92-97`), лимит 128 КиБ
(`:5,98,112`). Ничего не исполняет (`:45`), сетевые ошибки не прокидывает наружу,
потому что в URL личный токен (`:123-124`).

**Важное для §5a:** этот разбор опирается на то, что в теле есть `$envJson` —
то есть он **корректно отличает скрипт от `notice`-отказа**, который приходит тоже с
HTTP 200. Но он читает **только `env`** и игнорирует `@DESKTOP@`, установку CLI с
зеркала, политику реестра и `@DROP@`: список снимаемых переменных Кузьмич берёт не из
скрипта.

**`electron/router-connections.mjs`** — HTTP не делает вовсе, «независим от любой ручки
портала» (`:39`). Общая схема `validateRouterConnection` (`:40`) для
`claude-portal-import.mjs:69`; белый список полей (`:6`), `authScheme` ∈ `bearer|api-key`
(`:44`, для codex принудительно `bearer`, `:45`), `baseUrl` только `https:` без
user/pass/search/hash (`:49`), `leaksKey()` не пускает ключ в метаданные, уезжающие в
renderer (`:25-27`). Хранение — `safeStorage`/DPAPI, запись через temp + rename с
`flag:'wx', mode:0o600` (`:168-172`); в renderer уходит только `publicInfo` без `apiKey`
(`:87-92`).

**`electron/boatswain-client.mjs`** — двери релея по ключу:
`GET /api/relay/boatswain/machines` (`:33`) и `GET /api/relay/limits` (`:34`), заголовки
`Authorization: Bearer <apiKey>`, `Accept`, `Cache-Control: no-store`, `redirect: 'error'`
(`:38`). `origin()` требует https без user/pass/search/hash (`:4-8`); ключ проверяется на
`\r\n\0` (`:37`). Читает ровно одно верхнее поле (`:36,41-42`). Статусы: `401/403` →
`unauthorized`, `409` → `router-key-missing`, `5xx` → `unavailable` (`:18-23`).
Соответствует `boatswain.py:197-201` и `:184-194`.
**Расхождение:** портал отдаёт **503 `relay_disabled`** при выключенном `RELAY_ENABLED`
(`relay.py:99-101`) — у клиента 503 попадает в общий `unavailable`, отдельного разбора
`relay_disabled` нет.

**`electron/portal-limits.mjs`** — второй, независимый клиент того же
`GET /api/relay/limits` (`:39`), `Authorization: Bearer`, плюс **единственный в проекте
кастомный `X-*`-заголовок — `X-Request-ID: <uuid>`** (`:37,39`). Нормализация ответа
точно по `boatswainsvc.limits_view`: `name` ≤128, `left` 0..100 (`:15,23-27`),
`resetAt` → ISO, `blocked`, `bands` (≤16, `:17-21`); лимитов не больше 32 (`:5,45`).
Таймаут 8 с (`:30,37`), тело ≤256 КиБ (`:4,41`), все ошибки сворачиваются в
`{available:false, reason}` (`:46`).

**`electron/boatswain-setup.mjs`** — состояние уже установленного Боцмана. Зовёт только
`client.machines(settings.key)` (`:34`) и ищет свою машину по `row.machine` (`:35`).
Ключ берётся **не с портала**, а из локального `%LOCALAPPDATA%\Boatswain\boatswain.json`
(`:8-9,22-29`). `readClaudeConnection()` (`:54-72`) читает записанный
`settings.json`: `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN` и
`ANTHROPIC_DEFAULT_{OPUS,FABLE,SONNET,HAIKU}_MODEL[_NAME]` — **ровно те имена, что
пишет `claudecfg.env`** (`claudecfg.py:88-95`). Codex считается настроенным при
`model_provider === 'router'` и непустом `model_providers.router.experimental_bearer_token`
(`:42-44`) — совпадает с `codexcfg.TOP_LEVEL:72` и `provider_lines:99`.
**Расхождение:** клиент создаётся с `DEFAULT_PORTAL_ORIGIN`, а не с `settings.portal`
из прочитанного файла (`:19` против `:27`).

**`electron/portal-auth-window.mjs`** — готовое окно входа: `partition:
portal-auth-<uuid>` (`:29`), `sandbox`, `contextIsolation`, `webSecurity`; cookie живёт
только в main (`:8-13`, подтверждено `KUZMICH_PLAN.md:8`). Загрузки **запрещены**
(`will-download` → `preventDefault`, `:35`), разрешения запрещены (`:33-34`),
https-попапы складываются в то же окно (`:38-41`), не-https навигация и редиректы
отбиваются (`:42-43`). Детекта входа по URL нет. **Статус: модуль не импортируется
нигде в `electron/`** — пока это заготовка под фазу 1 плана.

### Что нужно будет добавить (ничего из этого ещё нет)

1. **Ни один файл не отправляет `X-Requested-With`.** Во всём репозитории строка
   встречается только в документации `docs/ROUTER_CONNECT.md:15`. Значит, любая
   cookie-мутация (`POST /api/key`, `POST /api/connect/*`, `POST /api/boatswain/connect`)
   потребует нового кода — существующие клиенты её не вытянут.
2. **Нет клиента cookie-ручек.** `GET /api/me`, `GET /api/key`, `GET /api/config/codex`,
   `GET /api/config/claude` не зовёт никто. Чтобы послать cookie, запрос должен идти
   через `session` окна входа (`net.fetch` с явной сессией или `webContents`), а не через
   дефолтный `net.fetch`, которым пользуются все нынешние клиенты.
3. **`credentials: 'omit'` стоит не везде.** Его ставят только `router-portal.mjs:139` и
   `claude-portal-import.mjs:89`. Вызовы `boatswain-client.mjs:38` и
   `portal-limits.mjs:39` идут на дефолтной сессии `net.fetch` без `omit` — то есть на
   запросы по Bearer-ключу теоретически могут приехать и cookie дефолтной сессии. Для
   безопасности это стоит закрыть явно.
4. **`electron/kuzmich-setup.mjs` опирается на незакоммиченный контракт** и
   использовать его нельзя: `GET /api/kuzmich/capabilities` (`:317`),
   `POST /api/kuzmich/device` (`:321`), `POST /api/kuzmich/device/token` (`:382`),
   `POST /api/relay/boatswain/kuzmich/bootstrap` (`:339`) — **ни одного из этих путей в
   HEAD Coder-Portal нет**. Пригодные части: `GET /api/boatswain/setup/<32 hex>.exe`
   (`:250`, точная regex `:246`) — эта ручка в HEAD **есть** (`boatswain.py:350-365`);
   проверка sha256/размера перед запуском (`:253`); `portalPath()` (`:45-53`);
   `verificationUrl()` (`:56-64`); разбор статусов (`:66-74`). Сам модуль, кроме того,
   **не импортирован** в `electron/main.mjs`, хотя `main.mjs:439-445` обращается к
   `kuzmichSetup` — эти четыре IPC-канала сейчас упали бы с `ReferenceError`.
   Зачистка этого — задача A1 плана.
5. **Нет чтения `expires_at`/TTL connect-токена** и нет опроса
   `GET /api/connect/{product}/status`: прогресс установки Кузьмич сейчас не читает.

---

## 9. Главный вопрос

> Достаточно ли cookie → `GET /api/key` → токены по ключу → connect-скрипты, чтобы
> после одного входа **установить И подключить** оба CLI без действий пользователя на
> страницах портала?

### Ответ: ДА на стороне портала

Страниц портала не требуется ни одной: вся цепочка — закоммиченные HTTP-ручки.
**Но** путь через connect-скрипты не доходит до конца без действий человека **на
машине**: сами скрипты интерактивны.

Ответ распадается на два, и это не уклончивость, а разные пути:

| Путь | Ставит CLI? | Нужны страницы портала? | Нужны действия на машине? | Вывод |
|---|---|---|---|---|
| **A.** cookie → `GET /api/config/{codex,claude}` → пишем файлы сами | **нет** | **нет** | **нет** | полностью программно |
| **B.** cookie → `GET /api/key` → токен по Bearer → `GET …/{token}.ps1` → запуск скрипта | **да** | **нет** | **да**: Enter, иногда Y/N и UAC | портал не мешает, мешает скрипт |

### Путь B: цепочка вызовов целиком

Все четыре звена закоммичены и работают по заявленной схеме:

```
1. GET  {APP_BASE_URL}/auth/login?next=/
       → 302 Keycloak → (единственное действие человека: форма входа)
       → GET /auth/callback → Set-Cookie coder_session          auth/routes.py:57-80, :83-131
2. GET  /api/me                 (cookie)
       → 200 {email, has_key, key_approved, entitlements}        api/me.py:17-45
       → 401 = вход не выполнен                                  deps.py:21-27
3. GET  /api/key                (cookie, CSRF не нужен — GET)
       → 200 {has_key:true, api_key, approved}                   api/keys.py:67-87
       → 200 {has_key:false, held_by}  → POST /api/key + X-Requested-With   api/keys.py:32-64
4. POST /api/relay/boatswain/connect/codex   (Authorization: Bearer <api_key>)
       тело {"target":"on"}      CSRF НЕ нужен — ветка /api/relay/ исключена  main.py:144
       → 200 {product, target, token}                            api/boatswain.py:204-223
   POST /api/relay/boatswain/connect/claude  → то же для Claude
5. GET  /api/connect/codex/{token}.ps1       (без авторизации, токен в пути)
       → 200 text/plain: скрипт, ОДИН раз                        api/connect.py:162-212
                                                                 connectsvc.take_script:72-86
   GET  /api/connect/claude/{token}.ps1      → то же для Claude
6. запуск скрипта → он сам ставит CLI с зеркала, сводит конфиг, проверяет ключ
       и отчитывается в POST /api/connect/{product}/{token}/report
                                                                 connect.ps1:150-293, claude.ps1:659-688
7. GET  /api/connect/{product}/status        (cookie) → прогресс  api/connect.py:117-125
```

Шаг 4 можно заменить cookie-близнецом `POST /api/connect/{product}` + `X-Requested-With`
(`connect.py:105-114`) — он не требует `RELAY_ENABLED`, но токен приходится вынимать из
`commands`/`download`. Шаг 4 по Bearer, наоборот, отдаёт `token` готовым полем, зато
требует включённого релея (`relay.py:99-101`).

**Ни одного шага на страницах портала здесь нет.** Единственное действие человека —
форма входа Keycloak, то есть страница IdP, а не портала; по условию задачи это и есть
тот «один вход».

### Где путь B упирается в человека — на машине, не на портале

| Препятствие | Где | Можно ли обойти, не меняя портал |
|---|---|---|
| `Read-Host` «Нажмите Enter, чтобы закрыть окно» — **в `finally`**, то есть всегда | `connect.ps1:290-293`, `claude.ps1:684-688` | только видимым окном (как решено для установщика Боцмана) либо подачей `\n` в stdin |
| `Confirm-Close` Y/N при запущенной npm-копии CLI, таймаут 60 с, по умолчанию «нет» | `old-copies.ps1:41-59` | таймаут сам истечёт; копия останется, подключение пройдёт |
| UAC-диалог `Start-Process -Verb RunAs` для `VirtualMachinePlatform` + перезагрузка | `claude.ps1:325-331,454-471` | срабатывает только если приложение Claude есть/поставилось; сбой не роняет CLI |
| `claude.ps1` ставит **приложение** Claude, даже когда нужен только CLI | `claude.ps1:440-450` | нет |
| Microsoft Store с ожиданием до 20 минут | `connect.ps1:109-134` | только при `target=app`; `target=on` даст `app` тем, кто так подключался раньше (`connectsvc.last_target:139-150`) |
| Отказ приходит как **HTTP 200 со скриптом-`notice`**, который тоже ждёт Enter | `connect.py:166-168`, `connectscripts.py:195-200` | обязателен разбор тела, а не кода ответа |

### Путь A: то же самое без скриптов

Если установку CLI Кузьмич делает своими средствами (у него уже есть `setup:install`),
то подключение целиком программно:

```
1-2. вход и GET /api/me                        (как выше)
3.  GET /api/config/codex?scope=global  (cookie) → {config_text, mcp_servers}   api/configs.py:106-147
    → запись через config-API Codex CLI          electron/portal-config.mjs:149,215
4.  GET /api/config/claude?scope=global (cookie) → {settings:{env, model, effortLevel, autoUpdatesChannel}}
                                                                                 api/configs.py:56-103
    → merge settings.env в ~/.claude/settings.json, предварительно сняв
      ANTHROPIC_API_KEY и claudecfg.CLEARED       claudecfg.py:24, :28-34
```

Оба ответа **содержат персональный ключ**: Codex — внутри `config_text`
(`experimental_bearer_token`, `codexcfg.py:99`), Claude — в
`settings.env.ANTHROPIC_AUTH_TOKEN` (`claudecfg.py:90`). Это ровно то же содержимое,
что кладёт штатный скрипт. Чего портал в этом пути **не делает за нас**: снятия
`@DROP@`-переменных (`claude.ps1:499-502`), сведения чужого `config.toml`
(`codexcfg.keep_foreign:142-176` — эталон, его надо повторить), резервных копий,
политики реестра приложения Claude (`claude.ps1:509-542`) и установки CLI.

### Жёсткие предусловия обеих цепочек

1. **Ключ должен быть одобрен.** `GET /api/key` отдаёт ключ и с `approved: false`
   (`keys.py:84-87`, `keysvc.get_existing:37-41` не смотрит `approved_at`), но такой
   ключ не пустят ни в двери релея (`keysvc.owner_of:62` → шаг 4 даст **401**), ни в
   `issue_for` (`connect.py:90-92` → **409** `no_key`), ни в роутер. Не-админ получает
   ключ на паузе (`keys.py:37-46`); снимает её **админ портала** — человеческое действие
   вне приложения. Обойти нельзя.
   Нюанс: путь A мягче — `/api/config/*` требует лишь **наличия** записи ключа
   (`configs.py:31-39`), так что конфиг выдадут и по неодобренному ключу. Но работать он
   не будет, и выдавать это за успех нельзя.
2. **Доступ к продукту решает root, а не портал** (`entitlementsvc.py:1-16,191-208`).
   Нет доступа → **403** `product_disabled` и на `/api/config/{product}`
   (`configs.py:42-53`), и на выдаче токена (`connect.py:93-95`).
3. **`RELAY_ENABLED`** нужен только для шага 4 по Bearer и для всего Боцмана
   (`config.py:559`, `relay.py:99-101`, `boatswain.py:62-64`). Путь A и cookie-выпуск
   токена от него не зависят.
4. **TTL.** Connect-токен живёт **600 с** (`config.py:372`, `connectsvc.py:58`) и гаснет
   на первой же выдаче скрипта (`connectsvc.take_script:72-86`) — выпускать его надо
   непосредственно перед запуском, по одному на продукт. Токен установщика Боцмана —
   **3600 с** и живёт в памяти процесса портала (`boatswainsvc.py:48,386-394`).

### Боцман (опция) — тоже без страниц портала

```
1. POST /api/boatswain/connect + X-Requested-With (cookie)
      → {download:"/api/boatswain/setup/{token}.exe", command, expires_in:3600}
                                                            api/boatswain.py:334-347  (нужен ОДОБРЕННЫЙ ключ)
2. GET  /api/boatswain/setup/{token}.exe   (без авторизации, токен не гасится)
                                                            api/boatswain.py:350-365
3. запуск штатного установщика — его окно остаётся видимым (решение плана)
4. GET  /api/relay/boatswain/machines  (Bearer <api_key>)  → ждём свою машину
                                                            api/boatswain.py:197-201
```

Боцман для подключения CLI **не нужен** — конфигурация берётся по cookie или по ключу
напрямую. Он нужен для скиллов/MCP с портала и уведомлений (`KUZMICH_PLAN.md:15`).
Путь через `POST /api/boatswain/switch` (`boatswain.py:307-331`) как основной не годится:
Боцман запустит команду **только** после подтверждения человеком на машине (`:313-318`).

---

## 10. Открытые риски

### Истечение сессии

- `SESSION_MAX_AGE` = **8 часов** (`config.py:91`), передаётся в `max_age`
  `SessionMiddleware` (`main.py:125`) — это одновременно срок cookie и `max_age`
  проверки подписи. Просроченный cookie сервер отвергнет.
- Скользящее ли это окно (переставляет ли Starlette `Set-Cookie` на каждом ответе с
  непустой сессией) — **по коду Starlette в этой задаче не проверено**. Планировать надо
  на худший случай: 8 часов от момента входа.
- Детект: любой `/api/*` отдаёт **401** `not_authenticated` (`deps.py:21-27`) —
  не редирект. Значит, Кузьмич обязан распознавать 401 на **каждом** шаге и
  предлагать повторный вход, а не падать.
- На прод-портале cookie `Secure` (`config.py:93`) — окно входа обязано работать
  по `https`, иначе cookie просто не сохранится.
- Сессия живёт только в cookie-jar окна входа. Если partition окна очищается при
  перезапуске приложения, вход придётся повторять — это выбор на стороне Кузьмич, а
  не портала.

### Entitlement «только Claude»

- Доступ считает root; локальные флаги портала правом доступа **не являются**
  (`entitlementsvc.py:1-16`, `entitlement_dict` `:220-242`).
- Claude открыт **только** при четырёх одновременных флагах политики root:
  `shared_claude_enabled && shared_claude_converged && shared_claude_operational && claude_tier_open`
  (`_claude_decision` `:143-156`). Любой ложный → `enabled: false`,
  `reason: "product_disabled"` → `GET /api/config/claude` отдаёт **403**.
- Codex закрыт **только** при `access_state == "DISABLED"`; пустой `access_state` →
  fail-closed `unknown_access_state` (`_codex_decision` `:159-167`).
- Root недоступен → **оба** продукта закрыты с `reason` вида `control_unavailable`
  (`_ask_root` `:198-204`). То есть сбой control plane выглядит как «нет доступа», а не
  как ошибка сети — различать надо по `access_reason`.
- Где Codex действительно обязателен: **device flow** (`device.py:59-62,101-103`).
  Поэтому «Claude-only» пользователь не получит ключ через device flow — но по cookie
  (`GET /api/key`) получит. Принятое владельцем ограничение плана
  ([KUZMICH_PLAN.md](KUZMICH_PLAN.md), п. о Claude-only) касается именно старых
  потоков; `POST /api/connect/claude` проверяет доступ к **claude**, а не к codex
  (`connect.py:93-95` с `product="claude"`).
- Практический риск обратный: Claude-доступ по общему пулу часто **выключен**, и тогда
  Кузьмич должен настроить только Codex и честно это сказать.

### CSRF

- Забытый `X-Requested-With` на мутации `/api/*` даёт **403** с телом **без** обёртки
  `detail` (`main.py:162-166`) — распознавать надо отдельно от 403 `product_disabled`,
  который приходит в `detail`.
- Исключения помнить наизусть: `/api/device/codex`, `/api/device/codex/token`
  (`main.py:137`) и вся ветка `/api/relay/` (`main.py:144`).
- Ловушка: `POST /api/connect/{product}/{token}/report` авторизуется только токеном,
  но заголовок всё равно обязателен (`main.py:155-159`, путь не исключён).
- `SameSite=Lax` (`main.py:122`) — второй рубеж. Для окна Electron это означает: cookie
  поедет на свои же GET-запросы и на POST с того же сайта; сторонние контексты cookie не
  получат.

### Редиректы

- `/auth/login` и `/auth/callback` — **302**, в том числе на внешний хост Keycloak.
  Окно входа обязано разрешать эти переходы, иначе вход не завершится.
- `next` отфильтрован `_local_path` (`routes.py:49-54`): только путь того же портала;
  `//`, `\` и абсолютные URL отбрасываются в `/`. На open redirect опираться нельзя —
  его нет.
- `OAuthError` (протухший `state`, повторное открытие `/callback`) даёт **302** на
  `/auth/login` (`routes.py:92`) — в автоматике это выглядит как «вход начался заново»,
  а не как ошибка. Петлю надо ограничивать по числу попыток.
- Запрещённый домен email → **302** `/?auth_error=email_domain` (`routes.py:112`) с
  **очищенной** сессией: детект обязан смотреть `/api/me`, а не «окно куда-то пришло».
- `/auth/logout` — GET-редирект, который гасит и SSO-сессию Keycloak
  (`routes.py:134-155`). Случайно пройти по нему нельзя.
- Ручки, отдающие файл (`*.exe`), — `FileResponse` без редиректа
  (`connect.py:159`, `boatswain.py:365`); готовить обработку редиректов там не нужно.

### Прочее, что стоит держать в голове

- `GET /api/me` имеет **побочные эффекты** (регистрация, запись входа, поход в root —
  `me.py:24-30`). Как «пинг каждые N секунд» он не предназначен.
- `GET /api/config/codex` отдаёт `Cache-Control: no-store` (`configs.py:128`), а
  `GET /api/config/claude` — **нет** (`configs.py:56-103`), хотя ключ в теле есть.
  Кэшировать ответ нельзя в обоих случаях.
- Поле `path` у `/api/config/codex` содержит двойные обратные слэши
  (`configs.py:139-143`) — это подпись для человека, а не путь файла.
- `expires_at` у connect-токена — ISO-строка, TTL **600 секунд**
  (`config.py:372`, `connectsvc.py:58`). Токен Боцмана — **3600 секунд**
  (`boatswainsvc.py:48`) и живёт **в памяти процесса**: перезапуск портала его теряет.
- Выдача скрипта гасит connect-токен **один раз** (`connectsvc.take_script` `:72-86`);
  скачивание `.exe` — не гасит (`connectsvc.alive` `:65-69`).
- **Отказ выдачи скрипта приходит как HTTP 200** со скриптом-`notice`
  (`connect.py:166-168`). Судить об успехе по коду ответа нельзя — только по телу
  (наличие `$envJson` у Claude, таблицы провайдера у Codex). Повторить запрос нечем:
  токен уже погашен, нужен новый.
- **Retry стоит дорого.** Повторная попытка требует нового токена, то есть снова
  `POST /api/relay/boatswain/connect/{product}` или `POST /api/connect/{product}` —
  и снова проходит все проверки ключа и доступа. Планировать надо «один токен — один
  запуск», а не «ретрай с тем же токеном».
- **Окно отчётов 1 час** от выдачи скрипта (`connectsvc.py:33,104-105`), и после
  `done`/`failed` `report` молча не принимает ничего (`:102`). Прогресс через
  `GET /api/connect/{product}/status` после финальной стадии больше не изменится.
- `POST /api/relay/boatswain/connect/{product}` не отдаёт `expires_at` — TTL 600 с
  придётся считать от момента запроса самостоятельно (`boatswain.py:223`).
- `target: "on"` — это **не** «CLI», а «как в прошлый раз»
  (`connectsvc.last_target:139-150`). Кто однажды подключил приложение ChatGPT из
  Store, получит `app`, и скрипт полезет в Microsoft Store с 20-минутным ожиданием
  (`connect.ps1:109-134`). Если нужен именно CLI — выпускать токен cookie-ручкой
  `POST /api/connect/{product}?target=cli` (`connect.py:105-114`).
- Скрипты **сами** ставят `X-Requested-With` на свои отчёты (`connect.ps1:44`,
  `claude.ps1:84`) — это подтверждает, что CSRF-страж действует и на
  токен-авторизованные мутации.
