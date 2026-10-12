# Agent C — Nightly packaging and verification

Date: 2026-10-09

## Scope and safety

- Packaged Nightly only through the existing `package.json` workflow.
- Did not package Experimental 3, promote or publish Release, create an installer,
  commit, push, archive real conversations, send model turns, or force-terminate
  any user process.
- The existing Nightly process remained running. The update worker left the new
  candidate queued; it was not applied.
- Packaged smoke used a disposable profile, disposable HOME/CODEX_HOME/
  CLAUDE_CONFIG_DIR, and the repository fixture app-server.

## Exact commands

Read first:

```text
Get-Content -LiteralPath 'AGENTS.md','docs/RELEASES.md','docs/agent-reports/agent-c-grouping.md','docs/agent-reports/agent-e-integration.md' -Encoding UTF8
```

Packaging and verification:

```text
npm.cmd run package
npm.cmd run check
npm.cmd run test:groups
npm.cmd run test:archive
npm.cmd run test:bulk-archive
npm.cmd run test:kuzmich-setup
node scripts/ui-agent-b.mjs
node --test tests/thread-groups.test.mjs tests/conversation-groups.test.mjs tests/bulk-archive.test.mjs tests/claude-archive.test.mjs tests/kuzmich-branding.test.mjs tests/installer-branding.test.mjs tests/app-identity.test.mjs tests/clipboard-files.test.mjs
```

Packaged smoke and channel verification:

```text
npm.cmd run test:ui
node artifacts/agent-b-package/packaged-smoke-current.mjs
node --input-type=module -e "import {verifyRelease} from './scripts/release-utils.mjs'; ..."
node artifacts/agent-b-package/audit.mjs after
```

The packaged smoke helper was a temporary copy of the existing
`artifacts/agent-b-package/packaged-smoke.mjs`, with only its executable path
changed to the queued candidate. It was written under `artifacts/` and did not
modify application source or channel data.

## Nightly artifact

- Build ID: `f05268d14afeee92a4fa4e0058db99420a9d5e924d0a5b3a37a0b57ed377346d`
  (short ID: `f05268d14afe`).
- Version: `0.10.0`.
- Packaged executable: `artifacts/nightly-update/app/Codex Desk.exe`.
- Embedded product name: `Кузьмич Nightly`.
- Embedded icon: `kuzmich.ico`.
- Build timestamp: `2026-10-09T20:27:46.083Z`.
- Queue state: `artifacts/nightly-update/state.json` contains the same build ID.
- Update status: **queued, not applied**. The running Nightly instance is build
  `94015f79e1698b6e043afcea9e8230842537037a16b79e104b5d89d37d73a9e5`.

## Results

### Full build/check

`npm.cmd run package` passed the TypeScript check, Vite build, Electron
packaging, and Nightly queue/update handoff. Vite emitted only the existing
large-chunk warning.

`npm.cmd run check` passed:

- `tsc --noEmit` — PASS.
- `node --test` — 995 passed, 0 failed, 2 skipped.
- Vite build — PASS.

### Feature tests

- `test:groups` — PASS: 38 bridge calls, 11 group writes.
- `test:archive` — PASS: archive/restore/delete guards, Codex/Claude flows,
  read-only history, tab and draft safety.
- `test:bulk-archive` — PASS: folder/search scopes, loaded-only selection,
  confirmation/progress/stop, partial failures, safety guards, no model request.
- Targeted group/archive/branding/clipboard tests — PASS: 73/73.
- Branding unit tests — PASS, including Kuzmich logo/icon identity, visible
  channel separation, and Nightly versus Experimental 3 behavior.
- Clipboard unit tests — PASS, including Unicode file paths, malformed input,
  bounds, timeout/error handling, and native Windows helper coverage.

### Packaged Electron smoke

`node artifacts/agent-b-package/packaged-smoke-current.mjs` — PASS against the
fresh queued executable. It verified:

- actual packaged Nightly title/logo and build bootstrap;
- inherited model/effort in the disposable profile;
- new and continuing placeholder libraries;
- absence of the composer source selector;
- bulk-selection UI without archiving;
- no `turn/start`, archive, or unarchive request;
- no renderer errors;
- disposable profile isolation.

The separate `npm.cmd run test:ui` also passed its real Electron bootstrap and
image-preview/storage smoke, with no renderer errors and no model turn.

### Release and Experimental 3 integrity

Read-only `verifyRelease` passed for all three channels:

- Public Release: build `70aa4e37d064651a4ad5a58c6dadac81b4a1923a5949dce5fbd2faacb3f82747`.
- Experimental 3: build `c7b66124f16fcd15bc708c3b9af24fef09fb059a4c83c528e09c364be6f750d8`.
- Queued Nightly: build `f05268d14afeee92a4fa4e0058db99420a9d5e924d0a5b3a37a0b57ed377346d`.

The before/after SHA-256 audit reported **no changes in `release/stable` or
`release/experimental3` files**. It reported runtime changes in user/profile
files and `release/.nightly-instance.json`; these are outside the public Release
and Experimental 3 package trees and can be affected by already-running user
processes or the smoke profiles. No such files were restored or overwritten.

## Failures and skipped checks

- `npm.cmd run test:kuzmich-setup` — FAIL before UI execution because the
  generated `src/kuzmich-theme-colors.css` is stale relative to source CSS.
  The command requested `npm run theme:colors --check`; it was not regenerated
  because doing so after packaging would make the queued candidate no longer
  match the current source tree. This is a source/generated-artifact issue, not
  a packaged Electron smoke failure.
- `node scripts/ui-agent-b.mjs` — FAIL at its assertion against the currently
  installed `release/nightly` fixture. It expected zero calls but observed one;
  this script targets the installed channel, not the fresh queued candidate.
  The fresh candidate-specific packaged smoke passed separately.
- A first temporary packaged-smoke copy had PowerShell UTF-8 quoting damage and
  timed out on a localized locator. It was discarded and rerun with a Node
  byte-preserving copy; the rerun passed.
- An auxiliary one-line static app.asar string scan was not counted: PowerShell
  escaping caused the `node -e` expression to inspect no files. The packaged
  executable verification and packaged smoke were still completed successfully.
- No separate packaged interaction scenario exercised every group create,
  rename, delete, add/remove, selected-text context-menu, and code-block-copy
  action inside Electron. Those behaviors are covered by the production
  renderer group/archive fixtures and targeted tests; packaged smoke covered the
  packaged shell/bootstrap and bulk UI only.

## Manual steps required

1. Finish the current Nightly work and use the chat **Закрыть** flow (or exit
   manually) so the queued update can apply; do not force-terminate the process.
2. After it applies, manually spot-check group create/rename/delete/add/remove,
   `Без группы`, selected-text copy, message context menu, and the code-block
   Copy button in the packaged Nightly window.
3. Regenerate the theme artifact with `npm.cmd run theme:colors`, rerun
   `npm.cmd run test:kuzmich-setup`, and package a replacement Nightly only if
   the generated CSS change is intended. The current queued candidate remains
   the verified `f05268d14afe` artifact.