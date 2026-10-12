# Agent B — Кузьмич / Nightly / Source / placeholders

Дата: 2026-10-09. Проект: `E:\My projects\CodexDesk`.

## Итог

Выполнены четыре запрошенные задачи в исходниках. Nightly показывает бренд «Кузьмич» и технический геометрический K; Experimental 3 остаётся отдельным каналом. Source убран из composer, но доступен в настройках агента. Добавлены точные библиотеки placeholder и взвешенная lifecycle-stable ротация. Bulk archiving не реализовывался и не изменялся этой задачей.

Коммиты, публикация, `package`, установщик и promotion Release **не выполнялись**. `dist/` и `release/` этой задачей не обновлялись. Для проверки production renderer собран только в `artifacts/agent-b/renderer`.

До начала работы в checkout уже находились изменения других задач, в том числе Experimental 3, Portal, setup и bulk archive. Они сохранены. Список ниже описывает добавления Agent B, а не все изменения из `git status`.

## 1. Изменённые файлы

### Host и assets

- `electron/app-identity.mjs` — имя/окно Nightly, выбор иконки по каналу и bounded имя Windows shortcut по встроенному PE ProductName.
- `electron/main.mjs` — channel-specific window/notification/shell icon, фон Nightly и совместимый watcher ярлыка.
- `electron/kuzmich-logo.svg` — общий offline vector: sage K, тонкая инженерная рамка и скруглённая graphite tile.
- `electron/kuzmich.ico` — Windows ICO с PNG 256×256, сгенерированным из SVG; старый `electron/icon.ico` не заменялся.

### Renderer

- `src/product-identity.ts` — общие чистые функции бренда Nightly/Experimental 3 и русское склонение имени.
- `src/BuildInfo.tsx` — бренд/описание сборки через общие функции; идентификаторы каналов и badge labels сохранены.
- `src/ProductLogo.tsx`, `src/product-logo.css` — общий channel-aware знак и его компактное оформление; Release сохраняет прежний Terminal-знак.
- `src/kuzmich-theme.ts` — существующая палитра и шрифты Кузьмича включаются также в Nightly, без новых зависимостей.
- `src/App.tsx` — логотип, placeholder lifecycle, Source только в настройках → «Агент» → «Источник подключения»; контекст Continuing также для standalone history и fork.
- `src/ArchiveView.tsx`, `src/Workspace.tsx` — тот же логотип в архиве и состоянии без открытого диалога.
- `src/SetupWizard.tsx`, `src/KuzmichSetupWizard.tsx` — тот же SVG в branded setup; тип мастера и workflow не менялись.
- `src/RouterConnectionSettings.tsx` — пояснение указывает новое место Source, не удаляя управление подключением.
- `src/composer-placeholders.ts` — обе точные библиотеки, выбор tier 50% / 35% / 15%, uniform выбор и окно последних пяти.
- `src/use-composer-placeholder.ts` — выбор по lifecycle сессии/рабочей папки, независимо от focus/blur и incidental rerenders.

### Build scripts и UI tests

- `scripts/package.mjs` — будущие Nightly/Experimental 3 получают branded PE ProductName и ICO; executable names и channel destinations сохранены. В build-info записывается bounded ProductName для Windows shortcut watcher.
- `scripts/installer.mjs` — branded label/иконка для будущих non-stable installers, без смены прежней install directory Nightly, app ID или executable filename.
- `scripts/installer-branding.mjs` — optional icon path; прежние defaults Release сохранены.
- `scripts/generate-kuzmich-icon.mjs` — воспроизводимый SVG→ICO генератор на уже установленном Playwright/Edge; новых зависимостей нет.
- `scripts/ui-agent-b.mjs` — focused UI проверки трёх каналов, lifecycle, отправки только пользовательского текста и сохранения соединений.
- `scripts/ui-connection-sources.mjs` — существующие проверки перенесены на Source в настройках; добавлен MCP stub для transient reconnect capabilities.
- `scripts/ui-connection-sources-host.mjs` — native-host сценарий ищет Source в настройках и проверяет его отсутствие в composer; сценарий не запускался без новой packaged сборки.
- `scripts/ui-app-identity.mjs` — ожидаемый shell icon теперь зависит от канала; snapshot production shortcuts включает брендированные имена. Сценарий не запускался без новой packaged сборки.
- `scripts/ui-composer-layout.mjs` — optional `CODEX_DESK_TEST_RENDERER` для проверки renderer в artifacts, без обновления `dist/`.

