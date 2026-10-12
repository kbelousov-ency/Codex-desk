# Child-dialog UX: design and implementation report

Дата: 2026-10-10

## Короткая design note

Child dialogs are a navigation relationship, not a second project taxonomy.
The project tree therefore shows only a compact count badge. Creation belongs to
the active parent conversation toolbar, where the user first chooses a model and
its supported reasoning effort. The existing main session-tab row remains the
root/navigation row; child sessions are represented in a second compact row in
the selected conversation toolbar.

Creation uses native `thread/fork` for both providers. The parent ID is passed
to the native fork request, while the returned child ID is accepted only after
the backend returns it. Codex native metadata remains valid evidence for native
children. A separate app-owned `thread-child-links.json` records the explicit
parent-child relation, selected model and effort; this is required for Claude,
which does not expose the same native parent metadata. No `turn/start` is sent.

## Implemented behavior

- Project tree rows show only a small child count badge; no child creation,
  native relation rows, missing-parent placeholders or service-only warnings.
- The old `Группы`/`Подагенты` sidebar presentation is hidden. Existing
  `thread-groups.json` is not deleted, migrated or rewritten; it remains safe
  on disk for backward compatibility but is no longer the primary child UX.
- The open parent toolbar exposes `Создать сабдиалог`.
- A compact modal uses the current model catalog and recalculates supported
  effort values after model selection.
- The fork request carries `model` and `config.model_reasoning_effort`.
- The model/effort selection is stored in `thread-child-links.json` after the
  real child ID is reported by the new tab.
- Child sessions are hidden from the main root tab row and shown in a second
  parent-specific row. Selecting one activates/opens that child session.
- A child tab cannot create another child: its toolbar action is absent.
- Parent drafts, attachments, settings, current tab, archive/search state and
  native history are left untouched.

## Exact files changed

- `src/App.tsx` — child-tab row, parent-only creation action, model/effort modal.
- `src/Workspace.tsx` — child links state, native/app relation lookup, fork
  metadata, child session placement and link persistence.
- `src/ProjectTree.tsx` — compact child count badges; no group/fork creation.
- `src/ProjectSidebar.tsx` — hides obsolete Groups panel.
- `src/ThreadMenu.tsx` — supports disabling fork in project-tree menus.
- `src/useCodex.ts` — forwards selected model and reasoning effort to fork.
- `src/types.ts` — child-link bridge and relation types.
- `src/child-tabs.css` — stacked responsive child toolbar styling.
- `electron/thread-child-links.mjs` — validated atomic app-owned relation store.
- `electron/main.mjs` — child-link IPC, setup guards and delete cleanup.
- `electron/preload.cjs` — child-link bridge methods.
- `tests/thread-child-links.test.mjs` — Codex/Claude relation and model storage tests.
- `scripts/ui-archive.mjs` — updated project-tree menu regression expectation.

## Obsolete UI removed

Removed from user-facing project navigation:

- `Ответвить`/child creation from project-tree conversation menus;
- user group creation from project tree;
- the old `Группы` sidebar switch and Groups panel;
- native relation cards and any technical fallback relationship rows.

The internal native relation parser and child-history read path remain available
as compatibility/evidence paths, but they do not generate technical UI rows.

## Tests and results

- `npm.cmd run build` — **PASS** (`tsc --noEmit` + Vite build).
- `node --test tests/thread-child-links.test.mjs` — **2/2 passed**.
- `npm.cmd run test:project-tree` — **PASS**.
- `npm.cmd run test:archive` — **PASS**.
- `npm.cmd run test:bulk-archive` — **PASS**.
- `npm.cmd run test:tabs` — **PASS**.
- `npm.cmd test` — **998 passed, 2 skipped, 0 failed**.
- `node --check electron/thread-child-links.mjs` and `node --check electron/main.mjs` — **PASS**.

The child-link unit tests cover explicit Codex/Claude membership, selected model
and effort persistence, idempotence and self-parent rejection. Existing renderer
tab/archive/project-tree smokes cover tab switching, drafts/settings, search,
archive and bulk-archive guards without real model requests.

## Screenshots

- `artifacts/tabs-browser.png` — existing responsive workspace/tab baseline.
- `artifacts/conversation-groups-tree.png` — previous compact project-tree
  baseline after native fallback removal.
- `artifacts/conversation-groups-panel.png` — previous Groups-panel baseline;
  the panel is now intentionally hidden from the sidebar.

No package/publish/commit/promote action was performed.

## Known limitations

- This task does not add a new dedicated native Electron child-fork fixture
  screenshot. Existing browser tab smoke uses a fake bridge that does not expose
  `thread/fork`; the fork path is covered by the native protocol wiring and the
  app-owned store tests.
- Native child counts appear after the separate child-history read completes;
  until then the project row has no badge rather than showing a guessed count.
- A saved child link whose transcript is not on loaded history can be represented
  as a compact child tab entry, but opening it still depends on the provider
  history being available.
- `thread-groups.json` is deliberately retained untouched. It is legacy
  presentation metadata and is not automatically converted or deleted.
