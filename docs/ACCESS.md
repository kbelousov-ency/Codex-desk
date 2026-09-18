# Три режима подтверждения действий

Запрос 2026-09-18: упростить список до трёх вариантов по образцу официального клиента. Меню `AccessSelect` показывает заголовок «Как подтверждать действия Codex?», отдельные иконки, пояснения и отметку выбранного пункта. Полный доступ выделяется жёлтым. Положение под чатом и клавиатурная навигация сохраняются; `/permissions` открывает тот же список.

| Подпись | Ключ Access | Sandbox | Approval policy | Reviewer |
| --- | --- | --- | --- | --- |
| Спрашивать разрешение | `workspace-write` | `workspace-write` | `on-request` | `user` |
| Одобрять за меня | `auto` | `workspace-write` | `on-request` | `auto_review` |
| Полный доступ | `danger-full-access` | `danger-full-access` | `never` | `user` |

`accessParams` в `useCodex.ts` и отображение в `terminal-launcher.mjs` уже реализовали эти комбинации; протокол не заменяли. Для start/resume — `sandbox` строка, для turn — `sandboxPolicy`: `workspaceWrite` с текущим cwd, networkAccess:false и разрешёнными временными каталогами, либо `dangerFullAccess`. Обычные изменения внутри проекта не требуют разрешения на каждую правку. Автопроверка работает через Codex и может отказать; это не гарантированное одобрение и не автоматическое нажатие кнопок UI.

## Начальное значение и совместимость

При отсутствующем saved.access новый default — `workspace-write`. Сохранённый full по-прежнему требует нового явного выбора и существующего подтверждения; fallback теперь ручной `workspace-write`, прежний fallback `inherited` мог незаметно наследовать полный доступ из CLI. Модель/effort не меняются, глобальный config не редактируется. Повторный выбор уже действующего full не открывает лишнее подтверждение.

Явно сохранённые `inherited` и `read-only` не мигрируются молча: это могло бы изменить конфигурацию пользователя или повысить разрешения с чтения до записи. Они остаются поддерживаемыми в типах, hook и terminal launch, но отсутствуют среди трёх вариантов меню. Кнопка и примечание «Сейчас: …» показывают старое действующее значение без ложной галочки на одном из новых пунктов. После явного выбора нового режима старое значение заменяется в настройках оболочки. Для новых вкладок действует существующее копирование текущих настроек.

## Источники и проверки

Сверено с [Permissions](https://developers.openai.com/codex/permission-modes), [Auto-review](https://developers.openai.com/codex/sandboxing/auto-review) и [Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security). Текущая `/codex/security/` относится к отдельному продукту Codex Security; ссылка на approvals ведёт на `/codex/agent-approvals-security`. Фактически полученные страницы сохранены в `artifacts/access-*.html`. Официальный список может дополнительно предлагать Custom(config.toml); пользователь попросил три основных варианта, старые значения сохранены только для совместимости.

`test:access` проверяет production UI через подставной bridge: список, клавиатуру, legacy значения, default, подтверждение full, параметры start/turn/resume, доступ в нескольких вкладках. Существующие UI сценарии обновляются на новые подписи. Протокольные тесты терминала сохраняют проверки старых режимов. Реальные model turns ради этой правки не нужны.

Сборка `release/access-modes/win-unpacked/Codex Desk.exe` создана рядом с работающим приложением; `release/active-build.txt` обновлён. 137 Node-тестов, build, `test:access`, panels, tabs, scenarios, cache, continue и terminal прошли. Packaged read-only bootstrap подтвердил шесть моделей, прежние Astra/Ultra, новый default «Спрашивать разрешение», PNG без model turn. Все 18 актуальных host/preload/dist файлов в app.asar сверены побайтно. Build ID: `43d74e6a1296697249aababe82909a0eabaa73b43c45a95c7ceecdccb2fd431a`. Скриншоты меню: `artifacts/access-menu-1440.png`, `access-menu-940.png`, `access-menu-650.png`.