### Unit tests и документация

- `tests/app-identity.test.mjs` — бренд/окно/иконка, сохранённые app IDs, isolated test identity, безопасные Windows shortcut names.
- `tests/release-channel.test.mjs` — прежний Nightly profile path и независимые профиль/marker Experimental 3.
- `tests/composer-placeholders.test.mjs` — дословное соответствие instruction-файлу, контексты, веса, uniform selection, anti-repetition и fallback.
- `tests/kuzmich-branding.test.mjs` — renderer/host brand separation, SVG/ICO/build args, сохранённый Experimental-only router workflow.
- `docs/CONNECTION_SOURCES.md` — новое место Source; прежнее описание сохранено как история решения.
- `docs/RELEASES.md` — cosmetic identity Nightly, совместимые пути и отдельный Experimental 3; прежние записи сохранены.
- `docs/agent-reports/agent-b.md` — этот отчёт.

## 2. Безопасность каналов, профилей и подключений

| Контракт | Решение |
| --- | --- |
| Nightly display name / window | `Кузьмич Nightly` / `Кузьмич — Nightly` |
| Nightly channel / app ID | Сохранены `nightly` и `local.codex.desk.nightly` |
| Nightly userData / marker | Сохранены `Codex Desk Nightly` и `.nightly-profile-initialized.json` |
| Nightly executable / destination / install directory | Сохранены `Codex Desk.exe`, `release/nightly`, `Codex Desk Nightly` |
| Experimental 3 | Сохранены `experimental3`, `local.codex.desk.experimental3`, `Kuzmich.exe`, `release/experimental3`, `Kuzmich Experimental 3`, `.experimental3-profile-initialized.json` |
| Experimental-only поведение | `routerOnly` по-прежнему определяется только `releaseInfo.channel === 'experimental3'`; Nightly не получает forced experimental wizard или router-only ограничения |
| Public Release | Renderer/host имя `Codex Desk`, прежний `icon.ico`, профиль и текущие release artifacts сохранены |
| История, settings, workspace, connections | Пути и существующие файлы не переименовываются/не копируются/не удаляются этой задачей |
| Общие исторические images и native CLI history | Сохранено прежнее разделение: отдельные shell profiles, общие исторические attachments/native CLI данные там, где это уже было предусмотрено |
| Source | Enum `inherited` / `account` / `router`, сохранение по вкладкам, host validation и same-thread reconnect оставлены; изменено только место управления |
| Windows shell icon | Новая иконка получает свой hash-addressed путь внутри прежнего profile; прежние icon files не удаляются. Старые build-info без ProductName используют legacy `Codex Desk.lnk` |

Авторизация, стандартные Codex/Claude конфиги, модель/effort и native session identifiers не менялись. Отсутствие composer selector не вызывает переключение источника по умолчанию. Settings/Portal connection-management UI сохранены; изменение Source по-прежнему требует явного действия пользователя и прежних idle/approval guards.

### Семантика placeholder

