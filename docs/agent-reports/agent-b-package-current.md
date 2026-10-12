# Agent B — current Nightly package report

Date: 2026-10-10

## Result

`npm.cmd run package` completed successfully. Nightly candidate build ID: `fd2127831ab06fb34b88bd51c463be24371b46a482a8ce02654c11ba0c869959`.

The candidate is queued at `artifacts/nightly-update/app` and the installed executable remains `release/nightly/Codex Desk.exe` until the running Nightly exits normally. The existing Nightly was detected (PID 40116 registration; four related Кузьмич processes were present). No process was force-closed.

Queue state: `artifacts/nightly-update/state.json`; helper PID: `40976`; latest helper state: `candidate_verified` then `host_awaiting`. The update is waiting for the user to close Nightly through the update notice or exit it manually. The helper will then publish the candidate and relaunch according to the existing update protocol.

## Commands

- `npm.cmd run package` — PASS (`tsc --noEmit`, Vite build, electron-builder dir package, Nightly queue).
- `npm.cmd run test:ui` with `CODEX_DESK_PACKAGED=artifacts/nightly-update/app/Codex Desk.exe` — PASS.
- `npm.cmd run test:app-identity` — PASS.
- `npm.cmd run test:project-tree` — PASS.
- `node --test tests/thread-child-links.test.mjs tests/thread-children.test.mjs tests/thread-relations.test.mjs` — 28/28 PASS.
- `npm.cmd run test:archive` — PASS.
- `npm.cmd run test:bulk-archive` — PASS.
- `npm.cmd run test:tabs` — PASS.
- `npm.cmd run test:build-channel` — FAIL because the existing fixture still expects visible `Codex Desk` in the Release identity view; current renderer intentionally displays `Кузьмич`. This is a stale assertion, not a packaging failure.

## Packaged smoke

Disposable-profile real Electron smoke passed. Artifact screenshot: `artifacts/desktop.png`.

Observed in the packaged candidate:

- renderer loaded without page errors;
- real Codex bootstrap found 8 models and inherited model/effort;
- composer accepted text and pasted image data;
- native image storage worked;
- the candidate manifest reports `productName: Кузьмич Nightly`, `iconName: kuzmich.ico` (file name `kuzmich.ico`), and version `0.10.0`;
- candidate channel marker is `{"channel":"nightly"}`.

The generic packaged smoke does not exercise real fork creation, because it uses a disposable fixture and does not send model turns. Child relation/model-selection behavior is covered by unit and renderer tests above.

## Release integrity

Public Release manifest remains build `70aa4e37d064651a4ad5a58c6dadac81b4a1923a5949dce5fbd2faacb3f82747`. Experimental 3 remains build `c7b66124f16fcd15bc708c3b9af24fef09fb059a4c83c528e09c364be6f750d8`. Their files were not modified by `npm.cmd run package`; packaging wrote only the Nightly candidate queue and build staging paths.

## Manual step

Close the running Nightly normally. Use the update notification's `Закрыть` action when idle, or exit Nightly manually after cancelling/finishing active work. Do not delete `artifacts/nightly-update`; it contains the verified candidate. After exit, the helper applies build `fd2127831ab0` and relaunches the updated Nightly.


