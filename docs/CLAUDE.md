# Codex и Claude Code через CLI — 2026-09-19

Пользователь попросил переключать агента с Codex на Claude и подтвердил использование **Claude Code CLI**. Это отдельный движок, не модель Codex и не замена App Server прямыми вызовами API.

## Использование

В нижней строке composer появился выбор «Агент»: Codex / Claude Code. Смена открывает **новую вкладку** в той же папке. Старая беседа, черновик, очередь, выбранная модель и процесс остаются у прежнего агента. Истории не переводятся и не пересылаются другому агенту скрытым сообщением. Вкладка Claude помечена, ответы/пояснения/разрешения подписаны правильным именем.

Требуется установленный и авторизованный Claude Code. Поиск native claude.exe — `%USERPROFILE%/.local/bin` и PATH; при отсутствии можно выбрать exe в настройках текущей вкладки. Используются его существующие auth/env/settings/CLAUDE.md/MCP/инструменты. Приложение не добавляет system prompt, не включает bare/safe-mode/strict-mcp и не пишет Claude config.

Модели и effort берутся из stream initialize и get_settings; текущее **точное** имя сохраняется, даже если оно не совпало с alias каталога (нельзя автоматически заменить `claude-fable-5-1` на `[1m]`). На этом компьютере фактически получены `gpt-6-astra / ultra` и `claude-fable-5-1 / medium`; это наблюдение, не hardcoded defaults.

## Возможности первой интеграции

- Текст, потоковый ответ и реально переданные CLI пояснения, изображения (из собственного attachment store), видимые пути документов, инструменты и результаты, вопросы/разрешения, остановка, очередь следующих сообщений.
- Нативная история Claude по папке и resume; ID в оболочке `claude:UUID`, CLI получает только UUID. В дереве проекта истории обоих агентов объединены, курсор содержит независимые позиции. Поиск названий и архив остаются Codex — UI это обозначает. Меню ⋮ у диалога Claude предлагает **переименование и удаление** (см. ниже); архива у нативной истории Claude нет, поэтому пункт «В архив» не показывается.
- Кнопка терминала открывает Claude `--resume UUID` с выбранными моделью/effort/access и той же cwd. Возврат перечитывает нативную историю. Существующий Codex resume путь сохранён.
- **Уточнение во время выполнения** («Уточнить») пишет ещё один user-frame в stdin работающего CLI. По документированному протоколу CLI вклеивает такое сообщение в текущий ход между вызовами инструментов, а `result` перечисляет все поглощённые `user_message_uuids`. Если сообщение пришло после последнего обращения к модели, CLI выполняет его следующим ходом без повторной отправки (`queued_turn_count > 0`): оболочка закрывает первый ход и открывает второй с uuid этого сообщения. Если счётчика нет, показывается ошибка «Claude не учёл уточнение», а не зависший ход. Остановка отправляет `interrupt` с `cancel_queued`, поэтому неучтённые уточнения отбрасываются вместе с ходом. До 16 уточнений на ход.
- **Сжатие контекста** отправляет штатную команду `/compact` отдельным ходом; скрытых инструкций нет. Граница сжатия (`compact_boundary`) показывается как элемент `contextCompaction`, вывод локальной команды — как пояснение. Пока сжатие идёт, уточнения отклоняются. Пустой диалог сжимать нельзя.
- **Переименование** открытого диалога использует control-запрос `rename_session` (`source: host`), закрытого — `renameSession` официального SDK в папке проекта. **Удаление** останавливает простаивающие CLI-процессы этого диалога, вызывает `deleteSession` SDK и блокирует дальнейшую запись по этому ID; вкладки закрывает renderer после подтверждения. Занятый диалог, ожидающие разрешения или открытый терминал блокируют операцию так же, как у Codex. Реализация — `electron/claude-threads.mjs`, маршрутизация по префиксу `claude:` в `host:manageThread`.
- MCP Claude используется через его настройки/CLI, редактор config Codex не применяется. Неизвестные interactive tool cards отклоняются с объяснением вместо безусловного allow.
- Steer/compact/rename проверены на fixture-протоколе по типам SDK 0.3.278 (`tests/claude-client.test.mjs`, `tests/claude-threads.test.mjs`); живой прогон с реальными запросами модели для этих трёх действий ещё не выполнялся.

## Доступ и изоляция

«Спрашивать разрешение» — Claude default permissions, «Разрешать правки» — acceptEdits, «Полный доступ» — bypassPermissions после обычного явного подтверждения. Это режимы Claude, не эмуляция filesystem sandbox Codex. Legacy read-only отображается как планирование (plan); inherited не переопределяет CLI. Новые вкладки и обычный restart не включают сохранённый full автоматически; специальный Nightly checkpoint сохраняет прежнюю семантику уже подтверждённого доступа.

`SettingsStore` хранит defaults отдельно в `providers.codex`/`providers.claude`. Прежние поля верхнего уровня принадлежат Codex, Claude не наследует его executable/model/effort/access. provider принадлежит host-сессии и не меняется через setSettings. Scoped RPC и resume отвергают ID другого агента; workspace snapshot сохраняет provider и namespace. Git/файлы/откат общие проектные функции и по-прежнему проверяют занятость всех сессий проекта.

