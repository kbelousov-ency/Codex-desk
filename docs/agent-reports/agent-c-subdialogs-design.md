# Агент C — зависимые дочерние диалоги («поддиалоги»): предложение по реализации

Статус: **предложение, ждёт одобрения координатора**. Общие файлы (`src/ProjectTree.tsx`,
`src/ProjectSidebar.tsx`, `src/Workspace.tsx`) до одобрения не изменяются.

Дата аудита: 2026-10-09. Проверено на установленных Codex App Server **0.156.1** и
Claude Agent SDK **0.3.278** (`node_modules/@anthropic-ai/claude-agent-sdk`).
Все проверки — **только чтение**: `thread/list` и `thread/read`. Ни одного `turn/start`,
`thread/start`, `thread/fork`, мутации, записи в SQLite/rollout и ни одного запроса модели.
Сырые отчёты: `artifacts/subdialog-probe/report.json` … `report6.json`
(каталог `artifacts/` в `.gitignore`, это локальные свидетельства).

---

## 1. Доступные метаданные и свидетельства протокола

### 1.1. Схемы протокола (локальные, сгенерированные)

`protocol/v2/Thread.ts` уже объявляет три поля связей, и они **уже доходят до renderer**:
`listProjectThreads` возвращает `result.data` без фильтрации полей, а `src/types.ts`
объявляет `Thread` с `[key: string]: any`.

| Поле | Комментарий схемы |
| --- | --- |
| `sessionId` | «Session id shared by threads that belong to the same session tree» |
| `forkedFromId` | «Source thread id when this thread was created by forking another thread» |
| `parentThreadId` | «The ID of the parent thread. This will only be set if this thread is a subagent» |
| `agentNickname` | «Optional random unique nickname assigned to an AgentControl-spawned sub-agent» |
| `agentRole` | «Optional role (agent_role) assigned to an AgentControl-spawned sub-agent» |
| `source` | `SessionSource`, включая `{ subagent: SubAgentSource }` |

`protocol/SubAgentSource.ts`:
`"review" | "compact" | { thread_spawn: { parent_thread_id, depth, agent_path, agent_nickname, agent_role } } | "memory_consolidation" | { other: string }`.

`protocol/v2/ThreadSourceKind.ts`: `"cli" | "vscode" | "exec" | "appServer" | "subAgent" |
"subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn" | "subAgentOther" | "unknown"`.

Сейчас оболочка везде фильтрует интерактивные источники
(`electron/thread-management.mjs:6` — `sourceKinds = ['appServer','cli','vscode']`,
`electron/project-history.mjs:47` — то же), поэтому дочерние диалоги в списках **никогда
не появляются**. Полный набор (`allSourceKinds`, строка 7) используется только для сверки
архива при `archive`/`delete`.

Связи уже частично используются на host: `ThreadActionCoordinator.related()` обходит цепочку
`parentThreadId`, а `manageThread` разрешает цепочки родителей перед действием над потомками
(`electron/thread-management.mjs:22`, `:185`). То есть **модель связей в проекте уже есть —
её просто не видно в интерфейсе**.

### 1.2. Локальные rollout-метаданные (379 файлов `~/.codex/sessions`)

Перепись `session_meta` по первому кадру каждого rollout:

| `thread_source` | `source` | подвид | кол-во |
| --- | --- | --- | --- |
| `guardian_review` | `subagent` | `other` | 247 |
| `subagent` | `subagent` | `thread_spawn` | 66 |
| — | `vscode` | — | 58 |
| `user` | `vscode` | — | 7 |
| `user` | `cli` | — | 1 |

- `parent_thread_id` заполнен у 313, `forked_from_id` — у 67.
- У 66 настоящих `thread_spawn` потомков `parent_thread_id == forked_from_id`
  (spawn ответвляет контекст родителя).
