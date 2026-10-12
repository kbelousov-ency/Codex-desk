# Agent B — упаковка и применение Nightly

Дата: 2026-10-09. Рабочая папка: `E:\My projects\CodexDesk`.

## 1. Итог

Штатная команда `npm.cmd run package` завершилась с exit code 0. Собран и **применён только Nightly** в существующую папку `release/nightly`. На обеих проверках workflow не обнаружил работающий экземпляр этого Nightly; ожидающей очереди не было. Поэтому штатный `publishChannel(..., 'nightly')` применил сборку сразу, без helper и без ожидания закрытия.

- Версия: `0.10.0`.
- Build ID: `94015f79e1698b6e043afcea9e8230842537037a16b79e104b5d89d37d73a9e5`.
- `builtAt`: `2026-10-09T14:20:56.965Z`.
- Готовый exe: `E:\My projects\CodexDesk\release\nightly\Codex Desk.exe`.
- Размер exe: `246324736` байт.
- Windows ProductName / FileDescription: `Кузьмич Nightly`; ProductVersion: `0.10.0.0`.
- Значок по проверенному build manifest: `kuzmich.ico`.
- Реально открывшийся заголовок packaged Electron: **`Кузьмич — Nightly`**.
- Финальная проверка: `instance: null`, `queue: null`.

Установщик не создавался: стандартная Nightly сборка использует electron-builder `--win --dir`. Promotion, публикация, push, commit и изменения установленного Experimental 3 не выполнялись. Не закрывался и не завершался принудительно ни один пользовательский процесс. Закрывались только тестовые экземпляры Electron в одноразовых профилях.

## 2. Предварительная проверка общего рабочего дерева

Прочитаны `AGENTS.md`, `docs/RELEASES.md`, scripts из `package.json`, код упаковки/очереди и отчёт Agent A. Проверены `git status --short` и релевантные исходники. Изменения обоих агентов находились в общем незакоммиченном дереве до упаковки:

- Agent A: `src/BulkArchive.tsx`, `src/bulk-archive.ts`, `src/bulk-archive.css`, интеграция в Workspace/ProjectSidebar/ProjectTree, `tests/bulk-archive.test.mjs`, `scripts/ui-bulk-archive.mjs`.
- Agent B: channel-aware identity/icon, `electron/kuzmich-logo.svg`, `electron/kuzmich.ico`, `src/ProductLogo.tsx`, две библиотеки placeholders и lifecycle hook, удалённый composer Source selector с сохранением настройки источника в settings.

После упаковки **79 файлов текущих `electron/` и `dist/` побайтно совпали с содержимым Nightly ASAR**. Исключены только генерируемые `electron/build-info.json` и `electron/release-notes.json`; manifests проверены отдельно. Повторный renderer build в полном `check` не изменил совпадение. Это подтверждает, что проверенный пакет содержит объединённые изменения, а не прежний renderer.

В этой задаче код приложения, архива и composer не изменялся. Созданы этот отчёт и локальные проверочные scripts/logs в `artifacts/agent-b-package/`.

## 3. Точные команды исполнения

Все команды выполнены из `E:\My projects\CodexDesk` в PowerShell. Основные команды запуска и сохранения результатов:

```powershell
node artifacts/agent-b-package/audit.mjs before
node --test tests/app-identity.test.mjs tests/kuzmich-branding.test.mjs tests/release.test.mjs tests/release-channel.test.mjs tests/release-publication.test.mjs tests/installer-branding.test.mjs tests/nightly-update.test.mjs tests/nightly-update-host.test.mjs tests/bulk-archive.test.mjs tests/composer-placeholders.test.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/tests.log
npm.cmd run package 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/package.log
$env:CODEX_DESK_PACKAGED=(Resolve-Path 'release/nightly/Codex Desk.exe').Path
node scripts/ui-app-identity.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/identity-host.log
node scripts/ui-agent-b.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/agent-b-ui.log
node scripts/ui-bulk-archive.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/bulk-archive-ui.log
node scripts/hosts.mjs setup nightly-update 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/hosts.log
node scripts/check.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/check.log
node --check scripts/package.mjs
node --check scripts/release-utils.mjs
node artifacts/agent-b-package/audit.mjs after
node artifacts/agent-b-package/verify-package.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/verification.log
node artifacts/agent-b-package/packaged-smoke.mjs 2>&1 | Tee-Object -FilePath artifacts/agent-b-package/packaged-smoke-final.log
(Get-Item -LiteralPath 'release/nightly/Codex Desk.exe').VersionInfo | Select-Object ProductName,FileDescription,ProductVersion
(Get-Item -LiteralPath 'release/stable/Codex Desk.exe').VersionInfo | Select-Object ProductName,FileDescription,ProductVersion
```

`package.json` разворачивает `package` в `npm run build && node scripts/package.mjs`; `build` — `tsc --noEmit && vite build`. Channel flag не передавался: default — Nightly. `check` выполняет typecheck, полный unit suite и Vite build, но не пакует и не публикует приложение повторно.

