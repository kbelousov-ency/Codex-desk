# Контракт удалённого управления беседами — v1

Дата: 2026-10-13. Владельцы: агент 1 — ядро и интеграция; агент 2 — Telegram.
Статус: контракт v1; реализация начата после команды пользователя «продолжить».
На первом этапе был подготовлен только этот файл; состояние кода и проверок —
[REMOTE_CONTROL.md](REMOTE_CONTROL.md).
Изменения публичных имён, DTO и семантики требуют явного сообщения агенту 2.

## Границы и проверенные исходные условия

Первая версия управляет только текстом в уже существующих, явно разрешённых беседах
Codex и Claude Code. Работает при запущенном Кузьмиче и открытой вкладке этой беседы,
включая невыбранную вкладку. Закрытую беседу удалённая команда не открывает.
Создание бесед, файлы, voice, веб-сервер, удалённые approvals/questions не входят в API.

Проверено по текущим исходникам:

- `useCodex.send` — общий низкоуровневый sender с синхронным `activeRef`;
  composer, FIFO, автопинг и автодоставка исполнителей уже используют его.
  Он может создавать thread при его отсутствии: для remote это запрещается явно.
- `useMessageQueue` хранит пользовательскую FIFO; лимит 50 пока проверяет `App.enqueueMessage`.
  До RPC очередь сохраняет `uncertain` через `flushSessionState`; после restore она paused.
- Guards распределены между `App.queueBlocked`, `useCodex.canSendQueued`, host IPC
  и `WindowSession`. Вызов одного `WindowSession.request` их не заменяет.
- Все обычные `App` остаются смонтированными в `Workspace`, в том числе скрытые.
  `sessionId` создаётся заново при restore. `WindowSession.generation` меняется в `stop`,
  но не при каждой замене client в `_boot`: нужен собственный `runtimeId` контроллера.
- `message/status`, live echo и late `message/receipt` дают точные ID; отсутствие ID
  в истории не доказывает отказ. Текущие host receipts ограничены 1000 и живут в памяти.
- Claude ACK steer означает принятие user-frame. CLI может сам выполнить его следующим
  ходом (`queued_turn_count`, `user_message_uuids`), без повторной отправки.

Ссылки: [очередь](MESSAGE_QUEUE.md), [сессии](SESSIONS.md),
[восстановление](WORKSPACE_STATE.md), [Claude](CLAUDE.md), [доступ](ACCESS.md),
[терминал](TERMINAL.md), [настройки](SETTINGS.md), [поставка](RELEASES.md).

## Владение кодом и схема исполнения

Агент 1 владеет `electron/remote-control.mjs`, `electron/remote-control-store.mjs`,
общим диспетчером отправки и его тестами; существующими `main.mjs`, `preload.cjs`,
`window-session.mjs`, workspace storage, `src/types.ts`, `App.tsx`, `Workspace.tsx`,
`useCodex.ts`, `useMessageQueue.ts`, `package.json` и lockfile.

Агент 2 владеет новыми `electron/telegram/*`, `src/PhoneAccessSettings.tsx`,
`src/TelegramThreadAccess.tsx`, их отдельными стилями, Telegram-тестами и `docs/TELEGRAM.md`.
Изменения зависимостей — через агента 1; для HTTP достаточно встроенного `fetch`.
Общие TypeScript DTO из этого контракта агент 1 экспортирует из `src/types.ts`.
Агент 2 может разрабатывать против fixture реализации интерфейсов ниже.

```text
TelegramService → RemoteControl (main: разрешения, адрес, durable операции)
                              ↓ scoped dispatch, только точному владельцу
Local UI / FIFO / исполнители / пинг → общий диспетчер беседы в renderer
                              ↓ штатный scoped preload → main guards
                              ↓ WindowSession → Codex App Server / Claude CLI
```

