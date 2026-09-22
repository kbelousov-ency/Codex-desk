# Команды и сжатие контекста

Запрос: добавить стандартные команды, убрать из окна токенов пояснение о запуске compact и добавить саму команду в это окно. Реализован набор `/compact`, `/new`, `/status`, `/model`, `/permissions`, `/resume`, `/help`; весь набор команд терминального TUI не заявляется.

## Меню и маршрутизация

- `src/slash-commands.ts` содержит каталог и parser, `src/CommandMenu.tsx` / `src/commands.css` — компактное меню. `App.tsx` обрабатывает команды до отправки обычного сообщения и до busy-проверки: `/new` может открыть другую вкладку во время работы текущей.
- `/new` открывает диалог в текущей папке; `/resume` показывает только её историю и использует существующее открытие/повторное использование вкладки. `/model` и `/permissions` открывают штатные селекторы; `/status` закрепляет окно токенов. Для программного открытия используется `openSignal`.
- Распознавание без учёта регистра, только отдельная команда. Аргументы известных команд и вложения вместе с набранной командой отклоняются локально. Неизвестная отдельная `/foo` даёт подсказку `/help`. Пути `/src/file` и обычный текст не перехватываются; неизвестное `/foo текст` тоже обычный текст.
- Меню открывается по `/prefix` или кнопке «Команды Codex». Стрелки выбирают, Enter/Tab запускают, Escape закрывает. Явное меню закрывается при редактировании textarea. Enter без slash-подсказки требует явного выбора стрелками: иначе после `/help` обычное сообщение могло случайно запустить первую команду `/compact`. Проверяется сценариями без предварительного Escape.
- Набранная команда очищается лишь после успешного действия и только если текст не успел измениться. Запуск кнопкой поверх обычного черновика сохраняет текст и изображения. Меню и история блокируют автопинг на время выбора.

## Штатный compact

Протокол сверен с локальными `protocol/v2/ThreadCompactStartParams.ts`, `ThreadCompactStartResponse.ts`, `ContextCompactedNotification.ts` и официальными страницами:

- https://developers.openai.com/codex/app-server/
- https://developers.openai.com/codex/cli/slash-commands/

`useCodex.compact()` вызывает `thread/compact/start` с единственным параметром `{threadId}`. Host allowlist в `electron/window-session.mjs` разрешает точный метод. Нет `turn/start`, синтетического userMessage, нового thread, прямого модельного API или изменения model/effort.

Синхронный `activeRef` резервирует операцию, `busy`/`compacting` блокируют повторы и отправку. Нужны ready, существующий thread, отсутствие loading и ожидающих approvals. Компакт инвалидирует кэш/автопинг; черновик, изображения и видимая история сохраняются.

Ответ RPC `{}` означает принятие, не завершение. `CompactionOperation` хранит sequence/thread/turn identity и прежние turn IDs. После `turn/started` ожидается соответствующий `turn/completed`; без turn events допустим fallback `contextCompaction` item completion либо legacy `thread/compacted` с turnId. Запоздалые события и RPC callbacks прошлой операции не завершают новую. `willRetry:true` удерживает блокировку. Terminal failure, Stop, disconnect и очистка освобождают состояние; lookup `thread/read` для Stop защищён sequence/thread.

После завершения без новых usage сохраняются накопленный `total` и лимит, а `last=null`; свежие usage сохраняются. Прогноза экономии нет. Уведомления: «Сжатие контекста…», «Контекст сжат. Можно продолжить диалог.», «Сжатие контекста остановлено. Можно продолжить диалог.».

`TokenUsage.tsx` показывает внизу единственную кнопку «Сжать контекст /compact», состояние «Сжимаем контекст…» и disabled во время операции. Нажатие закрепляет popup. Прежний текст «Если запустить compact сейчас / Экономия заранее неизвестна» удалён по запросу; сведения о составе кэша сохранены.

## Проверки

- `tests/window-session.test.mjs`: точный `{threadId}` доходит до транспорта своей вкладки; другой транспорт не затронут.
- `npm.cmd run test:commands`: production renderer с подставным bridge; меню/клавиатура, команды, аргументы, пути, история, модель/доступ, изоляция, сохранение черновика/изображений, ACK, гонки, ошибки, retry, disconnect, Stop и токены. Узкие экраны 940/650.
- `npm.cmd run test:commands-host`: настоящий Electron/preload/scoped IPC с отдельным профилем и Node JSONL fixture; `/Compact` и кнопка вызывают точный RPC, сохраняют thread/model/effort/черновик/картинку, не создают команду как сообщение. Поддерживает `CODEX_DESK_PACKAGED`.
- `test:token-details` проверяет отсутствие старого пояснения и отсутствие запросов при hover/pin; `test:cache` — сохранность поведения таймера.

Эти проверки compact используют подставные события, не сжимают пользовательскую историю и не обращаются к модели. Настоящий bootstrap проверяется отдельно через `test:ui` без model turn. Скриншоты: `artifacts/standard-commands.png`, `artifacts/token-compact-action.png`; host artifacts записываются в `artifacts/commands-host-*`.

Проверено 2026-09-17: 64 Node-теста, build, `test:cache`, `test:token-details`, расширенный `test:commands` прошли. Упаковка `npm.cmd run package -- --config.directories.output=release/standard-commands` завершилась успешно и обновила `release/active-build.txt`. Packaged host regression прошла (`artifacts/commands-host-AkUEps`), как и настоящий `test:ui`: 6 моделей, унаследованные Astra/Ultra, вставка PNG, без model turn. Main/preload/window-session и текущие dist assets в app.asar побайтно совпадают с проверенной сборкой. Запущенное пользовательское окно не закрывалось; новый exe открывается обычным ярлыком после перезапуска.
