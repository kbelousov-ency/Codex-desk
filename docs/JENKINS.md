# Jenkins: публикация в каталог роутера

Работа идёт в ветке `develop`. `master` — то, что получают люди: каждое изменение
`master` в Gerrit запускает джобу `WEBTEAM_FOLDER/codexdesk-build`, она собирает
Release-установщик и заливает его в каталог «Приложения» портала роутера
(карточка `codex-desk`). Сборки других веток завершаются `ABORTED`.

Настройки Multibranch Pipeline:

- Репозиторий: `https://gerrit1.hq.encycam.com/a/CodexDesk`.
- Credentials: `jenkins4gerrit_gerrit1`.
- Ветка: `master`, Script Path: `Jenkinsfile`.

Используется Kubernetes cloud `hq.encycam.com`, шаблон `win-root-lts2022`
и контейнер `builder` с образом
`nexus.hq.encycam.com/st/dotnet/sdk/vcredist:vc17-sdk10.0.301-windowsservercore-ltsc2022`
по образцу AI-Tool и CollaborationApp. Checkout выполняется в `jnlp`.
Windows-контейнер нужен в том числе для PowerShell/System.Drawing,
которые использует `scripts/installer-branding.mjs`.

В контейнер скачивается portable Node.js 22.14.0 с nodejs.org в `.local/node`.
Сборка — штатная цепочка [выпуска](RELEASES.md) в чистом воркспейсе:
`npm ci`, `npm run package` (Nightly в `release/nightly`), `release:candidate`,
`release:promote -- --prepared-candidate` и `release:installer`.
Jenkins сохраняет `release/installer/*`: Setup, `SHA256SUMS.txt`,
`release-info.json` и `README.txt`.

Публикация идёт именным ключом роутера `codexdesk-publish` с единственным правом
`apps:publish` (Jenkins credential `codexdesk-portal-key`, Secret text). Ключ
выпущен на владельца карточки: заливать и снимать её версии может только он.
Моделями этот ключ не ходит; владелец видит его в кабинете портала на вкладке
«API-ключи». Квота каталога — 200 МБ на человека, Setup весит ~100 МБ,
поэтому перед заливкой джоба снимает все прежние версии. Версия в каталоге —
`<версия package.json>.<номер сборки>`: версия каталога неизменяема, а `master`
может меняться без повышения версии. После заливки джоба сверяет SHA-256,
который сохранил портал, с собранным.

С 0.12.5 встроенная проверка обновлений использует именно этот каталог, а не
GitHub Releases ([UPDATES.md](UPDATES.md)); 0.12.5 — переходный выпуск, который
публикуется ещё и на GitHub, потому что установленные ранее копии умеют
проверять только его.
