# Компактный ход работы — 2026-09-17

## Продолжение после остановки — 2026-09-18

В уведомлении «Выполнение остановлено. Можно продолжить диалог.» добавлена кнопка «Продолжить». Она появляется после соответствующего обычного `turn/completed.status=interrupted`, а не сразу после ACK `turn/interrupt`. `useCodex` хранит `{threadId,turnId}` остановленного хода в state/ref; старые или чужие события не создают кнопку. Нажатие `continueTurn()` использует обычный `send('Продолжай', [])`: сообщение видно в истории, модель/effort/доступ и thread прежние, новый thread не создаётся. Это новый ход в существующей беседе, не возобновление прерванного процесса инструмента.

Черновик и изображения composer сохраняются и не отправляются вместе с продолжением. Синхронный activeRef обычного send защищает от повторов. Busy/loading/terminal/disconnected/approvals и неподтверждённый resume запрещают нажатие; правила writer-conflict из [THREAD_RECOVERY.md](THREAD_RECOVERY.md) сохраняются. При RPC-ошибке до принятия нового хода исходная кнопка восстанавливается только если thread/sequence/lifecycle всё ещё те же; после нового live turn или смены подключения старое действие не возвращается. Новый ход, новый диалог/resume/disconnect, compact и передача в терминал сбрасывают состояние продолжения. Остановка compact не предлагает отправить «Продолжай». Действие показывается только в уведомлении об остановке, не в заменившем его предупреждении.

Проверки: `test:continue` — production renderer со scoped fixtures; `test:continue-host` — Electron/preload/IPC с Node JSONL и отдельным профилем, `CODEX_DESK_PACKAGED` для exe. Реальных turn модели и изменений пользовательской истории в этих проверках нет.

Поставка: build, `test:continue`, `test:resume`, `test:commands`, `test:cache` прошли. Скриншоты уведомления/аватара — `artifacts/continue-stopped.png`, `artifacts/continue-narrow.png`. Сборка `release/continue-avatar/win-unpacked/Codex Desk.exe` создана через package и записана в active-build; packaged host проверка прошла (`artifacts/continue-host-8YgF8W`). Настоящий packaged bootstrap получил 6 моделей, Astra/Ultra и проверил PNG без model turn. Host/preload/dist в app.asar совпадают с исходниками. Работающее пользовательское окно не закрывалось. Поиск исторического interrupted после перезапуска не добавлялся: кнопка привязана к текущему уведомлению о живой остановке.

Пользователь попросил сворачивать все пояснения перед итоговым ответом в строку с временем работы и возможностью раскрытия, а также уменьшить вертикальные интервалы чата, проектов и правой панели.

## Отображение

`src/Conversation.tsx` заменяет непосредственный map сообщений в App. `conversation-items.ts` группирует reasoning, plan, agentMessage с `phase:'commentary'` и tool items по turnId. При отсутствии turnId используются границы userMessage без выдумывания метаданных. Пользовательские сообщения и итоговые ответы остаются снаружи. Непомеченные agentMessage (`phase:null/undefined`) тоже остаются видимыми снаружи: не угадываем, какой из старых ответов финальный. Пустые reasoning не создают строки.

`src/WorkLog.tsx` рисует один details с `data-turn-id`. Во время работы раскрыт, при final_answer/answerStartedAt или terminal status сворачивается; последующее ручное раскрытие сохраняется на обычных рендерах и при работе других turn/вкладок. По завершении: «Работал 5 мин 2 с», при отсутствии времени — «Ход работы», при failed/interrupted/disconnected добавляется понятный статус. Финальный ответ не помещается внутрь disclosure.

Внутри пояснения/комментарии отображаются компактным Markdown с иконками, без прежних больших карточек. Команды, правки, поиск, агенты и просмотр картинок — короткие строки, раскрывающие полученные публичные результаты/вывод/diff. Тела инструментов монтируются по раскрытию. Никакие мысли/пояснения не генерируются оболочкой; hookPrompt и encrypted_content не раскрываются. Панель «Действия» справа остаётся доступной.

## Время и история

`TurnWork` в `src/types.ts`: id, status, startedAt/completedAt/answerStartedAt (ms), durationMs. `src/turn-work.ts` переводит серверные Unix seconds в ms, предпочитает durationMs. Только живые lifecycle-события получают fallback Date.now; старая история без времени не получает придуманной длительности. До turn/completed финальный phase останавливает промежуточный счётчик, после завершения используется подтверждённая длительность полного turn.

