# Управление существующими беседами с телефона

Реализация — 2026-10-13. Публичные DTO и границы между двумя агентами:
[контракт v1](REMOTE_CONTROL_CONTRACT.md). Telegram-транспорт и компоненты подключены
после [передачи агента 2](agent-reports/agent-2-telegram.md); настройка — [TELEGRAM](TELEGRAM.md).

**Смена транспорта — 2026-10-15.** Ядро этого документа (адреса, grants, durable операции,
общий sender/FIFO) не менялось и остаётся действующим. Сменился только транспорт: личный
Telegram-бот выведен из поставки на этапе 5 [плана v2](TELEGRAM_MINIAPP_PLAN.md), его место
занял мост к relay-серверу ([RELAY_CONTRACT](RELAY_CONTRACT.md)). Поэтому ниже по тексту
`electron/telegram/*`, `window.codex.phoneAccess` и «Facade бота» надо читать как описание
прежнего потребителя: таких модулей и такого IPC больше нет. Разрешения по беседам
(`grantId`, поколение, default off, выдача только на ПК) общие для обеих схем и сохранены
как есть; в интерфейсе тот же переключатель теперь виден и списком «Доступ бесед»
в разделе настроек «Телефон».

## Живой smoke — 2026-10-14

Запущенная Nightly имеет build ID `b7b02daa3660`. Реальный Telegram update был принят,
grant выбран, а два сообщения дошли до remote controller и создали отдельные turns.
Оба turns завершились `serverOverloaded` на стороне Codex; успешный model answer через
Telegram ещё не подтверждён. Source fixture-набор после исправления статуса прошёл
`173 passed / 0 failed`; packaged Nightly пока содержит предыдущую формулировку для
failed completion и требует новой сборки.

## Устройство

`electron/remote-control.mjs` предоставляет main-process facade `RemoteControl`.
`remote-control-store.mjs` хранит `remote-control.json` в userData текущего канала:
разрешения с точными `grantId` и поколением, immutable request ID/payload, отдельный native UUID
сообщения и фазы операции. Запись сериализована, временный файл синхронизируется перед rename.
Ошибка/повреждение хранилища запрещают remote-действия; история CLI не изменяется.

`remote-control-host.mjs` связывает контроллер с конкретным смонтированным `App`
через scoped preload. `useRemoteControl` не зависит от выбранной вкладки.
Команда возвращается в штатные `useCodex.send/steer/stop` и `useMessageQueue`,
затем main повторно читает target и требует точного совпадения `grantId`, поколения и
owner/runtime target, immutable текста/UUID, родного активного turn, host guards и одноразового
permit непосредственно перед `WindowSession.request`. Несовпадение после revoke/regrant,
перепривязки или смены владельца блокирует `getThreadState`/`execute` и требует нового выбора.
Отдельной Telegram-очереди model calls нет.

`WindowSession.remoteRuntimeId` меняется при замене транспорта, start/resume/fork,
смене thread, stop и потере соединения; одного старого `generation` было недостаточно:
`_boot` с `refreshModels` заменял client без его увеличения. Восстановленный sessionId
не считается устойчивым адресом. Grant хранит точные provider/project/thread;
новая привязка увеличивает поколение. Несколько владельцев одного thread блокируют
удалённый доступ. Открытые внешние CLI дополнительно защищаются штатным writer-lock.

Разрешение default off, включается на ПК в настройках конкретного агента/беседы.
`window.codex.phoneAccess` управляет только локальной настройкой Telegram;
scoped `getRemoteThreadAccess/setRemoteThreadAccess` используют CAS и mainFrame.
Facade бота не имеет методов выдачи прав, настройки модели или ответа на approvals.

## Отправка, восстановление и отзыв

- Один синхронный sender согласует ПК, телефон, FIFO, автопинг и автодоставку исполнителей.
  `canStartMessage` не допускает обхода непустой FIFO; локальный composer добавляет
  следующий текст в неё. Лимит 50 проверяет сама очередь, а не только кнопка `App`.
- До remote RPC сохранены journal `dispatching` и workspace `pendingMessage`/FIFO.
  Capture читает pending из синхронного ref, не ждёт React render. `origin:'remote'`
  и remote context сохраняются validator; чужие provider/thread/UUID/kind и вложения
  отклоняются. Remote send и его сверка не очищают даже совпадающий локальный draft.
  У idle enqueue есть `holdUntilPersisted/releaseRemote`: FIFO не стартует до
  успешного сохранения приёма команды, даже если её собственный effect уже запустился.
- Timeout/потеря ACK не означают reject. После сбоя повтор автоматически не выполняется;
  exact live echo/late ACK/`message/status` уточняют прежнюю операцию. Numeric error
  считается reject только если штатный `uncertainDelivery` также исключил неопределённость.
  Отдельно учтён completion, пришедший раньше ACK.
