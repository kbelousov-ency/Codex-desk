# Текущий диалог в терминале

Запрос: кнопка терминала под чатом, открывающая текущую сессию. Реализована отдельная интерактивная консоль установленного Codex с `resume <threadId> --cd <cwd>`, без стартового prompt. История и thread ID те же. Это не встроенный терминальный экран и не новая беседа; прежний отказ от встраивания TUI в основной чат остаётся в [AI_CONTEXT.md](AI_CONTEXT.md).

## UI и возврат

`App.tsx` показывает кнопку «Терминал» в `.composer-footer` перед доступом. Нет thread / busy / loading / disconnected / pending approvals — disabled с пояснением в title. `useCodex.openTerminal()` резервирует `terminalRef` синхронно до IPC, инвалидирует оценку кэша и выключает автопинг. Модель, effort и access передаются из текущих селекторов, включая восстановленные при resume значения. Черновик и изображения не передаются и не очищаются.

Scoped bridge: `openTerminal({threadId,model,effort,access}) → Promise<{threadId}>`. События `type:'terminal'`, `data:{state:'opened'|'closed',threadId,error?}`. `opened` означает запуск helper; ошибка дальнейшего запуска консоли приходит как `closed.error`.

Пока консоль открыта, эта вкладка сохраняет историю для чтения, блокирует отправку, compact, пинг, настройки и переподключение. Другие вкладки доступны. При `closed` hook запускает App Server заново и делает `thread/resume` текущего ID, читая свежую историю без model turn. Выбор модели/effort в оболочке сохраняется (`resume(selected,true)`); команды изменения модели в терминале не переносятся в селекторы. После чтения новые сообщения видны, прежние токены не выдаются за свежие. Ошибки возвращают возможность повторного подключения; поздний ACK/opened и повторный closed не ломают восстановление.

Вкладка отмечается иконкой терминала; её крестик отключён до возврата. Host также отклоняет `closeSession`, чтобы закрытие вкладки и повторное открытие истории не создали параллельного писателя. Закрыть всё приложение можно: внешний терминал продолжает жить. После перезапуска приложения состояние внешних консолей не восстанавливается; одновременное ручное открытие той же истории в нескольких клиентах Codex остаётся общим ограничением.

## Host и запуск Windows

- `WindowSession.openTerminal` использует только свой `currentCwd` и разрешённый executable. Renderer не выбирает исполняемый файл или папку через этот IPC. UUID, режим доступа, model/effort проверяются; `thread/read` должен вернуть тот же thread и папку, без active/inProgress и pending approvals.
- До чтения ставится блокировка. `pendingBoots`, `pendingMutations`, `activeThreadTurns` и повторная проверка transport/generation защищают от гонок: даже устаревший idle-ответ не перекрывает полученный `turn/started`.
- После проверки собственный простаивающий App Server останавливается. Две независимые копии Codex не пишут одновременно в историю этой вкладки. Mutation RPC, bootstrap и settings заблокированы до освобождения terminal lock. Закрытие окна не убивает внешнюю консоль, события в disposed-сессию не отправляются.
- История папок исключает terminal-owned вкладки из кандидатов; если других соединений нет, используется отдельный `historySession` только для чтения. Обновление списка не перезапускает приостановленную вкладку.
- `electron/terminal-launcher.mjs`: системный PowerShell запускает скрытый helper с `-NoProfile -NonInteractive -EncodedCommand`; helper создаёт видимый PowerShell через `Start-Process -WindowStyle Normal`. Внутри `& $codexExecutable @codexArguments` сохраняет пути/аргументы. Строки одинарно экранированы, UTF-16LE/base64 передаёт фиксированный script; нет `Invoke-Expression`, динамического prompt или `cmd /c`.
- Прямой Node `detached:true,stdio:'ignore'` был отвергнут по измеренной проверке: PowerShell завершался без выполнения, а NUL handles не давали интерактивный stdin. `Start-Process` подтвердил console handles для stdin/stdout/stderr. Helper ждёт завершения видимого процесса; host освобождает lock до события closed.
- Выбранные model/effort передаются `--model` и `-c model_reasoning_effort=…`. `inherited` не добавляет sandbox/approval overrides; `auto` → workspace-write/on-request/`approvals_reviewer=auto_review`, read-only/workspace-write → on-request/user, выбранный full → danger-full-access/never/user. Глобальный config не редактируется, `--yolo` не используется.

CLI-флаги сверены с `codex resume --help` установленного бинарника и https://developers.openai.com/codex/cli/reference/. Официальная страница сохранена в тестовом артефакте `artifacts/cli-reference-doc.html`.

## Проверки

- `tests/terminal-launcher.test.mjs`: точные аргументы, режимы, literal-экранирование, отклонение неверных значений, владение процессом.
- `tests/window-session.test.mjs` и `tests/preload-session.test.mjs`: собственная сессия/папка/executable, блокировки, гонки boot/RPC/live turn/approval, ошибки запуска, close/dispose.
- `test:terminal`: production renderer с подставными scoped мостами; кнопка, settings, черновик/картинка, кэш, две вкладки, ошибки, закрытие до ACK, история после возврата. Артефакты `artifacts/terminal-button.png`, `terminal-open.png`, `terminal-button-940.png`.
- `test:terminal-host`: настоящий Electron/preload/IPC и Windows launcher с отдельно скомпилированным `scripts/fixtures/terminal-server.cs`. Его JSONL-режим заменяет App Server, а resume-режим проверяет аргументы/console handles/cwd и завершается автоматически. `CODEX_DESK_PACKAGED` выбирает готовый exe.

Реальный Codex и модель не используются для теста передачи; пользовательская история не меняется. Native smoke также проверил пробелы, кириллицу, апостроф, `$()`, backtick, `;` и `&` в путях без интерпретации их как команд.

Проверено 2026-09-17: общий набор 77 Node-тестов и последующая отдельная регрессия истории (7 тестов) прошли, как и `test:terminal`, `test:commands`, `test:cache`, `test:token-details`, `test:tabs`. Сборка `release/session-terminal/win-unpacked/Codex Desk.exe` создана `npm.cmd run package`, active-build обновлён. Packaged `test:terminal-host` прошёл с настоящей консолью и подставным сервером (`artifacts/terminal-host-zUhO1j`). Отдельный packaged `test:ui` подключился к установленному Codex, показал 6 моделей и Astra/Ultra, проверил PNG без model turn. Main/preload/session/launcher/project-history и dist в app.asar побайтно совпадают с исходниками сборки. Пользовательское окно не закрывалось.
