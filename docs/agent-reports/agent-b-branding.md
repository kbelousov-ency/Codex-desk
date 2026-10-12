# Agent B — branding и цвета сообщений

Дата проверки: 2026-10-09.

## Root cause

`src/ProductLogo.tsx` выбирал `lucide-react` `Terminal`, пока `getBuildInfo()` не вернёт Kuzmich-канал. Поэтому первый render, stable/development и любые случаи ошибки или отсутствия build info показывали старый terminal/Codex mark. `SetupWizard` имел такой же условный terminal fallback. Теперь оба пути всегда рендерят `electron/kuzmich-logo.svg`; async channel lookup больше не участвует в выборе видимого logo.

`scripts/package.mjs` получает icon через `applicationBuildIdentity`, поэтому все packaged channels теперь указывают `electron/kuzmich.ico`. Renderer build проверен: bundle содержит inline SVG с graphite tile, тонкой engineering frame и sage/gray geometric K.

## Видимые строки

- Product brand, build tooltip/details, setup brand и window title используют `Кузьмич` (с channel suffix только там, где это нужно: `Nightly`, `Release`, `Development`, `Experimental 3`).
- Stable/development больше не показывают `Codex Desk` как видимый продукт.
- Shortcut fallback теперь `Кузьмич.lnk`, а packaged icon — `kuzmich.ico`.

## Compatibility preserved

- `local.codex.desk.<channel>` и `local.codex.desk.test.<pid>` app IDs сохранены.
- `Codex Desk` сохранён как executable name для stable/nightly и в test-process identity, чтобы не ломать существующие profiles, shell registration и update safety.
- Логика archive, subdialog, composer, copy/context-menu и conversation flow не изменялась.

## Exact restored user-message color

Pre-Kuzmich values взяты из исторического `src/messenger.css` (`df5fc70` и `e148441`), без аппроксимации:

- bubble background: `#2b3c32`
- bubble border: `#405749`
- user text: `#e0e9e1`

`src/kuzmich-theme.css` задаёт эти значения после generated `kuzmich-theme-colors.css`, поэтому assistant/system Kuzmich colors остаются текущими.

## Files changed

- `src/ProductLogo.tsx`
- `src/SetupWizard.tsx`
- `src/product-identity.ts`
- `src/BuildInfo.tsx`
- `electron/app-identity.mjs`
- `src/kuzmich-theme.css`
- `tests/app-identity.test.mjs`
- `tests/kuzmich-branding.test.mjs`
- `docs/agent-reports/agent-b-branding.md`

## Tests and screenshots

- `node --test tests/kuzmich-branding.test.mjs tests/app-identity.test.mjs tests/installer-branding.test.mjs` — **12 passed**.
- `npm.cmd run build` — TypeScript check and Vite production renderer build passed.
- `npm.cmd run package` не запускался по задаче пользователя.
- Supplied screenshots were used to identify the terminal fallback and shifted user bubble color. No new packaged screenshot was captured because packaging was explicitly prohibited; the built bundle was inspected for the embedded Kuzmich SVG.

## Remaining risks

- Existing Windows shortcuts created under the old visible name may remain until the normal installer/update path repairs them; compatibility app IDs are kept to avoid profile loss.
- The full repository test suite was not run; unrelated pre-existing changes in the working tree make a broad run unsuitable for this focused task.
- Vite emitted its existing large-chunk warning; it is unrelated to branding.

Additional visible-string files changed after the initial report draft:

- `src/CommandMenu.tsx`
- `src/ReleaseNotes.tsx`
- `src/MemoryRulesSettings.tsx`
- `src/SkillsSettings.tsx`
- `src/useCodex.ts`
- `electron/main.mjs`
- `electron/notification-service.mjs`
- `electron/release-notes.mjs`
- `electron/router-portal.mjs`
- `electron/window-session.mjs`