Один синхронный владелец резервирования отправки на беседу и одна пользовательская FIFO.
Host-журнал операций не является второй очередью. Адаптер каждого `App` регистрируется
по runtime-привязке и работает независимо от `activeId`; fallback на выбранную/default
вкладку отсутствует. Существующие механизмы отправки расширяются, а не дублируются.
При отсутствии живого адаптера контроллер возвращает `unavailable`, без прямого RPC.

## DTO: адрес и безопасное состояние

Все DTO — JSON, время — UTC ISO 8601, ID — непрозрачные строки, не пути.
`AgentProvider` — существующий тип `'codex' | 'claude'`.

```ts
export type RemoteTarget = {
  grantId: string;               // постоянный UUID разрешения на точную беседу
  generation: number;             // durable, увеличивается при отзыве/перепривязке
  provider: AgentProvider;
  threadId: string;               // точный ID оболочки, включая claude:UUID
  projectKey: string;             // непрозрачный ID проекта, назначает host
  sessionId: string;              // текущая runtime-сессия, никогда не достаточен один
  runtimeId: string;              // UUID incarnation владельца/транспорта
};

export type RemoteBlockReason =
  | 'busy' | 'approval' | 'question' | 'terminal' | 'restoring'
  | 'uncertain_delivery' | 'disconnected' | 'queue_paused' | 'queue_not_empty'
  | 'queue_full' | 'local_action' | 'closing' | 'settings_changing'
  | 'model_unavailable' | 'compacting' | 'unsupported' | 'ambiguous_owner';

export type RemoteThreadState = {
  target: RemoteTarget;
  revision: number;              // монотонно внутри runtimeId, не заменяет turnId
  phase: 'idle' | 'running' | 'blocked' | 'unavailable';
  activeTurnId: string | null;    // null также во время ещё не подтверждённого start
  queue: { count: number; limit: 50; paused: boolean };
  blockers: RemoteBlockReason[];
  actions: { send: boolean; enqueue: boolean; steer: boolean; stop: boolean };
  requiresComputer: boolean;
  updatedAt: string;
};

export type RemoteThread = {
  grantId: string;
  title: string;                 // название явно разрешённой беседы
  projectLabel: string;          // короткое имя, без абсолютного cwd
  provider: AgentProvider;
  target: RemoteTarget | null;   // null: закрыта, восстанавливается или неоднозначна
  availability: 'available' | 'unavailable' | 'ambiguous';
};

export type RemoteAnswer = {
  answerId: string;
  turnId: string;
  text: string;                  // только итоговый текст ассистента
  completedAt: string | null;    // null, если история не сообщает время
  truncated: boolean;
};
```

Host хранит полный нормализованный cwd: `path.resolve`, case-insensitive на Windows,
как существующий `projectKey` в main. В remote DTO он заменён непрозрачным `projectKey`;
сравнение не опирается на короткое имя папки. Разные worktree — разные проекты.
Тождество разрешения: `(provider, canonical cwd, threadId)`; `grantId` не переносится
на другой thread, проект или provider. Переключение источника подключения также
инвалидирует runtime-привязку. Никаких model/effort/access во входных remote-командах.

Разрешение default off. Включается на ПК для существующего, успешно возобновлённого
обычного диалога. Архив, пустая вкладка и неготовая история не подходят.
При close/reload/restore/client replacement и смене адреса старая привязка снимается
до следующего побочного действия; `generation` увеличивается durable, `runtimeId`
заменяется. Сохранённое разрешение можно привязать заново только к тому же кортежу,
после resume и проверки единственного владельца во всех окнах данного host.
Ошибка записи поколения запрещает remote-доступ. Старые команды не перепривязываются.
Если один thread открыт несколькими вкладками, контроллер отклоняет доступ к нему.
Проверка владения не обещает обнаружение всех внешних CLI; их writer-lock сохраняется.

## DTO: команды и результаты