- Новый диалог без восстановленного thread ID использует **New project**; восстановленный thread/session и fork существующей беседы — **Continuing work**. Возраст папки или текст placeholder не используются как эвристика.
- Инициализация, явный новый диалог и открытие существующей беседы — точки выбора. Первая native thread creation после отправки, reconnect, Source switch, typing, focus/blur и обычный rerender сами по себе фразу не меняют.
- Tier выбирается сначала: `roll < 0.5`, затем `< 0.85`, иначе Rarely. В tier выбор равномерный среди допустимых фраз после исключения последних пяти.
- История последних пяти — только bounded память renderer, без persistence, таймера или новых библиотек. Она общая для обоих контекстов, поэтому совпадающие дословные фразы также не повторяются подряд.
- При недоступном tier fallback остаётся в той же библиотеке. При исчерпании recent-window сначала ослабляется окно до запрета последней фразы. В невозможном singleton случае возвращается пустой hint, а не повтор последней фразы.
- Фраза хранится отдельно от `text` и используется только в атрибуте `textarea.placeholder`. Draft, queue, steer и submitted prompt читают прежнее пользовательское состояние.
- Соседние кнопки, model/effort/access, queue и обработчики Enter/Shift+Enter не изменялись.

## 3. Выполненные проверки

| Команда / проверка | Результат |
| --- | --- |
| `node scripts/generate-kuzmich-icon.mjs` | ICO успешно сгенерирован из общего SVG |
| `node node_modules/typescript/bin/tsc --noEmit` | PASS, ошибок типов нет |
| `node --test tests/*.test.mjs` — финальный прогон | **934 теста: 932 PASS, 0 FAIL, 2 SKIP**, 89.467 с |
| Focused identity/branding/shell-icon suite | 12 PASS, 0 FAIL |
| Focused profile/connection/window-session/placeholder suite | Первичный прогон: 66 PASS, 0 FAIL, 1 platform SKIP; всё также входит в финальный полный suite |
| Installer branding / release-publication tests | 10 PASS; генерация тестовых branding BMP и fixture validation, не упаковка установщика |
| `node node_modules/vite/bin/vite.js build --outDir artifacts/agent-b/renderer` | PASS; production renderer собран только в artifacts |
| `CODEX_DESK_TEST_RENDERER=artifacts/agent-b/renderer node scripts/ui-connection-sources.mjs` | PASS: per-tab sources, same-thread resume, draft/model/effort, busy/failure guards, Portal cancel/preview/apply, explicit выбор несовместимой модели |
| С тем же renderer: `node scripts/ui-composer-layout.mjs` | PASS: 1440/1100/1001/940/650 px, один ряд контролов, whitespace/text/images, approvals и прежний busy Enter behavior |
| `node scripts/ui-agent-b.mjs` | PASS: Nightly/Experimental 3/Release, SVG loading, новые/существующие placeholders, StrictMode lifecycle, sidebar history, no placeholder submission, Source только в settings, сохранённые соединения/черновик/история |
| `node --check` для package/installer/branding/main и изменённых native UI scripts | PASS |
| `git diff --check` | PASS; только Git предупреждения о нормализации CRLF/LF |

Два пропуска полного unit-suite — Windows-ограничения: newline/magic filenames и file symlinks без Developer Mode. Проверка directory junction rejection выполнялась успешно.

Tier boundaries проверены детерминированной сеткой из 10 000 выборов: 5 000 / 3 500 / 1 500. Uniform выбор проверяется для каждого eligible индекса; anti-repetition — последовательностями с переключением библиотек. Все фразы и tiers сравниваются дословно с `Kuzmich_Placeholder_Rotation_Instructions.md`.

UI использует только подставные bridge/events. Реальных model turns, входа в Portal, account API calls, изменения CLI конфигов или native истории не было. Новые тестовые браузеры headless; пользовательский Nightly/Release не закрывался.

### Артефакты проверки

- `artifacts/agent-b/unit-tests.log` — финальный полный unit log.
- `artifacts/agent-b/renderer/` — изолированный production renderer.
- `artifacts/agent-b/nightly-1440.png`, `nightly-800.png`, `experimental3-1440.png`, `experimental3-800.png`, `stable-1440.png`, `stable-800.png` — финальные channel screenshots. Nightly на 1440 и 800 px визуально проверен: K читается, wordmark/badge и composer помещаются.
- Существующие source/composer regression scripts сохраняют свои обычные скриншоты и measurements в `artifacts/`.