- 247 `guardian_review` имеют `parent_thread_id`, но **не** `forked_from_id`.
- Ровно 1 запись — пользовательское ответвление: `forked_from_id` есть, `parent_thread_id`
  нет (`01a0be33… ← 01a0be21…`, тот самый fork из [TABS.md](../TABS.md)).
- В rollout `session_meta.session_id` равен **корню цепочки**: у всех 116 потомков с
  разрешимой цепочкой `session_id == корень`. Есть реальные цепочки глубины 2.
- `agent_nickname` заполнен у spawn-потомков (46 различных: Franklin, Godel, Euler…),
  `agent_path` — вида `/root/install_docs`, `/root/shell_ux`.

### 1.3. Что реально отдаёт живой App Server 0.156.1 (ключевой результат)

Перепись `thread/list` по одному `sourceKind` для `cwd = E:\My projects\CodexDesk`
(`report3.json`):

| `sourceKind` | записей | из них с `parentThreadId` |
| --- | --- | --- |
| `vscode` | 6 | 0 |
| `subAgent` | 60 (+ страницы) | все |
| `subAgentOther` | 60 (+ страницы) | все |
| `appServer`, `cli`, `exec`, `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `unknown` | 0 | 0 |

Поведение полей (`report.json`, `report2.json`):

- **`parentThreadId` в `thread/list` заполняется только при трёх условиях одновременно:**
  `sourceKinds` включает `subAgent*`, **передан фильтр `cwd`**, и **не** передан
  `useStateDbOnly: true`. Измерено на одном и том же наборе:
  `all + cwd + useStateDbOnly:false` → 34 из 40 с родителем;
  `all + cwd + useStateDbOnly:true` → **0 из 40**;
  `all` без `cwd` → **0 из 40**.
  Один и тот же thread `01a12214-7b18…` в запросе без `cwd` отдаёт `parentThreadId: null`,
  а с `cwd` — `01a12214-250e…`. Заполняет его разбор JSONL (scan-and-repair), а не state DB.
- **`forkedFromId` в `thread/list` не заполняется никогда** — 0 во всех пяти вариантах,
  включая известный fork. В `thread/read` он есть.
- **`sessionId` в `thread/list` и `thread/read` всегда равен `id`** (60/60, 40/40, 12/12,
  и у всех прочитанных потомков). Корень дерева сессий, записанный в rollout, через
  протокол **не отдаётся**. → `sessionId` как ключ группировки **непригоден**.
- `source` приходит структурой с camelCase-внешним ключом (`subAgent`) и snake_case внутри.

`thread/read` по известным ID (`report6.json`):

| Что это | `source` | `agentNickname` | `parentThreadId` | `forkedFromId` |
| --- | --- | --- | --- | --- |
| spawn-потомок Franklin | `{subAgent:{thread_spawn:{parent_thread_id,depth:1,agent_path:"/root/install_docs",agent_nickname:"Franklin",agent_role:null}}}` | `Franklin` | родитель | = родитель |
| spawn-потомок Godel | то же, `agent_path:"/root/shell_ux"` | `Godel` | родитель | = родитель |
| guardian-потомок | `{subAgent:{other:"guardian"}}` | `null` | родитель | `null` |
| пользовательское ответвление | `"vscode"` | `null` | `null` | источник |
| родитель-планировщик | `"vscode"` | `null` | `null` | `null` |

**Вывод: `source` — достоверный дискриминатор вида связи, и он доступен прямо в `thread/list`.**

Важная оговорка: фильтры `subAgent` и `subAgentOther` в этом проекте вернули **идентичные
множества** (135 == 135, пересечение полное). То есть `sourceKinds` не отделяет исполнителей
от служебных потоков — отделяет только разбор `source`. Классификация строится на `source`,
а не на `sourceKind`.

### 1.4. Claude Code — связей нет

`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5486`, `SDKSessionInfo` (единственный
тип, который возвращают `listSessions` и `getSessionInfo`) содержит `sessionId`, `summary`,
`lastModified`, `fileSize`, `customTitle`, `firstPrompt`, `gitBranch`, `cwd`, `tag`,
`createdAt` — и **ни одного поля родителя, ответвления или дерева сессий**.
`ForkSessionResult` (`:790`) возвращает только `{ sessionId }` новой сессии.
`forkedFrom` существует лишь на отдельных кадрах транскрипта, причём `getSessionMessages`
его удаляет; `electron/claude-history.mjs:327` восстанавливает только UUID скопированных
кадров через `importSessionToStore` — это нужно для таймера кэша и **не даёт** ID исходной
сессии. Подагенты Claude (`Agent`/`Task`) своей сессии в `listSessions` вообще не получают:
они живут внутри транскрипта родителя под `parent_tool_use_id`, см. [SUBAGENTS.md](../SUBAGENTS.md).

→ Для Claude связь **недоступна**, и так и будет показана. Угадывать по названию,
времени или `cwd` — запрещено заданием и не делается.

### 1.5. Оговорка о пользовательском сценарии

Сценарий «планировщик создаёт несколько исполнителей» в этом проекте выполняется
**вручную координатором**: диалоги агентов A/B/C/D — независимые верхнеуровневые threads с
`source: "vscode"`, `parentThreadId: null`, `forkedFromId: null`, `sessionId == id`
(проверено `thread/read`, `report5.json`). **Для такого способа создания backend не
сообщает связи вообще.** Эти диалоги останутся плоскими и получат явную подпись
«связь не указана», а не выдуманную группу. Группировка заработает для диалогов,
созданных штатным `spawnAgent` Codex.

---

## 2. Выбранная модель связей

Новый чистый модуль `src/thread-relations.ts` — без IPC, без React, полностью покрываемый
модульными тестами.

```ts
export type RelationKind =
  | 'root'        // source не subAgent, parentThreadId и forkedFromId пусты
  | 'spawn'       // source.subAgent.thread_spawn — исполнитель, созданный spawnAgent
  | 'service'     // source.subAgent.{other|review|compact|memory_consolidation}
  | 'fork'        // forkedFromId есть, parentThreadId нет
  | 'unavailable';// провайдер не сообщает связей (Claude)