```ts
type RemoteCommandBase = { requestId: string; target: RemoteTarget };
export type RemoteCommand = RemoteCommandBase & (
  | { kind: 'send'; text: string }
  | { kind: 'enqueue'; text: string }
  | { kind: 'steer'; text: string; expectedTurnId: string }
  | { kind: 'stop'; expectedTurnId: string }
);

export type RemoteErrorCode =
  | 'access_denied' | 'stale_target' | 'stale_turn' | 'ambiguous_owner'
  | 'unavailable' | 'blocked' | 'queue_full' | 'invalid_command'
  | 'request_conflict' | 'persistence_failed' | 'not_found';
export type RemoteError = {
  code: RemoteErrorCode;
  message: string;               // безопасный текст, без raw error/stack/команд
  requiresComputer: boolean;
  reason?: RemoteBlockReason;
};
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteError };

export type RemoteOperation = {
  operationId: string;           // внутренний UUID, постоянный
  requestId: string;
  target: RemoteTarget;          // исходный адрес, неизменяемый
  kind: RemoteCommand['kind'];
  phase: 'received' | 'queued' | 'accepted' | 'completed'
    | 'blocked' | 'stale' | 'rejected' | 'uncertain' | 'cancelled';
  revision: number;
  clientUserMessageId: string | null; // отдельный UUID для send/enqueue/steer
  expectedTurnId: string | null;
  executionTurnId: string | null; // у Claude steer может отличаться от expectedTurnId
  queuePosition: number | null;  // снимок позиции, не обещание постоянного номера
  outcome: 'succeeded' | 'interrupted' | 'failed' | null;
  error: RemoteError | null;
  createdAt: string;
  updatedAt: string;
};
```

`execute` возвращает `RemoteResult<RemoteOperation>`. `ok:true` означает, что имеется
durable запись операции; результат выполнения определяется `phase`, а не `ok`.
`ok:false` — валидация/доступ/конфликт/отказ сохранения до допуска операции; RPC не было.
Для неоднозначного исхода уже допущенного RPC всегда используется `phase:'uncertain'`,
а не ошибка, предлагающая повтор. Ответ не содержит исходный prompt или tool output.

- `send`: только готовая простаивающая беседа с пустой FIFO. Занятость даёт `blocked/busy`;
  непустая FIFO — `blocked/queue_not_empty`. Автоматического enqueue/steer нет.
- `enqueue`: добавляет запись в конец той же FIFO с единым лимитом 50, включая сообщения
  с ПК. После успешного durable сохранения — `queued`. Paused очередь остаётся paused;
  удалённого resume/edit/delete очереди в v1 нет. В idle готовой неприостановленной
  очереди первый элемент может начать исполнение; при busy ждёт успешного завершения.
- `steer`: только совпадающий активный `expectedTurnId`; повторная проверка непосредственно
  перед записью user-frame. Устаревшее уточнение — `stale/stale_turn`, без start/enqueue.
- `stop`: только указанный активный `expectedTurnId`, повторно сверенный перед interrupt.
  ACK interrupt — `accepted`, окончание именно этого хода — `completed`. Более новый ход
  не останавливается; при неизвестном turn ID кнопка недоступна до получения состояния.
- Текст непустой после trim, до 32 000 UTF-16 code units; `requestId` 1–200 символов.
  Неизвестные поля (включая model/effort/access/cwd/attachments) отклоняются.
  Slash-команды из Telegram не передаются CLI: управляющие команды разбирает бот,
  текст, начинающийся с `/` после trim, отклоняется как `invalid_command`.

`actions` — подсказка интерфейсу, не разрешение без повторной проверки. Approval/question
блокируют send/steer и исполнение FIFO, но не явное добавление в FIFO. Terminal/recovery,
uncertain и прочие guards также удерживают FIFO; enqueue допускается только если
проверен владелец и можно сохранить запись. Stop при approval/question/uncertain допустим
только для известного совпадающего активного хода, если штатный interrupt доступен;
он не отвечает на запрос разрешения. Terminal, restore, close/freeze не обходятся.
Окончательные `actions` вычисляет общий диспетчер, не бот.

## RemoteControl: единственный интерфейс агента 2 к ядру