UI fixture ограничивает Vite `optimizeDeps.entries` до `index.html` и использует отдельный cacheDir, чтобы не сканировать старые HTML в `release/` и `artifacts/`. Недостающий `getMcpConfig` stub в первом fixture-прогоне исправлен; финальные UI-прогоны проходят.

## 4. Ограничения и нерешённые риски

1. **Packaged Windows/NSIS smoke не выполнялся**: упаковка запрещена задачей. Runtime asset selection, bounded shortcut names, ICO format, build args и persistent-shell-icon логика проверены; внешний вид нового PE icon в Explorer/taskbar и реальная установка требуют отдельного разрешённого packaged прогона.
2. **Исторический риск первого отчёта — закрыт fail-closed защитой в повторном release review ниже.** Исходная оценка до защиты: Текущий public Release не изменён. Однако штатный exact-byte promotion из нового Nightly переносит также встроенные PE ProductName/иконку Nightly: `channel.json` их не переписывает. Runtime Release label/theme/icon остаются прежними, но Windows file properties/embedded executable icon будущего promoted Release надо отдельно согласовать до promotion. В этой задаче promotion pipeline не переписывался и promotion не выполнялся.
3. **Отдельного финального logo asset в предоставленных файлах не найдено.** SVG реализует явно заданные sage K, тонкую инженерную рамку, graphite/green palette и rounded tile по описанию/дизайн-системе. Если существует отдельный утверждённый оригинал, требуется визуальная сверка с ним; точное совпадение с недоступным изображением не заявляется.
4. **Контекст определяется по session/thread lifecycle**, а не по возрасту project folder. Новый пустой диалог в знакомой папке считается New project/session, восстановленный диалог — Continuing work. Это соответствует acceptance checklist про new/existing session; отдельной долговременной «новизны проекта» не вводилось.
5. Production renderer предупреждает о JS chunk больше 500 kB. Разделение bundle и несвязанные рефакторинги не выполнялись.

Не осталось выявленных ошибок в реализованных и проверенных путях. Изменения ещё не упакованы, не опубликованы и не перенесены в Release.

## 5. Повторная проверка combined diff после Agent A

Дата: 2026-10-09. Область: только release-channel safety. Archive behavior, bulk archive и composer logic **не изменялись** в этой повторной проверке.

### Findings и исправления

- **High — возможная утечка Nightly PE branding в будущий public Release.** Исходный promotion переносил Nightly bytes и менял только external channel marker. Runtime label становился Codex Desk, но embedded PE ProductName/иконка оставались Кузьмич Nightly/kuzmich.ico. Это исправлено fail-closed guard, а не скрытым преобразованием или пересборкой во время promotion.
- **Metadata gap — ProductName терялся до release manifest.** readBuildInfo ранее возвращал только buildId/builtAt/version; поэтому записанный в ASAR ProductName не попадал в manifest verification. Теперь optional productName/iconName читаются из ASAR, валидируются и сравниваются с manifest. Их удаление/подмена только в manifest вызывает отказ.
- **Явная таблица per-channel metadata.** package использует applicationBuildIdentity(channel) для ProductName, executableName и iconName; hardcoded общий kuzmich.ico убран. Новые build IDs включают branding вместе с staged-file checksums, чтобы разные PE-варианты одного исходного дерева не считались одним новым артефактом.

| Channel | PE ProductName | Executable | Icon |
| --- | --- | --- | --- |
| stable | Codex Desk | Codex Desk.exe | icon.ico |
| nightly | Кузьмич Nightly | Codex Desk.exe | kuzmich.ico |
| experimental3 | Кузьмич Experimental 3 | Kuzmich.exe | kuzmich.ico |

package по-прежнему принимает только обычный Nightly запуск или --experimental3; новый stable build/promotion override не добавлен. Stable row — требование совместимости для отдельного будущего Release-compatible candidate, не новый автоматический канал сборки.