- `steer/stop` привязаны к `expectedTurnId`; устаревшее уточнение не становится start.
  Claude может исполнить принятый steer следующим native ходом; завершение отслеживается
  по поглощённому UUID, а не по окончанию исходного turn. Второго prompt нет.
- Отзыв блокирует новые команды/чтение/события и удаляет waiting remote записи.
  Принятый ход не прерывается. Uncertain не маскируется как отменённая отправка.
  Remote payload в FIFO нельзя редактировать под прежним request ID; exact reject
  удаляется после сверки без возможности автоматического повтора.
- Restore всегда оставляет FIFO paused; старые runtime-команды не перепривязываются.
  `getOperation` принимает свежий target того же `grantId` и поколения для просмотра старой операции,
  но не меняет её исходный адрес и не повторяет её. Отсутствующее поколение — недоказанный адрес
  и блокирует replay до нового выбора.
- Ответы — только финальный assistant text. События не содержат tool events, файлов,
  журналов и содержимого approval/question. Последние дают фиксированное
  «Требуется действие на компьютере». Event ID перечитывается с проверкой доступа
  перед каждым outbound фрагментом; уже начатую сетевую отправку отозвать невозможно.

## Проверки

`tests/remote-control*.test.mjs`, `remote-dispatch-hooks.test.mjs`,
`remote-workspace.test.mjs` проверяют ledger, grants, host/renderer границы,
конкурентные отправки, IDs, late ACK, crash/restart, FIFO, guards и Claude follow-up.
`tests/preload-session.test.mjs` проверяет, что remote события не имеют default fallback.

`npm.cmd run test:remote-control-host` запускает настоящий production Electron,
renderer, preload, main и контроллер с отдельным JSONL CLI fixture. Он проверяет
локальное включение доступа, send/steer/stop, replay ID, stale stop, FIFO/отзыв,
durable запись до native запроса и сохранение draft/model/effort/access.
Дополнительно он включает настоящий TelegramService, локальные IPC token/pairing,
проверку владельца, выбор беседы кнопкой, сообщение и ответ через тот же контроллер;
HTTP Bot API подставной. Это **не живой Telegram и не запрос модели**.

Первый общий `npm.cmd run check`: 1161 passed, 2 skipped, TypeScript/Vite успешно.
Прошли queue UI/host, workspace-state-host, providers UI, terminal UI, executor-auto
и tabs host. В прежнем `ui-tabs` после `refreshModels` проверялся bootstrap PID;
журнал подтвердил новый PID, принявший второй запрос. Тест исправлен на этот PID
и прошёл; поведение приложения ради этой проверки не менялось.

После передачи агента 2 добавлены регрессии `remote-telegram-boundaries`:
отзыв именно во время pacing/retry_after, исчезновение названия из отложенной карточки,
unpair до отправки подготовленного ответа, сбой mapping до dispatch и неизменяемый
адрес при replay. Исходные пять ошибок исправлены, все шесть проверок проходят.
Текст исходной команды хранится в mapping только пока update не подтверждён durable;
после `_finish` удаляется. Сервис также инвалидирует свой экземпляр до await при
stop/disable/token/unpair, а ошибка записи больше не превращается в успешный локальный ответ.

Итоговая поставка Nightly и финальный общий check фиксируются в [RELEASES](RELEASES.md).

Итог: **1205 passed / 2 skipped**, TypeScript/Vite успешно. Nightly `648b134c40a8`
собран и прошёл сквозной тест на упакованном exe; 72 файла манифеста совпали.
Кандидат в штатной очереди, приложение пользователя не закрывалось.

Интеграционный Windows-прогон выявил `EPERM` при замене JSON: ранние попытки
останавливались без запуска команды на разных стадиях записи. Оба новых хранилища
теперь синхронизируют временный файл и до 10 раз повторяют только atomic rename
при `EPERM/EBUSY` (задержки 25–100 мс). Постоянный отказ сохраняет старый файл и
запрещает отправку. Тесты проверяют временный и постоянный отказ отдельно.
После исправления полный Telegram/Electron/FIFO fixture прошёл:
`artifacts/remote-control-host-v6NelY`. Приёмка не требует снимать pause, установленную
раньше через stop: локальное «Продолжить очередь» проверяется явно.

### Повторная проверка exe: `dQhhOc` → `yi14g6`

Разобран `artifacts/remote-control-host-dQhhOc`, packaged build `648b134c40a8`.
В `2026-10-13T08:57:40.608Z` запись `workspace-state.json` через
`host:saveWorkspaceState` (requestId 65, sequence 212) получила `EPERM`.
Это существующий `createSnapshotStore` в `electron/update-checkpoint.mjs`:
повторы atomic rename, добавленные двум новым remote/Telegram-хранилищам, здесь
не применяются. Конкретный процесс, вызвавший отказ Windows, журнал не устанавливает.