```ts
export type RemoteEventNotice = { eventId: string }; // непрозрачный сигнал без содержимого
export type RemoteEvent = {
  eventId: string;
  target: RemoteTarget;
  at: string;
} & (
  | { kind: 'operation_changed'; operation: RemoteOperation }
  | { kind: 'state_changed'; state: RemoteThreadState }
  | { kind: 'answer_ready'; answer: RemoteAnswer; requestId: string | null }
  | { kind: 'computer_action_required'; message: 'Требуется действие на компьютере' }
);

export interface RemoteControl {
  listThreads(): Promise<RemoteResult<RemoteThread[]>>;
  getThreadState(target: RemoteTarget): Promise<RemoteResult<RemoteThreadState>>;
  getLastAnswer(target: RemoteTarget): Promise<RemoteResult<RemoteAnswer | null>>;
  execute(command: RemoteCommand): Promise<RemoteResult<RemoteOperation>>;
  getOperation(options: { target: RemoteTarget; requestId: string }): Promise<RemoteResult<RemoteOperation>>;
  subscribe(listener: (notice: RemoteEventNotice) => void): () => void;
  readEvent(eventId: string): Promise<RemoteResult<RemoteEvent>>;
}
```

`RemoteControl` — доверенный in-process facade в main, передаваемый TelegramService;
не Electron bridge и не универсальный RPC. Он не имеет grant/settings/respond методов.
TelegramService проверяет владельца телефона; ядро проверяет разрешение на беседу.
Недоступная/отозванная запись не раскрывается даже через `getOperation` и `readEvent`.
Read-only `getOperation` может штатно сверить receipt; это никогда не повторяет send.
После restart он принимает **свежий** target того же `grantId/provider/projectKey/threadId`
и возвращает сохранённую операцию с её неизменяемым исходным `operation.target`.
Проверяется действующее разрешение и единственный текущий владелец; смена runtime
не запрещает такой просмотр, но не перепривязывает исполнение. Replay `execute`
сохраняет исходную команду/target; старый адрес не заменяется новым ради повтора.

Подписка даёт только сигнал. Перед отправкой уведомления TelegramService вызывает
`readEvent`, который заново проверяет разрешение, поколение и актуальность привязки.
Событие от старого поколения возвращает `access_denied`/`stale_target`/`not_found`.
Telegram не кладёт готовый текст ответа в долговечную outbound очередь: хранит event ID,
а при каждой попытке снова получает разрешённое содержимое. Каждый фрагмент длинного
ответа проходит такую же проверку. Уже начатую отправку в Telegram отозвать нельзя;
после отзыва новые отправки не начинаются. Отключение/перепривязка телефона очищает
его pending уведомления; они не переходят другому пользователю.
Для прямых ответов на команды event ID не нужен: непосредственно перед сетевой отправкой
бот заново вызывает соответствующий read API (`listThreads`, `getThreadState`,
`getLastAnswer`, `getOperation`) и использует только его разрешённый результат.
Каждый фрагмент проверяется так же; `execute` для проверки никогда не вызывается.
Отказ доступа выдаётся как общее сообщение без прежнего названия/текста/состояния беседы.

События содержат только итоговый assistant text, безопасное состояние или фиксированное
уведомление. Никаких tool events, shell-команд как отдельных данных, вложений, журналов,
approval/question payload, credentials или полного settings. Текст ответа — plain text,
с лимитом 100 000 символов и `truncated`; не читать файлы и не скачивать URL из ответа.
Markdown пути/ссылки остаются текстом. Последний ответ берётся из завершённого хода:
приоритет `final_answer`; промежуточное commentary не выдаётся за результат.
Один ответ может быть доступен и после локального хода в разрешённой беседе.
Пинги, compact и загрузка истории не создают уведомления «задача завершена».
Повторные уведомления отбрасываются по event ID/operation revision, а не по тексту.
Подписка в v1 живая; replay всех событий после downtime не обещается. Durable принятые
request ID TelegramService может сверить через `getOperation`; последний ответ — явно.