### Exact-byte контракт после review

- Проверенные legacy кандидаты без branding fields сохраняют прежний путь exact-byte promotion. Действующие public Release файлы не мигрируются.
- Кандидат с явными Codex Desk / icon.ico также переносится без изменения application bytes. Исключение, как прежде, — external resources/channel.json.
- Branded Nightly или icon-only mismatch отклоняются **до** изменения .stable-incoming, stable, stable-previous и update queue. Защита проверяет фактический выбранный источник, включая queued candidate, а не только установленный Nightly.
- verifyRelease не принимает branded ASAR/manifest с маркером stable. Простой rename channel.json или forged manifest не превращает сборку в public Release.
- Promotion не выполняет PE-resource edits, ASAR rewrites, signing или rebuild. Не добавлен флаг обхода защиты.

Перед будущим public Release требуется отдельно одобренный Release-compatible artifact: реальные PE ProductName Codex Desk и icon.ico, совпадающая ASAR metadata, новый branding-aware build ID и checksums/manifest, повторная подпись при необходимости, новые identity/installer/host smoke и подтверждение пользователя. Только после проверки нового кандидата допустим его exact-byte перенос. Одной правки JSON/marker недостаточно. Подробная процедура добавлена в docs/RELEASES.md; сама conversion **не реализовывалась и не выполнялась** в этом review.

### Файлы повторного review

- electron/app-identity.mjs — pure applicationBuildIdentity для packaged channel metadata; profile/runtime identities не менялись.
- scripts/package.mjs — единый источник channel-specific PE args, productName/iconName metadata и branding-aware fingerprint.
- scripts/release-utils.mjs — проверка ASAR/manifest branding и guard для promotion/stable verification.
- tests/app-identity.test.mjs, tests/kuzmich-branding.test.mjs — per-channel таблица и связь package args/metadata/fingerprint.
- tests/release.test.mjs — exact-byte compatible candidate, обычный и queued branded rejection, сохранность stable/previous/incoming/queue, forged/omitted manifest metadata, stable-marker и icon-only rejection.
- docs/RELEASES.md, docs/agent-reports/agent-b.md — контракт, conversion требования и результаты.

### Проверки повторного review

Финальная команда: node --test tests/app-identity.test.mjs tests/kuzmich-branding.test.mjs tests/release.test.mjs tests/release-channel.test.mjs tests/release-publication.test.mjs tests/installer-branding.test.mjs tests/nightly-update.test.mjs tests/nightly-update-host.test.mjs.

**100 тестов: 99 PASS, 0 FAIL, 1 SKIP**, 9.060 с. Skip — Windows file symlinks без Developer Mode; directory junction rejection проходит. Это релевантный review suite, не новый полный прогон всех unit tests. Финальный log: artifacts/agent-b/release-review-tests.log.

Также PASS: node --check для package/release-utils, TypeScript --noEmit и git diff --check (только прежние CRLF/LF warnings). Новые promotion tests работают исключительно на disposable fixtures и не выполняют реальный перенос.

**Текущий public Release проверен read-only:** verifyRelease(release/stable, stable) подтвердил metadata и все manifest checksums; версия 0.10.0, build ID 70aa4e37d064651a4ad5a58c6dadac81b4a1923a5949dce5fbd2faacb3f82747. Windows FileVersionInfo существующего Codex Desk.exe: ProductName Codex Desk, FileDescription Codex Desk, ProductVersion 0.10.0.0. Сборка legacy, без новых branding fields; её байты/manifest не менялись.

### Оставшиеся ограничения

Автоматического public Release из branded Nightly теперь намеренно нет: сначала нужна явно разрешённая conversion/Release-compatible build и проверка нового артефакта. Metadata guard не заменяет будущую проверку реальных PE resources/подписей при такой conversion. Новая packaged Windows/NSIS smoke по-прежнему не выполнялась; упаковка, публикация, подписание и реальный promotion не запускались. Архив и composer в этом review не затрагивались.