export type ThreadRelation = {
  threadId: string;
  parentId: string | null;      // ТОЛЬКО из parentThreadId или forkedFromId
  kind: RelationKind;
  evidence: 'parentThreadId' | 'forkedFromId' | 'source' | null; // чем доказано
  label: string | null;         // agentNickname, иначе agentRole, иначе agent_path
  depth: number | null;         // source.subAgent.thread_spawn.depth
  serviceKind: string | null;   // 'guardian' | 'review' | 'compact' | …
};
```

Правила, которые модуль обязан соблюдать:

1. `parentId` берётся **только** из `parentThreadId`, а при его отсутствии — из
   `forkedFromId`. Ни заголовок, ни время, ни `cwd`, ни порядок в списке источником связи
   не являются.
2. `sessionId` **не используется** — измерено, что он всегда равен `id` (§1.3).
3. `evidence` фиксирует, каким полем доказана связь. В интерфейсе это даёт разные подписи:
   «подагент» (`parentThreadId`) против «ответвление» (`forkedFromId`).
4. Вид связи определяется разбором `source` с терпимостью к обоим вариантам ключа
   (`thread_spawn` и `threadSpawn`): внешний ключ приходит camelCase, внутренний
   snake_case, и это не зафиксировано в сгенерированных типах.
5. `label` — только значения backend. Если `agentNickname`, `agentRole` и `agent_path`
   пусты (как у всех guardian-потоков), подписи нет; имя строки остаётся прежним
   `bulkThreadTitle(thread)`.
6. Провайдер `claude` сразу даёт `kind: 'unavailable'`, минуя разбор полей.

Группировка `buildRelationGroups(threads, children)`:

- группа = один **загруженный** родитель + его прямые потомки;
- **несколько независимых групп** — естественное следствие: ключ группы это `parentId`,
  они не сливаются;
- потомок, чей родитель отсутствует в загруженной истории, попадает в отдельную группу
  `orphan` с честной подписью «Родительский диалог не загружен», а не прикрепляется к
  похожему родителю;
- глубина > 1 поддерживается цепочкой `parentId`; циклы отсекаются `Set` посещённых
  (как уже делает `ThreadActionCoordinator.related`);
- потомки с `kind: 'service'` **никогда** не показываются как исполнители: они
  складываются в свёрнутый счётчик внутри группы. Причина измерена: 247 из 379 локальных
  rollout и 135 из 141 связанных диалогов этого проекта — автоматические guardian-ревью.
  Без этого разделения боковая панель заполнится строками «The following is the Codex agent
  history whose request action…».

---

## 3. Размещение и взаимодействие в интерфейсе

Используется существующая система: классы `.folder-tree-entry`, `.folder-threads`,
`.folder-thread[data-thread-id]`, `.folder-thread-row`, `.archive-folder-count`,
`AgentLogo`, `ThreadMenu`, иконки `lucide-react`, паттерн панели поверх проектов из
`archive.css`. Новых цветов и шрифтов не вводится; новый файл `src/thread-relations.css`
содержит только отступ вложенности, направляющую линию и бейдж счётчика.

**A. Вложенность в дереве проекта (`ProjectTree`).**
Строка родителя, у которого есть загруженные потомки, получает слева disclosure и справа
бейдж `Подагенты: N` (тот же `.archive-folder-count`). Потомки рисуются под родителем с
отступом, каждый — обычная `.folder-thread` с `data-thread-id`, значком агента и подписью
`agentNickname` рядом с названием. По умолчанию группа **свёрнута**, состояние хранится
по `projectKey + parentId` рядом с существующим `expanded` в `Workspace`, поэтому
переключение вкладок его не сбрасывает. Открытие потомка — обычный `openThread`.
Служебные потоки — одна свёрнутая строка «Служебные диалоги агента: N» с пояснением,
что это автоматические ревью и сжатия Codex.

**B. Отдельный вид «Подагенты» (`src/SubdialogsView.tsx`).**
Переключатель рядом с существующей кнопкой «Архив» внизу панели (тот же паттерн
`archive-toggle`, `aria-expanded`, панель поверх проектов). Вид показывает карточки групп
по всем зарегистрированным папкам: заголовок — название родителя и его папка, внутри —
потомки со своим видом связи, подписью агента и глубиной. Для диалогов Claude в этом виде
выводится одна строка на группу: **«Связи недоступны: Claude Code не сообщает родителя
диалога»**. Вид только навигационный: переход к диалогу и «Обновить». Он не запускает
агентов, не отправляет модельных запросов и не содержит действий изменения.

**C. Чего в этой версии нет (по заданию).**
Никаких разрушающих действий: ни «удалить группу», ни «архивировать всех потомков»,
ни остановки потомков. Меню ⋮ у строк потомков показывает **тот же** набор, что и сейчас
(`rename`/`archive`/`delete`/`fork`), с теми же блокировками `threadLocked`; новых пунктов
не добавляется. Поведение модели, промпты и число запросов не меняются.

---

## 4. Поведение с архивом, поиском и пагинацией

- **Пагинация истории папки не меняется.** Существующий составной курсор
  `desk:{cwd,codex,claude}` в `host:listProjectThreads` остаётся как есть.
  Потомки читаются **отдельным** вызовом со своим курсором, только когда папка раскрыта.
  Это сознательный отказ от подмешивания потомков в основной список: иначе страница из 40
  записей на этом компьютере заполнилась бы guardian-потоками, а `nextCursor` папки
  перестал бы соответствовать видимому.
- **Новая граница host:** `host:listThreadChildren({ cwd, cursor? })` →
  `thread/list` с `sourceKinds: ['subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther']`,
  обязательным фильтром `cwd` (без него `parentThreadId` пуст — §1.3), без
  `useStateDbOnly`. Папка проверяется тем же способом, что в `listProjectThreads`:
  только точная зарегистрированная canonical папка. Только чтение, allowlist мутаций не
  расширяется.
- **Архив.** Архивные потомки и так скрыты из обычной истории
  (`host:listProjectThreads` убирает архивные ID). Панель архива в этой версии
  **сохраняет** текущую плоскую группировку по папкам: `listArchivedThreads` использует
  интерактивные `sourceKinds`, поэтому потомков в ней нет, и вложенность там нечего
  показывать. Это зафиксировано как ограничение, а не как сделанная работа.
  Семантика `archive`/`delete` для потомков не меняется: существующее подтверждение
  удаления уже предупреждает об удалении дочерних диалогов
  ([ARCHIVE.md](../ARCHIVE.md)), и `ThreadActionCoordinator` уже проверяет занятость
  потомков по цепочке `parentThreadId`.
- **Поиск.** `thread/list` с `searchTerm` использует интерактивные `sourceKinds`
  (`electron/thread-management.mjs:100`), значит потомки в результатах поиска не
  появляются и вложенность к ним не применяется: область поиска остаётся плоским
  множеством результатов, как сейчас. Если родитель найденного диалога известен из уже
  загруженных связей, строка получает только неинтерактивный чип «Подагент …» —
  навигация, подсветка и группировка по папкам не меняются.
- **Массовый выбор.** Названная область выбора остаётся прежней — «загруженная история
  одной папки» или «загруженные результаты одного поиска». Строки потомков в область
  **не входят** и в режиме выбора показываются без чекбокса. Причина: `BulkArchiveBar`
  считает «Выбрать все (N)» по переданным `rows`, и молчаливое включение потомков
  изменило бы смысл уже проверенной области. Это явное ограничение версии.
- **Вкладки, переименование, восстановление.** Строки потомков используют тот же
  `openThread`, `ThreadMenu` и `threadLocked`, поэтому переименование, ответвление и
  архивация работают без изменений. Поиск уже открытой вкладки по `cwd + threadId`
  не затрагивается.

---

## 5. Ограничения провайдеров

1. **Claude Code — связей нет.** `SDKSessionInfo` не содержит родителя/ответвления (§1.4).
   Показывается «Связи недоступны», без догадок.
2. **Codex: `sessionId` бесполезен.** Всегда равен `id` в `thread/list` и `thread/read`,
   хотя rollout записывает корень дерева. Группировка по нему была бы ложной.
3. **Codex: `forkedFromId` отсутствует в `thread/list`.** Доступен только в `thread/read`,
   то есть один дополнительный RPC на диалог. В этой версии происхождение ответвлений в
   боковой панели **не показывается** — массовый `thread/read` ради украшения списка не
   оправдан. Поле уже учтено в модели (`kind: 'fork'`), чтобы ленивое чтение по явному
   действию можно было добавить следующим шагом без переделки.
4. **Codex: `parentThreadId` зависит от пути чтения.** Нужны `subAgent*` в `sourceKinds`,
   фильтр `cwd` и отсутствие `useStateDbOnly: true`. Если Codex изменит scan-and-repair,
   связи станут пустыми — интерфейс обязан это показывать как «связь не указана», а не
   терять потомков молча.
5. **Служебные потоки доминируют.** 247/379 локальных rollout и 135/141 связанных
   диалогов этого проекта — `{subAgent:{other:"guardian"}}` без `agentNickname`.
   Отличить их можно только разбором `source`: `sourceKinds: ['subAgent']` и
   `['subAgentOther']` вернули идентичные множества.
6. **Ручной способ создания исполнителей связей не даёт.** Диалоги, созданные как
   независимые верхнеуровневые threads (как агенты A/B/C/D этого поручения), не имеют
   `parentThreadId`/`forkedFromId` и останутся плоскими (§1.5).
7. **Структура `source` не совпадает со сгенерированными типами** по регистру ключей:
   на проводе `subAgent` + `thread_spawn`. Разбор терпим к обоим вариантам.
8. `agentNickname`/`agentRole` в `thread/list` у guardian-потоков `null`; подпись
   появляется только там, где backend её дал.

---

## 6. Файлы, которые будут изменены

Новые:

- `src/thread-relations.ts` — чистая модель: разбор `source`, `ThreadRelation`,
  `buildRelationGroups`, классификация служебных потоков, `relationSupport(provider)`.
- `src/SubdialogsView.tsx` — отдельный вид «Подагенты».
- `src/thread-relations.css` — отступ вложенности, направляющая линия, бейдж.
- `electron/thread-children.mjs` — read-only чтение потомков папки
  (`thread/list` с `subAgent*` + `cwd`), по образцу `electron/project-history.mjs`.
- `tests/thread-relations.test.mjs` — модульные тесты модели.
- `tests/thread-children.test.mjs` — параметры и границы host-чтения.
- `scripts/ui-subdialogs.mjs` + `npm run test:subdialogs` — сценарий production renderer
  с подставными scoped bridges.

Изменяемые (**общие — только после одобрения координатора**):

- `src/ProjectTree.tsx` — вложенные строки потомков, бейдж, свёрнутые служебные потоки.
- `src/ProjectSidebar.tsx` — переключатель вида «Подагенты», чип родителя в результатах
  поиска.
- `src/Workspace.tsx` — состояние потомков по папкам (загрузка, курсор, ошибка,
  раскрытие групп), подключение нового вида; `loadProjectHistory` не переписывается.
- `src/types.ts` — объявление `listThreadChildren` в `CodexBridge`/host-мосте и типы связей.
- `electron/main.mjs` — обработчик `host:listThreadChildren` рядом с
  `host:listProjectThreads`, под теми же проверками окна и блокировкой на время setup.
- `electron/preload.cjs` — одна строка проброса `listThreadChildren`.
- `package.json` — одна строка `test:subdialogs`.
- `docs/SUBAGENTS.md` — новый раздел о связях родитель→потомки и измеренные ограничения.
- `AGENTS.md` — обновление строки индекса «Подагенты».

Не изменяется: `protocol/` (сгенерированные схемы), `electron/thread-management.mjs`
(allowlist мутаций и действия над диалогами), `electron/claude-*` (у Claude связей нет),
логика архива, поиска, пагинации истории папки, массового выбора, брендинг, Release/Nightly.

---

## 7. Решения координатора — 2026-10-09

| Вопрос | Решение |
| --- | --- |
| Интерфейс | **И вложенность в дереве проекта, и отдельный вид «Подагенты»** (вариант A + B из §3). |
| Служебные потоки Codex | **Свёрнутый счётчик внутри группы** («Служебные диалоги агента: N»), раскрываемый по желанию. Не прятать факт и не засорять панель. |
| Происхождение ответвлений (`forkedFromId`) | **Отложить на следующий шаг.** Модель оставляет `kind: 'fork'` и `evidence: 'forkedFromId'`, но массовых `thread/read` в боковой панели не будет. |

Охват сначала был отложен до появления штатного spawnAgent-сценария: измеренный факт §1.5
показывает, что сейчас исполнители создаются как независимые верхнеуровневые threads без
связей. Затем координатор отменил отсрочку и поручил реализацию. Решение зафиксировано
вместе с причиной: группы заработают для диалогов, созданных `spawnAgent`, а созданные
вручную останутся плоскими с честной подписью. Отвергнутый альтернативный путь — выводить
связь из заголовков, времени или порядка — остаётся отвергнутым сознательно.

**Реализовано 2026-10-09.** Фактический результат, отличия от этого плана и проверки —
[agent-c-subdialogs.md](agent-c-subdialogs.md); поведение — раздел «Зависимые дочерние
диалоги» в [SUBAGENTS.md](../SUBAGENTS.md).