## Durable данные, идемпотентность и lifecycle

| Данные | Единственный владелец |
| --- | --- |
| Разрешения, поколения, привязка к точному thread/project/provider | Ядро агента 1, `remote-control.json` в channel userData |
| requestId → неизменяемая команда, UUID сообщения, фазы, результат | Ядро агента 1, тот же сериализованный atomic store |
| Runtime registry, fencing и операции в исполнении | Ядро агента 1; runtime не восстанавливается из sessionId |
| Порядок FIFO, локальный draft, pendingMessage | Существующий workspace snapshot + общий диспетчер агента 1 |
| Bot token, привязанный Telegram user/chat, polling offset, callback nonce, ID уведомлений | Агент 2, отдельные файлы `telegram/*` в том же userData |
| Auth/config/history Codex и Claude | Штатные CLI, без прямого изменения SQLite |

1. После проверки доступа ядро сериализованно резервирует `requestId`, неизменяемый
   payload и отдельный UUID `clientUserMessageId` **до** передачи команды адаптеру.
   Telegram ID не используется как native Claude UUID. Повтор идентичного request ID
   возвращает ту же операцию с её последним durable состоянием; новой отправки нет.
   Другой payload/target/kind/expectedTurnId при том же ID — `request_conflict`.
   Одинаковый текст с разными ID — разные намерения, применяется обычная FIFO/занятость.
2. Telegram использует стабильный namespace (`tg:<botId>:<chatId>:<updateId>:<action>`),
   без токена в ключе. Повтор update/callback сохраняет тот же request ID и **исходный**
   target/expectedTurnId. Старую кнопку нельзя пересобрать из текущего состояния.
   После stale/blocked новое намеренное действие получает новый ID.
3. Перед побочным RPC ядро сохраняет внутреннюю отметку `dispatching` и точные IDs,
   адаптер сохраняет связанную запись FIFO/pending в workspace и ждёт flush.
   Затем повторно проверяются grant, runtime, turn и все guards. Сбой любого обязательного
   durable сохранения запрещает RPC. Раздельные файлы не считаются общей транзакцией:
   запись `queued` выдаётся только после сохранения обеих связанных записей.
   Несогласованность при restore даёт паузу/сверку, а не автоматическую отправку.
4. Окно между durable `dispatching` и сохранением ACK восстанавливается как `uncertain`,
   даже если неизвестно, успел ли начаться RPC. Принятый enqueue — ещё не принятие агентом;
   `received` — сохранено ядром; `queued` — в FIFO; `accepted` — точный ACK/receipt;
   `completed` — подтверждённое завершение выполнения сообщения.
5. Timeout, потеря соединения/ACK, исключение после RPC или отсутствие ID в истории
   не становятся reject. Используются exact client UUID, live echo, late ACK и штатный
   `message/status`. Late ACK продвигает ту же запись без повторного model call.
   Если RPC уже выполнен, а сохранение ACK не удалось, прежняя отметка `dispatching`
   остаётся основанием для `uncertain`; `persistence_failed` не выдаётся как гарантия
   отсутствия отправки. Новые отправки блокируются до восстановления хранилища и сверки.
   Подтверждённый reject фиксируется отдельно; автоматического retry uncertain нет.
   Для stop сверяется только его expected turn; новый активный turn не доказывает ACK.
6. Для Claude steer сохраняются expected и execution turn раздельно. ACKed сообщение
   остаётся `accepted`, пока result действительно не поглотил его UUID; если CLI переносит
   его на следующий ход, исполнение отслеживается там. Его нельзя повторно добавить в FIFO.
7. Отзыв немедленно закрывает допуск и выдачу данных, увеличивает поколение durable,
   отменяет ещё не переданные remote-записи из FIFO (`cancelled`) без затрагивания локальных.
   Уже dispatched/uncertain не объявляются отменёнными: их исход сверяется локально;
   уже выполняющийся ход не останавливается неявно. Отмена ожидания сохраняется в обоих
   хранилищах; даже устаревший snapshot не вправе запустить запись с отозванным grant.