`useCodex` хранит map turnWork; получает начало/конец, отмечает первое final_answer, приписывает turnId оптимистичному userMessage после turn/start. Resume/legacy и paginated turns загружают метаданные; свежие live значения имеют приоритет над запоздавшей историей. Для ранее загруженных paginated items доп. метаданные читаются только пока не покрыты их turnId (не более 5 страниц по 100 на операцию); ошибка не скрывает уже доступные сообщения. Disconnect отмечает незавершённый turn disconnected без выдуманного времени окончания. Кэш/его freshness/пинг не переопределяются.

## Компактность

`src/compact.css` загружается после прежних стилей. Рабочие папки — строка 26px, диалоги и дерево файлов — 24px, заголовки действий — 28px. Уменьшены отступы карточек diff, планов, команд и промежутки сообщений; шрифты не уменьшены до нечитаемого размера. Итоговый Markdown line-height 1.6, пояснения 1.5. Сохраняется ограничение высоты колонок и независимая прокрутка.

## Проверки

`tests/turn-work.test.mjs`: server timestamp/duration, повторные уведомления, точность durationMs, поздний turn/start, merge live/history, interrupted/disconnected и неизвестное время. Все 57 Node-тестов прошли.

`scripts/ui-work-log.mjs` / `test:work-log`: final-start collapse до первого delta, 302000ms → 5 мин 2 с, раскрытие текстов/инструментов, изоляция turn/вкладок, пустые пояснения, история с known/unknown timing/phase, stop/error, компактная геометрия 1440/940. Подставные события и контролируемый clock, без реальных model turns. Артефакты: `artifacts/work-log-collapsed.png`, `artifacts/work-log-expanded.png`, `artifacts/compact-work-files-1440.png`, `artifacts/compact-work-files-940.png`.

Прежние scenarios/scroll/cache/tabs прошли; selectors reasoning-card заменены work-reasoning, конкретные outputs в сценарии привязаны к правой панели, чтобы не путать копии в раскрываемом ходе работы.

`npm.cmd run package -- --config.directories.output=release/compact-work-log` создал актуальную сборку и обновил active-build.txt. Packaged smoke с настоящим Codex подтвердил Astra/Ultra/6 моделей, дерево и PNG без model turn. Packaged test:sessions с отдельными JSONL fixtures подтвердил параллельные вкладки, историю/resume, остановку и перезапуск; артефакт `artifacts/tabs-3kjzfs`. Renderer в app.asar сверён с проверенным dist.

## Сворачивание при чтении длинного блока

По уточнению пользователя раскрытый заголовок work-log-summary закреплён через sticky top:0 внутри chat-scroll, с непрозрачным фоном и подписью «Свернуть». Пока пользователь читает середину блока, заголовок остаётся доступен. В конце добавлена отдельная кнопка «Свернуть ход работы». Прежнее сворачивание нажатием заголовка сохранено.

При явном сворачивании useLayoutEffect возвращает фокус summary с preventScroll и, только если он вне viewport чата, корректирует scrollTop до свёрнутого блока. Это оставляет доступным следующий итоговый ответ вместо пустой области прежнего высокого блока. Автоматическое сворачивание перед final_answer не использует этот перенос фокуса. Новые команды модели не отправляются, содержимое пояснений сохраняется.

Регрессия 940px выявила, что прежняя зависимость scrolledUp у follow-content effect сразу после collapse перематывала чат вниз: остаток менее100px выключал scrolledUp и скрывал возвращённый заголовок. Effect теперь реагирует на новые items/requests/busy/active; сам флаг прокрутки не вызывает переход вниз. Кнопка «К последнему сообщению» по-прежнему явно задаёт scrollTop.

`scripts/ui-work-collapse.mjs` / `test:work-collapse` прошёл: 130 абзацев, физический клик по sticky из середины/конца и при внутренней прокрутке output, нижняя кнопка Enter/мышь, фокус/заголовок/итоговый ответ остаются видимыми, контент и другой раскрытый turn сохранены на 1440/940. Старые test:work-log и test:scroll прошли. Скриншоты `artifacts/work-collapse-{mid,collapsed,footer}-{1440,940}.png`.

Сборка `release/work-collapse/win-unpacked/Codex Desk.exe` создана npm run package, active-build.txt обновлён; packaged smoke получил Astra/Ultra/6 моделей и PNG без модельного запроса. Renderer в app.asar совпадает с проверенным dist.
