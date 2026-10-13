# Jenkins: сборка для каталога роутера

`Jenkinsfile` собирает Windows x64 установщик Nightly. Публикация в каталог
роутера пока обозначена TODO.

Настройки Multibranch Pipeline:

- Репозиторий: `https://gerrit1.hq.encycam.com/a/CodexDesk`.
- Credentials: `jenkins4gerrit_gerrit1`.
- Ветка: `master`, Script Path: `Jenkinsfile`.
- Запуск вручную; автоматическая сборка после сканирования завершается `ABORTED`.

Используется Kubernetes cloud `hq.encycam.com`, шаблон `win-root-lts2022`
и контейнер `builder` с образом
`nexus.hq.encycam.com/st/dotnet/sdk/vcredist:vc17-sdk10.0.301-windowsservercore-ltsc2022`
по образцу AI-Tool и CollaborationApp. Checkout выполняется в `jnlp`.
Windows-контейнер нужен в том числе для PowerShell/System.Drawing,
которые использует `scripts/installer-branding.mjs`.

В контейнер скачивается portable Node.js 22.14.0 с nodejs.org в `.local/node`
по образцу подготовки Node.js в AI-Tool. В его окружении выполняются
`npm ci`, `npm run package` и `npm run package:installer`.
Контейнеру нужен доступ к nodejs.org, npm и загрузкам Electron/electron-builder.

Jenkins сохраняет `artifacts/installer-nightly/*`: установщик `.exe`,
`SHA256SUMS.txt`, `release-info.json` и `README.txt`.
Стабильный выпуск оформляется
отдельно по [RELEASES.md](RELEASES.md), с явным подтверждением переноса в Release.

Для публикации предстоит определить API/адрес каталога (`PORTAL_APP_CATALOG`),
канал выпуска и состав файлов. Предусмотрен Jenkins credential
`codexdesk-portal-key` типа **Secret text** для ключа API портала;
до реализации публикации он не используется и не требуется для сборки.

Добавление установщика в каталог роутера само по себе не меняет встроенную
проверку обновлений приложения: сейчас она использует GitHub Releases.