8. Close/restore/rebind инвалидируют ожидающие remote-команды старого runtime.
   Они не переносятся в новую привязку автоматически. Локальная очередь сохраняет
   прежнюю семантику restore paused. Новые remote-команды используют свежий target.
9. Tombstone request ID не удаляется так, чтобы старый update снова стал новым запросом.
   В v1 нет автоматического TTL для ledger. Если хранение недоступно/повреждено — fail
   closed, резервирование повреждённого файла, сообщение на ПК; не стартовать пустой ledger.

Общий диспетчер сохраняет guards очереди, ревизии pause, terminal handoff, history restore,
pending approval/question/uncertain, unavailable model, source/auth/setup changes,
workspace editing/operations, deferred close и Nightly freeze. FIFO имеет приоритет
перед автодоставкой исполнителей; автопинг запрещён при любой непустой FIFO, даже paused.
Model/effort/access читаются из живой беседы непосредственно при dispatch. Remote не
очищает composer или preservedDraft. Даже совпадающий по тексту локальный draft не
очищается при reconciliation remote pendingMessage: для этого сохраняется происхождение.

## Локальное управление ботом: агент 2

Публичный export агента 2: `createTelegramService(options)` из
`electron/telegram/service.mjs`. Контроллер создаётся агентом 1, сервис — один на host.

```ts
export type PhoneAccessState = {
  enabled: boolean;
  tokenConfigured: boolean;
  encryptionAvailable: boolean;
  botUsername: string | null;
  connection: 'disabled' | 'unconfigured' | 'starting' | 'polling' | 'error';
  paired: null | { userId: string; chatId: string; displayName: string };
  error: string | null;           // очищенная причина, без token/URL запроса
};
export type PhonePairing = { code: string; expiresAt: string };
export interface PhoneAccessBridge {
  getState(): Promise<PhoneAccessState>;
  setBotToken(token: string): Promise<PhoneAccessState>;
  clearBotToken(): Promise<PhoneAccessState>;
  setEnabled(enabled: boolean): Promise<PhoneAccessState>;
  createPairing(): Promise<PhonePairing>;
  cancelPairing(): Promise<void>;
  unpair(): Promise<PhoneAccessState>;
  onState(listener: (state: PhoneAccessState) => void): () => void;
}
// Node/Electron зависимости передаёт main; service не импортирует renderer.
type TelegramServiceOptions = {
  userData: string;
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Uint8Array;
    decryptString(value: Uint8Array): string;
  };
  remote: RemoteControl;
  fetch?: typeof globalThis.fetch; // для fixture и таймаутов HTTP
};
export interface TelegramService {
  start(): Promise<void>;        // читает сохранённые настройки; disabled — без polling
  stop(): Promise<void>;         // abort polling, drain/отписка, без остановки model turns
  local: PhoneAccessBridge;      // onState in-process; main оборачивает IPC
}
// createTelegramService(options: TelegramServiceOptions): TelegramService
```

Agent 2 реализует polling без публичного listener/webhook. По умолчанию `enabled:false`,
телефон не привязан. Токен вводится только локально, хранится через safeStorage;
при недоступном шифровании plaintext fallback запрещён. В renderer токен не возвращается.
Сохранение нового токена останавливает старый polling и сбрасывает pairing/старые callbacks.
Один привязанный пользователь, только private chat, точная проверка userId и chatId
на каждом update/callback и перед выдачей данных. Pairing code создаётся только на ПК,
короткоживущий, одноразовый, с ограничением попыток; удалённого создания кода нет.
Pairing даёт идентичность телефону, но не включает доступ ни к одной беседе.
Конкретные команды бота/клавиатуру/разбиение текста агент 2 описывает в `TELEGRAM.md`.

