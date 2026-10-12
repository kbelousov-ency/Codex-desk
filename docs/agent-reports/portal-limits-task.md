# Задание: портал должен отдавать суммы лимитов, а Кузьмич — их показывать

Инструкция для агента-исполнителя. Составлена 2026-10-09 по результатам разбора без изменения кода.
Затрагивает **два репозитория**: `E:\My projects\Coder-Portal` (портал, Python + C#) и
`E:\My projects\CodexDesk` (оболочка, Electron + React).

## 1. Симптом и причина

В канале Experimental 3 подвал composer показывает бейдж «Роутер» без процентов, а в popover —
карточки «Ключ 1» со всеми полями «—» и плашками «Роутер не передал часть сумм» и
«Недостаточно данных для расчёта процента лимита».

Причина — **два разных контракта лимитов и отсутствие перехода между ними**:

| | Модель роутера `/v1/me/limit` | Модель портала `/api/relay/limits` |
|---|---|---|
| Единицы | кредиты + процент **израсходовано** | целый процент **остатка** (`left`) |
| Поля | `key`, `tier`, `state`, `reset_at`, `limit_credits`, `used_credits`, `remaining_credits`, `ledger_used_credits`, `used_percent` | `name`, `left`, `resetAt`, `blocked`, `bands[]` |
| Кто читает в оболочке | `src/RouterUsage.tsx` (единственный рендерер) | **никто** |

Ход вызова в оболочке:

```
electron/main.mjs:422   host:getRouterUsage
  ├─ if (routerOnly)  → portalLimits.read(apiKey)      electron/portal-limits.mjs:45  → модель портала
  └─ else             → routerUsage.overview()         electron/router-usage.mjs:104  → модель роутера
src/RouterUsage.tsx:28  limitUsage()   ← умеет только модель роутера
src/types.ts:13         RouterLimit    ← описывает только модель роутера
```

`routerOnly = releaseInfo.channel === 'experimental3'` (`electron/main.mjs:77`); в этом канале
`cleanSettings` принудительно ставит `connectionSource:'router'` (`electron/window-session.mjs:55`),
а `UsageLimit` скрыт условием `codex.connectionSource !== 'router'` (`src/App.tsx:706`) — то есть
`RouterUsage` остаётся единственным индикатором лимитов.

Проверено: `grep "bands\|resetAt\|\.left\b" src/**` даёт только `rect.left` в вёрстке. Портальных
полей не читает ни один компонент, поэтому `left`, `bands` и `name` теряются целиком, а
`limitUsage()` получает `undefined` во всех кредитовых полях и выдаёт `null`.

## 2. Что у портала уже есть и что он выбрасывает

`GET /api/relay/limits` (`backend/src/api/boatswain.py:184-194`) собирает **полные** квоты и затем
сводит их к одному целому проценту в `boatswainsvc.limits_view` (`backend/src/boatswainsvc.py:325-370`,
округление — `_left` на `:312`).

Источник Codex — `codex_quota_of` → `codexquota.public_view` (`backend/src/codexquota.py:746-816`),
доступно и **не отдаётся**:

`personal_limit_credits`, `personal_used_credits`, `personal_remaining_credits`,
`ledger_used_credits`, `bonus_credits`, `personal_used_percent`, `used_percent`, `state`,
`blocked_reason`, `profile_code`, `collecting`, `available`.

Источник провайдеров — `provider_quotas_of` → `codexcontrol.user_provider_quotas`
(`backend/src/codexcontrol.py:1493-1534`), доступно и **не отдаётся**:

`tier`, `limit_credits`, `spent_credits`, `used_percent`, `window_resets`, `blocked_until`,
`bonus_credits`, `flags`, а в полосах (`_safe_bands`, `:359`) — `band`, `hours`, `share_percent`,
`limit_credits`, `used_credits`.

Вывод: **дорабатывать нужно именно `limits_view`** — данные уже в руках, их режет последний шаг.

## 3. Задача П — портал (делать первой)

Репозиторий `E:\My projects\Coder-Portal`, `HEAD = df728e34ec5d08f0683e17ea0219925f7ede0e9d`
(«Боцман: починил сбой сертификата при переносе в лоцию»), рабочая копия на момент разбора чистая.
**Сверь HEAD и `git status` заново**: по заметке в `docs/PORTAL_COMMITTED_API.md:7-11` эту копию
параллельно откатывают. Этот репозиторий деплоится на прод `coder-portal.encycam.com` — не коммить
и не деплоить без явного разрешения человека.

### П1. Расширить `limits_view` аддитивно

Файл `backend/src/boatswainsvc.py`, функция `limits_view` (`:325`).

**Существующие поля `name`, `left`, `resetAt`, `blocked`, `bands[].name`, `bands[].left`,
`bands[].resetAt`, `bands[].blocked` менять, переименовывать и удалять нельзя** — их читают:

- `relay/boatswain/Limits.cs:49,84-120` — подсказка и меню значка Боцмана (читает ровно эти имена);
- `electron/boatswain-client.mjs:34` в Кузьмиче — проверка «установщик встал» (читает только верхнее поле `limits`);
- `electron/portal-limits.mjs:39` в Кузьмиче — наш случай.

Добавить к каждому элементу `limits[]` (camelCase, как уже сделано у `resetAt`):

```ts
{ // существующее не трогаем
  name: string, left: number | null, resetAt: string | null, blocked: boolean, bands: Band[],
  // новое
  tier: string | null,              // Codex: profile_code; провайдер: tier
  state: string | null,             // Codex: state; провайдер: null
  blockedReason: string | null,     // Codex: blocked_reason; провайдер: blocked_until
  usedPercent: number | null,       // ТОЧНЫЙ процент израсходованного, без round() до целого
  limitCredits: number | null,
  usedCredits: number | null,
  remainingCredits: number | null,
  ledgerUsedCredits: number | null, // только Codex, иначе null
  bonusCredits: number | null,
}
```

и к каждому элементу `bands[]`:

```ts
{ name, left, resetAt, blocked,     // существующее
  band: string | null, hours: number | null, sharePercent: number | null,
  usedPercent: number | null, limitCredits: number | null, usedCredits: number | null,
  remainingCredits: number | null }
```

Карта значений:

| Новое поле | Codex (`public_view`) | Провайдер (`user_provider_quotas`) |
|---|---|---|
| `tier` | `profile_code` | `tier` |
| `state` | `state` | `null` |
| `blockedReason` | `blocked_reason` | `blocked_until` |
| `usedPercent` | то же значение `used_percent`, что уже вычисляет ветка `counted` на `:338-344` — **не считать второй раз** | `used_percent` |
| `limitCredits` | `personal_limit_credits` | `limit_credits` |
| `usedCredits` | `personal_used_credits`, при `None` — `ledger_used_credits` (та же подстановка, что на `:334-336`) | `spent_credits` |
| `remainingCredits` | `personal_remaining_credits`; при `None` и известных лимите/расходе — `max(0, limit - used)` | `max(0, limit_credits - spent_credits)` |
| `ledgerUsedCredits` | `ledger_used_credits` | `null` |
| `bonusCredits` | `bonus_credits` | `bonus_credits` |

Требования:

1. `left` остаётся целым (его рисует C#), `usedPercent` — точным. Они должны быть согласованы:
   `left == round(100 - usedPercent)` при известном `usedPercent`.
2. Отсутствующее значение — **`null`, никогда `0`**. Это главная причина существования задачи:
   ноль вместо «нет данных» рисует правдоподобную неправду.
3. Условия показа не менять: Codex попадает в список только при `enabled && home_assigned` (`:332`),
   закрытые провайдеры (нулевой лимит или нулевая ступень) не показываются
   (`codexcontrol.py:1518-1521`).
4. **Никакой новой PII.** Ручка авторизуется ключом роутера, а не cookie-сессией; `email`, имена и
   идентификаторы ключей в ответ не добавлять. Владелец и так выводится из ключа
   (`_owner_or_401`, `backend/src/api/relay.py:97-106`).
5. Размер ответа держать в прежних рамках: клиент обрезает тело на 256 КиБ и берёт максимум
   32 лимита и 16 полос (`electron/portal-limits.mjs:4-5,25,45`).

### П2. Тесты портала

Файл `backend/tests/test_boatswain.py`, рядом с
`test_limits_for_the_tray_come_by_the_machine_key` (`:319-330`) — существующий тест менять нельзя,
он фиксирует совместимость с лотком.

Добавить случаи:

- суммы и `usedPercent` доезжают для Codex и для провайдера, `left` остаётся целым и согласован с `usedPercent`;
- отсутствующие суммы дают `null`, а не `0` (квота ещё `collecting`; `personal_used_credits is None` → подстановка `ledger_used_credits`);
- Codex без места (`home_assigned=False`) и закрытый провайдер по-прежнему не попадают в список;
- полосы несут `limitCredits`/`usedCredits`/`sharePercent`, а их `left` считается от собственного лимита полосы;
- в ответе нет почты и имён ключей.

### П3. Документация портала

- `docs/PORTAL_COMMITTED_API.md:857-875` в Кузьмиче описывает прежнюю форму `/api/relay/limits` —
  обновить блок после деплоя и указать новый коммит портала как источник истины.
- Если в портале есть своё описание ручки — обновить и его.

## 4. Задача К — клиент Кузьмич (после П, но может идти параллельно)

Репозиторий `E:\My projects\CodexDesk`. В рабочей копии лежат незакоммиченные чужие изменения
(ветка Кузьмича/портала) и завершённая задача массовой архивации — **не трогать ничего за пределами
перечисленных ниже файлов**, не коммитить, не упаковывать, Release не менять.

### К1. Принять новые поля в host

`electron/portal-limits.mjs`: в `normalizeLimit` (`:23`) и `normalizeBand` (`:17`) добавить новые поля
с той же строгостью, что уже есть:

- числа — через `number()` (`:13`), отрицательные суммы отбрасывать в `null`;
- `usedPercent` — отдельной проверкой: `>= 0`, без верхнего клипа (перерасход >100 % возможен и его
  нельзя маскировать; существующий `boundedPercent` на `:15` для `left` сохранить как есть);
- строки (`tier`, `state`, `blockedReason`) — с ограничением длины и вырезанием управляющих символов,
  как `name` на `:26`;
- неизвестные поля не пропускать наружу; ключ в ответ не попадает (это уже проверяет тест
  `tests/portal-limits.test.mjs:19`).

### К2. Научить рендерер понимать обе модели

`src/types.ts`: расширить `RouterLimit` **необязательными** портальными полями либо ввести
`PortalLimit` и объединение. Текущие обязательные поля роутера не ломать — на них стоит
`scripts/ui-router-usage.mjs`.

`src/RouterUsage.tsx`:

- `limitUsage()` (`:28`) — добавить ветку портальной модели. Приоритет источников процента:
  `usedPercent` → расчёт из `usedCredits/limitCredits` → `100 - left`. Ветку с
  `ledger_used_credits` для модели роутера сохранить без изменений, она закрывает отдельный
  известный баг (см. `router-limit-null-report.md`).
- `LimitCard` (`:66`) — заголовок брать из `limit.key ?? limit.name`, дату из
  `limit.reset_at ?? limit.resetAt`, недоступность из `limit.available === false || limit.blocked === true`.
- Добавить отрисовку `bands[]` как подстрок карточки (имя, остаток/использовано, сброс). Сейчас
  полосы теряются, а для Claude это основная величина.
- Плашки «Роутер не передал часть сумм» и «Недостаточно данных для расчёта процента» должны
  появляться только когда данных действительно нет. При портальной модели без кредитов, но с
  `left`, процент показывать, а графы «Потрачено/Всего/Осталось» оставлять «—» **без** плашки об
  ошибке: у портала этих величин может не быть законно.
- Бейдж (`:132`): при портальной модели `info?.dayCredits` отсутствует (блока `overview` в этом
  ответе нет), поэтому запасная подпись «кр./сут» недоступна — убедиться, что бейдж показывает
  процент, а не просто «Роутер».

### К3. Не терять деградацию

До деплоя портала новых полей не будет. Поведение при их отсутствии должно оставаться сегодняшним
(процент из `left`, суммы «—»), а не падать и не показывать нули. То же при `available:false` —
текст причины из `reason` уже обрабатывается на `:146`.

### К4. Тесты клиента

- `tests/portal-limits.test.mjs` — новые поля нормализуются; `null` вместо `0`; отрицательные и
  нечисловые значения отбрасываются; ключ не утекает; ответ без новых полей по-прежнему валиден.
- `scripts/ui-router-usage.mjs` — **главный пробел, который и пропустил дефект**: сейчас фикстура
  подаёт только snake_case модель роутера (`:38,104,124`). Добавить сценарии с портальной формой:
  полная (проценты + суммы + полосы), без сумм (только `left`), `blocked:true`, и ответ старой формы
  без новых полей. Проверять подписи карточек, проценты, полосы и бейдж.
- Прогнать `npm run check` (`tsc --noEmit`, `node --test tests/*.test.mjs`, `vite build`) и
  `npm run test:router-usage`.

## 5. Порядок, совместимость и проверка

1. Сначала П1+П2 локально; ответ ручки снять руками и приложить к отчёту:
   ```bash
   curl -H "Authorization: Bearer <ключ coder-…>" https://coder-portal.encycam.com/api/relay/limits
   ```
   (в query-строке ключ не принимается специально — см. `router-me-api.md:8-10`).
2. Деплой портала — **только по явному разрешению человека**.
3. Затем К1–К4; клиент обязан работать и до деплоя (К3).
4. Проверка в оболочке: вкладка канала Experimental 3, подвал composer рядом с кэшем.

Диагностика, если лимитов всё ещё нет — симптомы различимы:

| Что видно | Причина |
|---|---|
| карточки со всеми «—» | старое расхождение контрактов, задача не доделана |
| «Портал лимитов недоступен» | 503 `relay_disabled`: на портале выключен `RELAY_ENABLED` — это проверяет `_owner_or_401` (`backend/src/api/relay.py:99-101`), то есть ручка **действительно** закрыта вместе с релеем |
| «Ключ роутера отклонён» | 401 `unauthorized` от `_owner_or_401` (`:103-105`) |
| «Ключ роутера недоступен» | `session.connectionProfile` пуст — вкладка не загрузилась (`electron/main.mjs:425`) |
| «Роутер не передал лимиты ключей» | пустой `limits[]`: Codex без места или закрытые провайдеры — законно |

## 6. Что делать нельзя

- Переименовывать или удалять `name`/`left`/`resetAt`/`blocked`/`bands` — сломается лоток Боцмана.
- Подставлять `0` вместо отсутствующего значения и выводить процент из суточного расхода: это
  разные величины и разные окна, отдельно разобрано в `router-limit-null-report.md:116-118`.
- Добавлять почту/имена ключей в ответ ручки, авторизованной ключом роутера.
- Трогать в Кузьмиче брендирование, каналы Nightly/Experimental, логотип, выбор источника в
  composer, поведение placeholder и завершённую задачу массовой архивации
  (`src/bulk-archive.ts`, `src/BulkArchive.tsx`, `src/Workspace.tsx` в части `bulk*`).
- Коммитить, публиковать, упаковывать и переносить в Release без явного разрешения.

## 7. Уточнить у человека до начала

1. Деплой портала на прод — кто и когда; можно ли проверять на стенде.
2. Нужны ли полосы (`bands`) в подвале Кузьмич или достаточно верхнего процента: у Claude
   полосы — основная величина, у Codex список пуст (`boatswainsvc.py:348`).
3. `provider_quotas_of` вызывается с **ключом портала** человека, а не с тем ключом, которым
   пришёл запрос (`backend/src/api/usage.py:71-76,77-95`; у функции есть необязательный `key_name`).
   Для владельца ключа `hermes-` это может дать квоты другого ключа — считать ли это дефектом,
   решает человек; в рамках этой задачи поведение не менять.
