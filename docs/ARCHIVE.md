# Диалоги и архив

Запрос: вертикальное ⋮ в конце строки активного диалога с переименованием, архивацией и удалением; нижняя кнопка архива, панель поверх проектов и «Новый проект», группировка по папкам, чтение без отправки, удаление/восстановление. Дополнительно доступ и терминал поменяны местами.

## Интерфейс

`ProjectSidebar.tsx` объединяет кнопку нового проекта, `ProjectTree` и нижний toggle архива. Включённый архив скрывает проекты и перекрывает их панелью; логотип остаётся. Группы строятся по фактическим cwd архивных thread, отсутствующие в workspace папки тоже видны. Перечисление имеет nextCursor; новые страницы объединяются по ID. Меню `ThreadMenu.tsx` размещается portal-ом в пределах viewport, закрывается при Escape/клике снаружи/смене вкладки. Основная `.folder-thread[data-thread-id]` сохранена, ⋮ — соседняя кнопка, не вложенная.

`Workspace.tsx` вызывает действия, хранит modal переименования/подтверждения удаления, обновляет заголовки и оба списка. Название trim, 1…200 символов, одна строка. Удаление сообщает о необратимости и удалении дочерних диалогов. Неуспех RPC сохраняет вкладки и строки; успех закрывает затронутые обычные и архивные вкладки. Ошибка закрытия соединения после успешного RPC показывается отдельно, не отменяет факт удаления/архивации. `historyRevision` не позволяет старому ответу загрузки истории вернуть удалённые строки. Операция блокирует повторные клики/отправку/автопинг до завершения; занятый/ожидающий approval/открытый в терминале диалог изменять нельзя.

`ArchiveView.tsx` — отдельная вкладка без `useCodex`, `createSession`, `thread/resume` и composer. Использует готовые `Conversation` / `WorkLog`, показывает только полученные сообщения. Чтение/пагинация не запускают модель, compact, пинг или TUI. Legacy получает turns с таймингом; paginated читает items desc, разворачивает страницу в хронологический порядок, более старые страницы добавляет спереди. Для paginated здесь пока не запрашиваются дополнительные turn timing pages: длительность без данных не выдумывается. При восстановлении архивная вкладка закрывается; обычная история позволяет продолжить тот же thread ID.

Порядок footer обычного чата: доступ → терминал → кэш → токены. Архивная вкладка показывает footer только для чтения и кнопку восстановления. Её нижний sidebar сообщает «Архив Codex», без настроек активной модели.

## Протокол и границы host

Сверены локальные `protocol/v2/ThreadArchiveParams.ts`, `ThreadDeleteParams.ts`, `ThreadUnarchiveParams.ts`, `ThreadListParams.ts`, `ThreadReadParams.ts` и официальная страница https://developers.openai.com/codex/app-server/ (артефакт `artifacts/app-server-archive-doc.html`).

- `thread/name/set` → `{threadId,name}`.
- `thread/archive`, `thread/delete`, `thread/unarchive` → `{threadId}`.
- `thread/list` с `archived:true`, `modelProviders:[]`, `sourceKinds:['appServer','cli','vscode']` без cwd-фильтра — весь интерактивный архив текущего Codex.
- `thread/read` без resume; legacy includeTurns:true, paginated `thread/items/list`.

`electron/thread-management.mjs` содержит выделенный `ThreadManagement` App Server и общий для окон `ThreadActionCoordinator`. Root preload предоставляет только фиксированные `listArchivedThreads`, `readArchivedThread`, `manageThread`, `openArchivedPath`, без расширения generic mutation allowlist. UUID, cwd и имя валидируются; реальный thread/read должен совпасть с ID и cwd. Для чтения и восстановления принадлежность архиву перепроверяется серверным списком: поле archived у Thread отсутствует, устаревшему UI нельзя доверять.

Служебная сессия не меняет пользовательские настройки/модель и не вызывает turn/start. При недоступной сохранённой папке запускается в существующей fallback cwd. Восстановить историю можно и после удаления рабочей папки; открыть её для работы получится, когда папка существует. Существующая cwd восстановленного диалога добавляется в workspace.

Coordinator резервирует действие до async-чтения; собственные session RPC/terminal проверяют lock, `pendingThreadIds`, `currentThreadId`, `activeThreadTurns`, `compactingThreads` закрывают промежутки ACK и гонки. Связи parentThreadId проверяют занятых дочерних агентов. `thread/archived`/`thread/deleted` дают affected IDs; stale writers блокируются после успеха до восстановления. Другие независимые вкладки не останавливаются. При закрытии/crash renderer manager dispose инвалидирует очередь.

Ссылки архива открываются отдельным host handler: archived membership + cwd читаются из Codex, затем используются прежние `openLink`/`showLocalPathMenu` с проверкой границ проекта. Вложения восстанавливаются `electron/attachments.mjs`: только собственный attachments каталог userData, realpath, поддерживаемый image type, предел 20 МБ. Чужой localImage путь не читается.

Не меняются SQLite, rollout JSONL и глобальная конфигурация напрямую. При неподдерживаемом `thread/delete` UI показывает ошибку; скрытого файлового удаления или локального псевдоархива нет. По документации archive/delete затрагивают spawned descendants; пользовательский диалог подтверждения удаления это учитывает.

## Проверки

`tests/thread-management.test.mjs`, `tests/attachments.test.mjs`, `tests/preload-session.test.mjs`: параметры, связи, busy/terminal/approval/compact guards, read-only, неподдерживаемый метод, владение и disposal. `test:archive` использует production renderer + fake scoped bridges: меню, rename, ошибки, архив, группы, запреты записи, restore, удаление, пагинация, footer. `test:archive-host` — настоящий Electron/preload/IPC с отдельными Node JSONL fixtures и собственным хранилищем; поддерживает `CODEX_DESK_PACKAGED`.

Реальная read-only проверка установленного Codex приняла thread/list с фильтрами архива, вернула 0 записей. Пользовательская история не архивировалась и не удалялась; модель не вызывалась. Скриншоты: `artifacts/archive-readonly.png`, `artifacts/archive-restored.png`.

Финальная проверка 2026-09-17: 93 Node-теста, build, `test:archive`, `test:tabs`, `test:project-tree`, `test:commands`, `test:terminal` прошли. Архивная пагинация, ошибка закрытия после успешного RPC, блокировки при held requests и восстановление папки вне workspace проверены отдельно. `npm.cmd run package -- --config.directories.output=release/dialog-archive` обновил exe и `release/active-build.txt`. Packaged `test:archive-host` прошёл (`artifacts/archive-host-67KLec`); настоящий packaged `test:ui` подтвердил 6 моделей, Astra/Ultra и PNG без model turn. Все host-модули/preload и текущие dist assets в app.asar побайтно совпадают с проверенными исходниками. Пользовательское окно не закрывалось.
