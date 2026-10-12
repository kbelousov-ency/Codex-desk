# Executor cleanup — 2026-10-10

## Scope

Renderer cleanup after executor-agents, provider-switch and executor-nav. Host compatibility remains: `electron/thread-groups.mjs`, its IPC, user `thread-groups.json`, `electron/thread-children.mjs`, `electron/thread-child-links.mjs` and native-model tests.

## Removed

- Group renderer files: `src/ConversationGroups.tsx`, `src/conversation-groups.ts`, `src/conversation-groups.css`.
- Legacy fork-subdialog view and UI test: `src/SubdialogsView.tsx`, `scripts/ui-subdialogs.mjs`; stale `test:subdialogs` entry removed.
- Renderer relation component/styles: `src/ThreadRelations.tsx`, `src/thread-relations.css`; `src/thread-relations.ts` remains.
- Group renderer test/script and package entry: `tests/conversation-groups.test.mjs`, `scripts/ui-conversation-groups.mjs`, `test:groups`.
- Group/fork-only state, menu entries, modal and stale theme selectors were removed; native host group paths remain dormant.

## Before / after

Before: sidebar contained group renderer state/actions and legacy fork/subdialog presentation alongside executor navigation.
After: sidebar exposes regular conversations plus depth-1 executor rows; group and legacy subdialog UI no longer render. The native relation model and host IPC remain for compatibility and measured protocol tests.

## Validation

- `npm.cmd run check` — PASS: TypeScript, 1004 tests passed / 2 skipped / 0 failed, Vite build PASS.
- `npm.cmd test` — PASS: 1004 passed / 2 skipped / 0 failed.
- Focused UI commands: `test:tabs`, `test:project-tree`, `test:archive`, `test:bulk-archive`, `test:chat-search` — PASS.
- Executor regressions checked: `test:executors` and `test:executor-nav` — PASS.
- No commit created.