Для статуса использовался `findNightlyInstance(process.cwd())` и read-only чтение `artifacts/nightly-update/state.json` с обработкой ENOENT. В результат выводились только PID/build ID/path, не pipe token. Финальный повтор этой проверки включён в `verify-package.mjs`.

Локальные `audit.mjs`, `verify-package.mjs`, `packaged-smoke.mjs` созданы через стандартный apply_patch engine. Это повторяемые проверки, а не изменение production workflow. Snapshot содержит только пути, размеры и SHA-256, без текста настроек/токенов.

## 4. Результаты проверок

| Проверка | Результат |
| --- | --- |
| Identity/release/update/archive/placeholder unit tests | 123 tests: **122 pass, 0 fail, 1 skip**. Skip — file symlinks требуют Windows Developer Mode; directory-junction guards проверены. |
| `npm.cmd run package` | **PASS**, exit 0: typecheck, production renderer, electron-builder directory package, применение Nightly. |
| Полный `node scripts/check.mjs` | **PASS**: typecheck; **940 tests, 938 pass, 0 fail, 2 skips**; production Vite build. |
| Syntax package/release-utils | **PASS**. |
| Packaged `ui-app-identity.mjs` | **PASS**: реальный exe, отдельные profiles с TEST и без TEST, shell icon/shortcut guards, production shortcuts неизменны, нет turn/start. |
| `ui-agent-b.mjs` | **PASS**: три renderer identity, SVG, new/continuing lifecycle stability, пустой placeholder не отправляется, source selector отсутствует в composer, sources работают в settings и сохраняют draft/model/effort/history. Только fixture bridges. |
| `ui-bulk-archive.mjs` | **PASS** на production `dist`: mode, scope/select-all, loaded-only pagination, busy exclusion, cancel/progress/stop/partial failure, Claude-local archive, сохранение других drafts. Только подставные диалоги. |
| Packaged custom smoke | **PASS**: настоящее окно `Кузьмич — Nightly`, загруженный K SVG, пустое input value, стабильность при focus/blur/typing/resize, new/continuing libraries, Source отсутствует, bulk selection включается/отменяется без архивации. Нет turn/start/thread/archive/thread/unarchive в fixture RPC. |
| Packaged updater host | **PASS**: существующий queue/update flow в disposable workspace, безопасное ожидание, explicit Close, ручное закрытие без relaunch, точное восстановление tabs/thread/draft/image/access. Один явно заданный **fixture** turn; реальной модели нет. |
| Packaged setup host | **FAIL**, exit 1 сценария: `Fixture login must complete`; подробнее ниже. Host runner продолжил и успешно выполнил nightly-update scenario. |
| Manifests/checksums | **PASS** для Nightly, stable и experimental3. |
| ASAR против текущих исходников/renderer | **PASS**, 79 файлов, отличий нет. |
| Release snapshot | **PASS**, все 74 файла stable, 74 файла stable-previous и 2 файла release root побайтно неизменны. |
| Experimental 3 package snapshot | **PASS**, все 74 файла `release/experimental3` побайтно неизменны. |

Weighted tiers 50/35/15, равномерность внутри tier, предыдущие пять фраз, отсутствие подряд повторяющихся фраз и исходные библиотеки проверены unit tests. Renderer smoke дополнительно проверяет lifecycle и native textarea semantics; placeholder не становится черновиком или prompt.

Предупреждения сборки: Vite chunk >500 kB, отсутствует package author, signing пропущен по существующей конфигурации. Сборку они не остановили; подписанный installer не создавался.

## 5. Изоляция каналов и данных

Nightly сохраняет `release/nightly/Codex Desk.exe`, профиль `Codex Desk Nightly`, AppID `local.codex.desk.nightly` и прежние пути/marker. Переименования профиля и destructive migration нет. Experimental 3 сохраняет свой `Kuzmich.exe`, профиль `Kuzmich Experimental 3`, marker и router-only workflow. Работающий установленный экземпляр отдельно обнаружен по адресу `C:\Users\LEGION-PC\AppData\Local\Programs\Kuzmich Experimental 3\Kuzmich.exe`, с заголовком `Кузьмич — Experimental 3`; его не закрывали и не обновляли.

Read-only SHA-256 snapshot до/после подтверждает:

- 10 верхнеуровневых файлов профиля public Release и 12 файлов профиля Nightly не изменились. В том числе проверенные settings/connection/auth/workspace файлы, присутствующие в этих профилях.
- `C:\Users\LEGION-PC\.codex\config.toml`, `auth.json`, `history.jsonl`, `AGENTS.md` не изменились.
- `C:\Users\LEGION-PC\.claude\settings.json` и `CLAUDE.md` не изменились.
- Ни одного настоящего диалога не архивировали, не восстанавливали и не удаляли. В проверках нет реальных модельных запросов. Не редактировали SQLite и не запускали пользовательские login/install/migration commands.

