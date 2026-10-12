# Исправление группировки диалогов

Дата: 2026-10-09

## Корневая причина

В пользовательском дереве и в панели «Группы» одновременно использовались две
разные модели:

- явные группы Кузьмич из `thread-groups.json`;
- нативные связи Codex из `buildRelationGroups()`.

Нативная модель специально создавала группу для каждого `parentThreadId`, даже
если родитель не был загружен. Такая orphan-группа затем рендерила техническое
имя через `parentTitleOf()`, в том числе повторяющиеся строки
«Родительский диалог не загружен». В Groups panel нативные группы также
показывались отдельными карточками «Подагенты Codex».

Дополнительная ошибка была в том, что flat-раздел строился только из основной
истории `threads`; загруженные отдельно native children не попадали в единую
секцию «Без группы».

## Изменения

- `src/ProjectTree.tsx`
  - удалён user-facing рендер native relation-групп и orphan fallback-строк;
  - убраны техническая relation-пагинация и relation-error из sidebar;
  - всегда показывается одна компактная секция «Без группы»;
  - дочерние/native данные могут участвовать только как обычные rows явной
    пользовательской группы или flat ungrouped rows.
- `src/SubdialogsView.tsx`
  - панель «Группы» показывает только явные группы из app-owned store и одну
    карточку «Без группы»;
  - удалена отдельная native «Подагенты Codex» карточка;
  - обновление панели не вызывает native relation refresh;
  - пустая/частично загруженная группа показывает только компактный счётчик,
    без placeholder-строк.
- `src/conversation-groups.ts`
  - ungrouped строится из объединения основной истории и загруженных children с
    дедупликацией по ID;
  - добавлен `count`: число явно назначенных диалогов, включая не загруженные
    страницы; native parent metadata не используется для назначения.
- `src/ConversationGroups.tsx`
  - badge и accessibility label используют общий явный count, а не только
    число видимых rows.
- `tests/conversation-groups.test.mjs`
  - добавлены проверки отсутствия native fallback-группы и единого flat-раздела
    для Codex/Claude/native child диалогов.
- `scripts/ui-conversation-groups.mjs`
  - renderer-проверка требует одну компактную секцию «Без группы» до создания
    пользовательских групп.

Хранилище явных групп, CRUD, добавление/удаление/перемещение, rename/delete,
сворачивание и создание нового диалога в группе не изменялись. История,
архивирование, поиск, pagination, tabs, drafts, settings и model behavior не
затрагивались.

## Поведение до/после

До:

- `parentThreadId` мог создать видимую группу без загруженного родителя;
- orphan-группы рендерили повторяющийся технический placeholder;
- Groups panel показывала native карточки «Подагенты Codex» рядом с app-owned
  группами;
- часть отдельно загруженных child диалогов не попадала в flat список.

После:

- видимы только группы, явно сохранённые приложением в `thread-groups.json`;
- каждый явно назначенный диалог появляется максимум в одной user group;
- остальные загруженные Codex и Claude диалоги появляются один раз в
  компактной секции «Без группы»;
- native parent metadata не создаёт секции, карточки или placeholder rows;
- пустая или частично загруженная явная группа показывает только count badge;
- длинные заголовки остаются ellipsis с tooltip через существующую UI-модель.

## Проверки

- `node --test tests/conversation-groups.test.mjs tests/thread-relations.test.mjs tests/thread-groups.test.mjs` — **48/48 passed**.
- `npm.cmd run test:groups` — **PASS**; production renderer, 38 bridge calls, 11 group writes.
- `npm.cmd run test:project-tree` — **PASS**.
- `npm.cmd run test:archive` — **PASS**.
- `npm.cmd run test:bulk-archive` — **PASS**.
- `npm.cmd run build` — **PASS** (`tsc --noEmit` + Vite build).
- `npm.cmd test` — **996 passed, 2 skipped, 0 failed**.

Проверки не запускают реальный model turn и не изменяют native history/SQLite.
Упаковка и публикация не выполнялись.

## Скриншоты

- `artifacts/conversation-groups-tree.png` — дерево с явными группами и
  компактным «Без группы».
- `artifacts/conversation-groups-panel.png` — панель «Группы» без native
  карточек.
- `artifacts/conversation-groups-delete.png` — подтверждение удаления группы;
  проверка сохранения самих диалогов.
- `artifacts/subdialogs-tree.png` — ранее сохранённый общий снимок панели для
  сопоставления.

## Ограничения

- `src/thread-relations.ts`, `src/ThreadRelations.tsx` и native child loading
  сохранены для внутренней совместимости и поддержки данных, явно добавленных
  пользователем в группу; они больше не являются источником видимых sidebar или
  Groups panel секций.
- Счётчик группы учитывает сохранённых участников, которых нет на текущих
  загруженных страницах, но открыть такой диалог из UI можно только после его
  загрузки в native history.
- Existing relation unit tests по-прежнему проверяют внутренний парсер native
  metadata; это не означает, что native relations отображаются пользователю.
