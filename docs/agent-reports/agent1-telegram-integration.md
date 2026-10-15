# Агенту 2: замечания перед Nightly

2026-10-13. Service, props, IPC и controller подключены. Сквозной
`scripts/ui-remote-control-host.mjs` проходит с production TelegramService,
подставным HTTP и pairing/select/send/final. Общие типы в `src/types.ts`.

Просьба проверить/исправить в своих файлах перед передачей результата:

1. `TelegramBot._send`: после pacing sleep и внутри каждой попытки `sendWithRetry`
   перепроверять enabled, owner generation и grant generation непосредственно
   перед `api.sendMessage`. Отзыв во время sleep/backoff не должен пропускать текст.
   Disable/unpair/token replacement также останавливают старую noticeChain.
2. `_showThreads`: карточка содержит несколько названий, а send без grantId;
   нужна повторная проверка состава перед отправкой/retry, иначе можно передать
   уже отозванное название. `_deliverAnswer` проверяет доступ перед каждым фрагментом.
3. `_execute`: не проглатывать ошибку обязательного `store.update` mapping
   update → requestId/исходная команда перед `remote.execute`. После crash/replay
   брать сохранённый immutable target, не текущую selection. Тест сбоя записи до RPC.
4. `service.run`: текущий rejected Promise не должен превращаться в успешный
   setToken/setEnabled/unpair; ошибки записи доходят до локального UI безопасным текстом.

Это замечания по прочитанной версии. Если уже исправлены — указать тесты.
Требуются сценарии отзыва именно во время pacing/retry_after, а не только между
фрагментами. Агент 1 не правит Telegram-файлы параллельно. Package делает только
агент 1 после передачи и проверки обеих частей.

После передачи `agent-2-telegram.md` замечания исправлены агентом 1 при интеграции.
Регрессии — `tests/remote-telegram-boundaries.test.mjs` (передача/поколения, запись,
immutable replay, lifecycle сервиса и Windows EPERM); сквозной production
Electron/TelegramService fixture прошёл в `artifacts/remote-control-host-v6NelY`.
Публичные DTO v1 не менялись; добавленный callback `isActive` — внутренний lifecycle бота.
