# Telegram Mini App

React/Vite client for the Кузьмич relay. The app sends only the signed
`Telegram.WebApp.initData` string to `POST /api/auth`; `initDataUnsafe` is never used
for identity. API paths and response mapping are kept in `src/api.ts`.

## Local browser fixture

From this directory, install dependencies once and start Vite:

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:5173/?fixture=1`. This installs a deterministic in-memory
`Telegram.WebApp` fixture and uses local sample installations; no Telegram request,
bot token, or real `initData` is needed. The Vite development proxy forwards `/api`
and `/api/events` to `http://127.0.0.1:8787` for a local relay. To use another relay,
set `VITE_RELAY_URL` to its `/api` origin; for the signed local fixture endpoint set
`VITE_LOCAL_RELAY=1` and keep the relay's development guard enabled.

## Checks

```powershell
npm.cmd test
npm.cmd run build
```

`npm.cmd run check` runs both. The UI displays online presence, installations and
allowed tabs, receives complete WebSocket snapshots with resync after reconnect, and
supports explicit device unbinding. It does not display a conversation history. Stage 3 adds
explicit commands from a tab card:

- `send` sends up to 32,000 UTF-16 characters (slash commands are rejected locally);
- `stop` first asks for a fresh `get_state`, then binds confirmation to its
  `state.activeTurnId` and sends `expectedTurnId` unchanged;
- `get_last_answer` requests one transient answer payload on demand.

There is no `enqueue` action in v1. Send is enabled only for an idle tab; running
and blocked tabs explain the disabled button: «Беседа занята. Отправка станет
доступна, когда задача закончится.» The hint disappears when the tab becomes idle.

Notification settings expose `turnCompleted`, `actionRequired`, `commandFailed`,
and `presence` via `GET/PUT /api/notifications`, all enabled by default. Only the
relay sends Telegram messages, using its environment bot token. Device authentication
uses Ed25519; HMAC-SHA256 is used for Telegram initData, not device verification.

The client generates `commandId` and keeps it when a request fails. Status refreshes
use `GET .../commands/:commandId`; the client never retries with a new ID. Wire
statuses (`queued`, `accepted`, `executed`, `uncertain`, `rejected`) and `outcome`
are shown verbatim. `uncertain` says that the computer must be checked and has no
automatic retry. Read payloads are held only in component memory and are never
replayed from a duplicate command.

Transport recovery is separate from phone retries: after the bridge reconnects
and publishes its first fresh full snapshot, the relay redelivers each nonterminal
command once using its original ID and request. The PC journal/getOperation resolves
the existing operation; the UI receives its current status. Further snapshots on
that connection do not redeliver commands. `executed` and `rejected` are terminal;
`uncertain` remains eligible for this status reconciliation. If an old relay record
has no recoverable request, the UI shows a computer-check hint while retaining the
wire status and the safe status-only refresh button.

The relay API preserves all eight approved tab fields: `tab_id`, `title`, `agent`,
`project`, `status`, `queueLength`, `queuePaused`, `updatedAt`. The UI shows queue
length, the paused-queue marker and each tab's activity time independently of the
installation heartbeat. Installations form a plain list using the label chosen on
the PC; there is no primary installation. Unknown fields such as conversation text
and paths are excluded from the client view model.

## Workspace browser acceptance

`npm.cmd run test:browser` starts and closes its own local relay, fake Ed25519 bridge,
Vite and headless Edge. It requires Node 24, the sibling `relay-server` dependencies,
and the workspace's existing root Playwright package; no new Playwright dependency
is added here. Port 5173 must be free. All external browser requests are blocked.
Screenshots go to ignored `test-results/browser/`. The test covers explicit phone
and PC confirmation, the normal production signature verifier, live queue/activity
updates, reconnect/resync and device revocation, using only synthetic initData.
Command coverage includes a lost final result, one transport replay after reconnect,
one fake PC execution, terminal status delivery to the UI, no terminal replay and
no replay from repeated snapshots on the same connection.