До отказа обычные remote send/steer/stop и текст через Telegram fixture прошли.
У `idle-fifo` native `turn/start` отсутствует: guard остановил его до RPC.
Снимок содержит пустую paused очередь с причиной «Удалённое сообщение не передано
агенту. Очередь приостановлена.», без pendingMessage; ledger получил
`cancelled/stale_target` при закрытии тестового окна в `08:58:00.645Z`.
Три ранних `host:getMcpConfig` ошибки относятся к отсутствующему `layers.user`
в fixture `config/read` и не являются причиной отказа отправки.

По поручению пользователя проверка того же exe повторена без изменения исходного
fixture/production-кода: **PASS**, `artifacts/remote-control-host-yi14g6`.
Настоящий Telegram и модель не вызывались; закрывалось только тестовое окно.
Успешный повтор не означает устранение `EPERM` в существующем workspace writer.

### Workspace writer: ограниченные повторы и барьер отправки — 2026-10-13

Проверка исходного журнала `dQhhOc` уточнила границу доказательств: запись sequence 212
содержит только IPC channel, `EPERM` и frame `main.mjs:374:20`, без `syscall`/пути.
Она не позволяет различить `mkdir`, запись временного файла и `rename`.
Cleanup не мог породить этот IPC-отказ: его ошибка уже подавлялась отдельно.
Владелец блокировки и точная системная операция исторического сбоя не установлены;
промежуточный `dispatching` не служит доказательством зависания Telegram.

`createSnapshotStore` теперь повторяет **только atomic rename**, по действующему
подходу remote-control-store и Telegram storage: Windows, `EPERM`/`EBUSY`, максимум
10 попыток, задержки 25/50/75/100 мс (в сумме не более 750 мс ожидания, без учёта I/O).
`mkdir`, `writeFile`, cleanup и вызов отправителя/CLI не повторяются. Уникальный
временный файл, замороженные до очереди bytes и сериализация сохранены; рабочий
`workspace-state.json` ради rename не удаляется. Неудачный cleanup может оставить
временный файл, но не маскирует исходную ошибку записи.

Окончательный отказ отклоняет save/IPC и `flush()`. Чтение прежнего снимка не снимает
ошибку flush; успешная последующая запись позволяет восстановиться. Обработчик
закрытия пишет ошибку flush в диагностику, избегая unhandled rejection; барьер
отправки продолжает ждать именно успешного сохранения. UI сохраняет существующее
сообщение об ошибке/повторе сохранения, а очередь — понятную причину паузы.

Детерминированная проверка: `workspace-writer-retry.test.mjs` — 14 сценариев:
временный/постоянный EPERM и EBUSY, бюджет повторов, прежние bytes, EACCES/ENOSPC,
другие платформы, mkdir/writeFile/cleanup, конкурентные и последовательные записи,
flush во время очереди и восстановление после отказа. В `remote-dispatch-hooks`
добавлены 8 сценариев с настоящими writer/useCodex/useMessageQueue и fixture bridge:
при окончательном отказе **0 native turn/start**, после успешного сохранения **1**,
duplicate enqueue и completion не вызывают второй запрос; проверены сохранённые UUID
и uncertain FIFO до native границы. Общий целевой набор — **48 passed / 0 failed**.
Это инъекционные fixture-проверки; настоящий Telegram и модель не вызываются.
Финальная общая приёмка и новый packaged build фиксируются отдельно в RELEASES.

### После передачи B: результат интеграции и блокировка сборки

Проверен полный `handleUpdates` B: обязательный сбой записи больше не становится
`failed/done` с продвижением offset. Открытая запись сохраняет routing/ownerGeneration
и исходный request ID; повтор после возможного dispatch сначала сверяет ledger ядра.
Tombstone request IDs ядро не удаляет по TTL; его `not_found` не скрывает ранее
принятую операцию. Постоянный отказ останавливает polling с локальной ошибкой:
после устранения причины нужен перезапуск или выключение/включение телефонного доступа.

Итоговый общий check: **1243 passed / 2 skipped / 0 failed**, TypeScript/Vite PASS.
Workspace/queue renderer и host PASS; полный source Electron/TelegramService fixture
PASS (`artifacts/remote-control-host-Iehc1A`). Финальные workspace/queue host:
`artifacts/workspace-state-host-u55nvg`, `artifacts/message-queue-host-5ZurmY`.
Всё без настоящего Telegram и без запросов модели.

`package` штатно заблокирован прежним queued build `648b134c40a8`: нового exe/build ID
нет, сквозная проверка **нового packaged exe ещё не выполнена**. Старый PASS не
используется как её замена. Полные результаты, исправленная гонка host-fixture,
два предшествующих отказа отдельного теста release-publication и дальнейшие шаги —
[RELEASES](RELEASES.md). История исходного workspace EPERM выше сохранена.