`stop()` сервиса идемпотентен, не меняет persisted enabled и не отзывает grants.
`setEnabled(false)` прекращает polling/новые remote-команды/уведомления, не interrupt.
Ранее принятая общая FIFO сохраняет своё поведение; для отмены ожидающих remote-записей
пользователь отзывает доступ к беседе. Отключение бота само по себе не изменяет grants.
Shutdown, смена token/pairing не должны подтверждать ещё не сохранённый polling offset
или повторять команды при рестарте. Offset и сохранённое соответствие update → command
коммитятся в порядке, сохраняющем request ID при replay. HTTP ошибки очищаются от секрета;
bot token, pairing code и prompts не пишутся в диагностику.

## Локальный доступ к беседе и props: интеграция агента 1

```ts
export type RemoteThreadAccessState = {
  provider: AgentProvider;
  threadId: string | null;
  accessRevision: string;        // CAS token локального вида, меняется при смене адреса
  enabled: boolean;
  canEnable: boolean;
  reason: string | null;         // локальное безопасное пояснение
  target: RemoteTarget | null;
};
export type SetRemoteThreadAccess = {
  enabled: boolean;
  expected: { provider: AgentProvider; threadId: string; accessRevision: string };
};

// Props именованных export-компонентов из src/PhoneAccessSettings.tsx
// и src/TelegramThreadAccess.tsx соответственно:
export type PhoneAccessSettingsProps = {
  bridge: PhoneAccessBridge;
  disabled?: boolean;
};
export type TelegramThreadAccessProps = {
  state: RemoteThreadAccessState | null;
  busy: boolean;
  disabled?: boolean;
  onChange(enabled: boolean): Promise<void>; // error/reload обрабатывает parent
};
```

Компоненты агента 2 не выбирают сессию и не обращаются к глобальному active tab.
`PhoneAccessSettings` сам подписывается на переданный `bridge.onState`, хранит token
только во временном поле, показывает подключение и pairing. `TelegramThreadAccess`
получает состояние/обработчик от родительского `App`; `enabled:false` виден по умолчанию.
Агент 1 размещает настройки телефона в существующем SettingsDialog; thread toggle —
в контексте конкретной беседы, со штатной стилистикой. Общие файлы редактирует агент 1.

Фиксированные новые IPC/методы preload, реализуемые агентом 1:

| Bridge | IPC |
| --- | --- |
| `window.codex.phoneAccess.getState()` | `phoneAccess:getState` |
| `.setBotToken(token)` / `.clearBotToken()` | `phoneAccess:setBotToken` / `phoneAccess:clearBotToken` |
| `.setEnabled(enabled)` | `phoneAccess:setEnabled` |
| `.createPairing()` / `.cancelPairing()` / `.unpair()` | `phoneAccess:createPairing` / `phoneAccess:cancelPairing` / `phoneAccess:unpair` |
| `.onState(listener)` | событие `phoneAccess:state`, возвращает unsubscribe |
| `window.codex.forSession(id).getRemoteThreadAccess()` | `remoteControl:getThreadAccess`, обязательный sessionId |
| `.setRemoteThreadAccess(options)` | `remoteControl:setThreadAccess`, обязательный sessionId |

Локальные access методы возвращают `Promise<RemoteThreadAccessState>`; parent перечитывает
состояние при изменении thread/runtime и после set. Отклонённый CAS не включает новый thread.
Host проверяет `windowForEvent`/mainFrame, точное владение session, актуальные provider,
cwd, thread и `accessRevision`. `undefined` sessionId недопустим. Отзыв доступен даже
при занятом ходе; это не изменение прав агента и не остановка задачи.
Ни один метод локального управления не передаётся TelegramService.remote.
Без произвольного URL/пути/RPC method или Electron event в публичных аргументах.

Внутренний мост dispatch между main и per-session renderer, регистрация runtime,
receipts и persistence остаются ответственностью агента 1; это не API агента 2.
Он должен проверять owner, runtime, operation UUID, одноразовый dispatch и поколение
перед каждой отправкой; IPC ответ от другого/закрытого renderer не принимается.
Существующий `codex:request` не становится remote endpoint.

## Примеры результатов