**Ограничение общей гарантии неизменности данных:** snapshot обнаружил изменения SHA-256 у `Kuzmich Experimental 3/approvals.json`, `Kuzmich Experimental 3/workspace-state.json` и пользовательского `.claude/.credentials.json`. В системе параллельно работают установленный Experimental 3 и Claude CLI. Точные причины этих внешних записей не доказаны; поэтому утверждать, что вообще все пользовательские данные на компьютере побайтно неизменны, нельзя. Файлы не восстанавливались и не перезаписывались агентом.

`.claude/.credentials.json` имеет время записи `2026-10-09T14:21:57Z`: после завершения packaging (`14:21:12Z`) и до начала packaged identity test (`14:22:06Z`) и setup-host (`14:24:31Z`). Это изменение не совпадает по времени с fixture login. Исходники packaging не запускают пользовательский Claude/auth; связь с внешними активными процессами — предположение, не доказанная атрибуция. Полная проверка всех вложенных session/history файлов не проводилась: snapshot охватывает перечисленные CLI-файлы и верхний уровень профилей, не SQLite/всё дерево истории.

## 6. Неполные проверки и диагностика

Setup host не зелёный: fixture ожидает `auth login --claudeai`, но текущий connection wrapper добавляет `--settings <temporary settings.json>` перед `auth login --claudeai`. В `artifacts/setup-host-hkZhQb/calls.jsonl` записан вызов именно **fixture** claude.exe с этими аргументами. `scripts/fixtures/setup-cli.cs` допускает login только при `args.Length == 3`, поэтому не создаёт `signed-in.fixture`, а polling auth status заканчивается assertion. Production код и setup fixture не правились: это отдельная задача, не препятствие применению пакета, но полный setup/auth host path здесь не подтверждён успешным тестом.

Первый custom packaged smoke использовал standalone selector `.history-item` вместо Workspace `.folder-thread`; второй выбирал скрытый checkbox соседней вкладки. Исправлен только локальный smoke harness (visible selectors), без изменения приложения или повторной упаковки. Финальный smoke прошёл дважды, включая сохранение скриншота bulk selection. Первая ad-hoc ASAR сверка использовала slash paths; повтор с Windows-native paths и сохранённый `verify-package.mjs` прошли. Эти промежуточные ошибки проверки не скрыты и не являются runtime patch.

## 7. Что требуется пользователю

Для применения обновления **ничего закрывать или перезапускать не требуется**: production Nightly не был запущен, сборка уже находится в `release/nightly`, helper не ждёт. Если нужно начать работу в новой версии, вручную открыть `release/nightly/Codex Desk.exe` или существующий ярлык Nightly. Обычный пользовательский профиль намеренно не открывался тестами.

## 8. Подтверждение Release и promotion safety

**Публичный Release не изменён и не продвигался.** Stable version/build ID остались:

- `0.10.0` / `70aa4e37d064651a4ad5a58c6dadac81b4a1923a5949dce5fbd2faacb3f82747`.
- PE ProductName / FileDescription `Codex Desk`; ProductVersion `0.10.0.0`.
- Старые совместимые manifest metadata без новых branding fields не переписывались.
- Проверены все файлы stable и stable-previous, включая manifest и channel metadata; SHA-256 совпадают с предварительным snapshot. Корневые `active-build.txt` и `builder-debug.yml` также не изменились.
- Experimental 3 build ID остался `c7b66124f16fcd15bc708c3b9af24fef09fb059a4c83c528e09c364be6f750d8`.
- `release/installer` не создавался/обновлялся; четыре имеющихся файла имеют timestamps 2026-10-06. Отдельного before SHA-256 snapshot installer directory не делали.

Guard несовместимого Nightly branding перед future promotion и exact-byte контракт проверены unit tests. Брендированный Nightly не может стать public Release простой заменой `channel.json`: нужна отдельная явно разрешённая Release-compatible conversion по `docs/RELEASES.md`. В этой задаче conversion не выполнялась.

## 9. Артефакты

- Логи, snapshots, `comparison.json`, `verification.json`, audit/verification/smoke scripts: `artifacts/agent-b-package/`.
- Финальный packaged smoke, `result.json`, `nightly.png`, `bulk-selection.png`: `artifacts/agent-b-package/packaged-smoke-AF1Fj2/`.
- Packaged identity: `artifacts/app-identity-VAyn0o/result.json`.
- Packaged updater: `artifacts/nightly-update-host-vBlQmt/`.
- Failed setup host: `artifacts/setup-host-hkZhQb/`.
- Agent B renderer screenshots: `artifacts/agent-b/`; bulk archive renderer screenshots: `artifacts/bulk-archive-*.png`.

Итог: Nightly собран и применён, требуемые combined UI/identity paths подтверждены, public Release и package Experimental 3 сохранены. Открытые ограничения — failed setup fixture и параллельные пользовательские записи, перечисленные явно выше.