## Реализация

- `electron/claude-client.mjs`: EventEmitter adapter к документированному SDK stream/control протоколу установленного CLI 2.1.278: `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio --permission-prompts host`. initialize/get_settings не отправляют model turn. set_model/apply_flag_settings/set_permission_mode меняют только сеанс.
- `can_use_tool` переводится в существующий UI approvals; ответ возвращает исходный updatedInput только после explicit allow. AskUserQuestion переводит выбранные/свободные ответы обратно. Неподдерживаемые управляющие запросы получают ошибку, а не approve.
- `electron/claude-history.mjs` лениво использует официальный `@anthropic-ai/claude-agent-sdk@0.3.278`: listSessions/getSessionInfo/getSessionMessages. Системные/служебные/зашифрованные блоки исключаются; текущая ветка истории восстанавливается SDK. Exact cwd, max 128 МиБ /100000 сообщений; CLAUDE_CONFIG_DIR наследуется как у CLI. Файлы истории и SQLite не переписываются.
- В сборку включён только self-contained SDK reader (sdk.mjs+README), выполнение использует установленный native CLI; optional bundled binaries не поставляются. Peers SDK устанавливаются npm для разработки, packaged history reader не вызывает API/query SDK.
- `AgentContext` задаёт имя агента UI. Bootstrap capabilities блокируют неподключённые функции; при ошибке Claude не происходит тихого возврата к Codex.

## Проверки

### Реальная проверка модели — 2026-09-19

По явному поручению пользователя выполнен `node scripts/live-claude-check.mjs --run` через установленный Claude Code 2.1.278. Фактическая модель `claude-fable-5-1`, effort `medium` сохранены без нормализации alias. Отчёт успешного сценария: `artifacts/live-claude-check-i5yIMK/result.json`.

В отдельной временной папке получен потоковый ответ, Read/Edit запрашивали разрешение, `smoke.txt` изменился с `OLD\n` на `NEW\n` после одобрения. Native history прочитана SDK; после остановки процесса и resume модель вспомнила синтетический маркер `ORANGE-728` без повторной передачи. Последующая обратная правка остановлена на ожидающем разрешении Edit, файл остался `NEW\n`.

Успешный сценарий отправил 3 настоящих запроса модели. Первый запуск добавил ещё 1 запрос: lookup истории теста не совпал из-за Windows short path `LEGION~1`; тест исправлен canonical realpath, как уже делал production host. Всего 4 запроса, они расходуют лимит провайдера. `--run` требуется явно; обычные tests/build/bootstrap модель не вызывают. Ограничение инструментов/ask применялось только к тестовому процессу, глобальные settings/auth не менялись. Проверена остановка на ожидающем подтверждении, а не принудительное прерывание произвольного длительного внешнего инструмента.

Сообщения Claude теперь доступны в [библиотеке истории](HISTORY_LIBRARY.md); прежнее ограничение поиска названий в боковой панели остаётся. История native CLI не переписывается.

### Проверки без запросов модели

Claude transport unit tests: frame UTF-8, settings/protocol, поток/результат/эхо, tool/question approvals, interrupt, full flag, ошибка/timeout, изоляция изображений, настоящий отдельный Node child с JSONL и последовательными fixture turns. Реальной модели эти тесты не вызывают.

History tests включают официальный SDK на изолированном synthetic native history, проверку веток и побайтовую неизменность. Provider defaults/namespace/terminal/checkpoint проверены отдельно; UI `ui-providers` проверяет выбор, модели/черновики, capabilities, queue/files/labels и отсутствие CLI fallback при ошибке.

`scripts/ui-providers-host.mjs`: настоящий Electron и установленные Codex/Claude CLI, пустая тестовая cwd и отдельный профиль. Bootstrap/model catalog/settings isolation, новый агент через UI, обычный restart обеих вкладок и черновиков. `turn/start`/steer запрещены тестом на IPC границе. Реальный ответ провайдера не запрашивался; это проверка соединения и протокола, не live model smoke.

Поставка Nightly `fb92e5afdba488150816d4818721f0e7ddefedf44bfabaf97be52d0b43450b3e`: общий прогон 326 passed/2 платформенных skipped, затем финальные Claude transport 17/17 и provider/terminal 9/9. Прошли build, providers, model menus, composer layout, access, commands, message queue, composer files, workspace/nightly restore, tabs, notifications, chat-search. Готовый кандидат прошёл оба реальных CLI bootstrap и восстановление (`artifacts/providers-host-VVorXN`), identity (`artifacts/app-identity-XYIrQs`), workspace host (`artifacts/workspace-state-host-b5Rc6h`) и прежнюю очередь/steer Codex (`artifacts/message-queue-host-tLyCzW`). 72 файла manifest и изменённые host/renderer байты проверены; packaged SDK history reader загрузился. Release не изменён. Установка кандидата требует штатного закрытия Nightly.