Ниже `T` — точный `RemoteTarget`, полученный из `listThreads`; поля времени и UUID
в полных операциях создаёт ядро. Это примеры проекции результата, не альтернативные DTO.

```ts
// Успех: получено ядром → принято агентом → завершено, один requestId и message UUID.
execute({ requestId: 'tg:42:7:100:send', target: T, kind: 'send', text: 'Проверь сборку' });
// { ok: true, value: { ...op, phase: 'accepted', executionTurnId: 'turn-A' } }
// readEvent(eventId) → { ok: true, value: { ...event, kind: 'operation_changed',
//   operation: { ...op, phase: 'completed', executionTurnId: 'turn-A', outcome: 'succeeded' } } }
// getLastAnswer(T) → { ok: true, value: { answerId:'answer-A', turnId:'turn-A',
//   text:'Проверки пройдены.', completedAt:'2026-10-13T10:00:00.000Z', truncated:false } }

// Требуется действие на ПК: prompt и tool arguments отсутствуют в событии.
// execute(send) → { ok:true, value:{ ...op, phase:'blocked',
//   error:{ code:'blocked', reason:'approval', message:'Требуется действие на компьютере',
//           requiresComputer:true } } }
// enqueue при разрешённых actions.enqueue → phase:'queued', агент ещё не принял текст.

// Старый stop: уже выполняется turn-B; его не останавливать.
execute({ requestId: 'tg:42:7:101:stop', target: T, kind: 'stop', expectedTurnId: 'turn-A' });
// { ok:true, value:{ ...op, phase:'stale', error:{ code:'stale_turn',
//   message:'Задача уже сменилась. Обновите состояние беседы.', requiresComputer:false } } }
// Старый T после restore → { ok:false, error:{code:'stale_target', ...} }, RPC отсутствует.

// Timeout после dispatch: не сообщать «не отправлено» и не делать retry.
// { ok:true, value:{ ...op, phase:'uncertain', clientUserMessageId:'<UUID>',
//   executionTurnId:null, error:{code:'blocked',reason:'uncertain_delivery',
//   message:'Отправка не подтверждена. Требуется проверка на компьютере.',requiresComputer:true} } }
// Точный late ACK → та же operationId, phase:'accepted', без второго turn/start.
// Повтор исходного requestId → та же операция; иной payload → request_conflict.
```

## Приёмка после реализации обеих частей

Агент 1 проверяет общий контроллер и реальный путь UI → preload → main → dispatch →
штатный transport на изолированных fixture, включая Codex и Claude. Обязательны:
конкурентный ПК/телефон, одинаковый request ID и разные ID с одинаковым текстом;
сбой durable записи до RPC, crash после dispatch, late ACK, restart uncertain;
неверный/устаревший адрес, duplicate owner, отзыв до dispatch и до уведомления,
старый stop/steer; approval/question, terminal, restore, Nightly freeze;
одна FIFO/лимит 50/пауза и приоритет перед автоматическими отправками;
сохранение локального draft и фактических model/effort/access; Claude follow-up steer.

Регрессии: `tests/window-session.test.mjs`, `preload-session.test.mjs`,
`workspace-state.test.mjs`, `claude-client.test.mjs`, executor persistence;
`test:message-queue`, `test:message-queue-host`, `test:sessions`,
`test:workspace-state-host`, provider/terminal/executor UI по затронутым путям.
Агент 2 передаёт отдельно свои fixture проверки polling/pairing/allowlist/callbacks/
redaction и компонентов. Затем агент 1 выполняет `npm.cmd run check`, релевантные
UI/host проверки и единственную итоговую `npm.cmd run package` только в Nightly.
Пользовательское приложение не закрывается автоматически или принудительно.
Release и публикация — только по отдельному поручению.

Этот контракт проверен чтением кода; тестов функции и живого Telegram/model turn
на этапе подготовки контракта ещё нет. Завершение ядра само по себе не означает
завершение Telegram-пульта. Live, fixture и состояние Nightly в отчёте разделяются.
