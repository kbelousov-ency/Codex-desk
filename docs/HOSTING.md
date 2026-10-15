# Relay Кузьмича: памятка для размещения на сервере компании

Дата: 2026-10-15. Для системного администратора. Что это: серверная часть
телефонного пульта Кузьмича (Telegram Mini App). Одно Node.js-приложение,
код в `relay-server/`, статика Mini App — собранная папка `miniapp/dist`.

## Что приложение делает

- Раздаёт статическую страницу Mini App (HTML/JS, открывается внутри Telegram).
- HTTP API и WebSocket для телефонов (авторизация по подписи `initData` Telegram).
- Второй WebSocket `/bridge/v2` — к нему подключаются **исходящим** соединением
  компьютеры с Кузьмичом (аутентификация Ed25519, за NAT, без портов на ПК).
- Шлёт уведомления через Telegram Bot API — **только исходящие** запросы
  к `api.telegram.org`. Webhook не используется, входящих запросов от Telegram нет.
- База — один файл SQLite (встроенный `node:sqlite`, native-модулей нет).

## Требования

| Что | Сколько |
| --- | --- |
| ОС | Linux или Windows, безразлично |
| Node.js | **24+** (проверено на 24.16). TypeScript исполняется штатным Node, сборка не нужна |
| CPU/RAM | Минимальные: единицы пользователей, < 200 МБ RAM |
| Диск | Десятки МБ (код + SQLite) |
| Входящий трафик | Один HTTPS-порт (443) |
| Исходящий трафик | `api.telegram.org:443` |
| Runtime-зависимости | Одна: пакет `ws` (ставится `npm ci --ignore-scripts`) |

## Домен и TLS — два варианта

Нужен постоянный HTTPS-адрес, например `kuzmich.<домен-компании>`. Telegram
принимает только HTTPS; Let's Encrypt подходит.

**Вариант А (рекомендуемый): reverse proxy на той же машине.**
nginx/caddy терминирует TLS и проксирует на `127.0.0.1:8787`, включая
WebSocket upgrade (`/bridge/v2` и WS Mini App). Обязательно:
- заголовок `X-Forwarded-Proto: https`;
- переменная `RELAY_TRUST_LOOPBACK_PROXY=1`;
- прокси и relay на **одной машине**: relay доверяет только loopback-прокси,
  вынести TLS на соседний хост нельзя без варианта Б.

**Вариант Б: без прокси.** `RELAY_TLS_CERT`/`RELAY_TLS_KEY` (пути к PEM),
`RELAY_HOST=0.0.0.0`, `RELAY_PORT=443`. Публичный listener без TLS приложение
не поднимет (встроенная проверка).

## Переменные окружения

| Переменная | Значение |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Токен production-бота от BotFather. **Секрет**, только в env службы |
| `TELEGRAM_BOT_USERNAME` | Имя бота без `@` |
| `RELAY_COMMAND_PAYLOAD_KEY` | 32 байта base64url для шифрования текста команд в покое. Генерация: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. **Секрет**, хранить вместе с бэкапом |
| `RELAY_DATABASE` | Путь к файлу SQLite, напр. `/var/lib/kuzmich-relay/relay.sqlite` |
| `RELAY_STATIC_DIR` | Путь к собранной папке `miniapp/dist` |
| `RELAY_ALLOWED_ORIGINS` | `https://kuzmich.<домен>` (origin Mini App) |
| `RELAY_HOST` / `RELAY_PORT` | Вариант А: `127.0.0.1` / `8787` (значения по умолчанию) |
| `RELAY_TRUST_LOOPBACK_PROXY` | `1` при варианте А |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | Только при варианте Б, оба сразу |
| `RELAY_DEV_FIXTURE` | **Не ставить** (режим разработки) |

## Установка и запуск

```bash
# скопировать на сервер папку relay-server/ и собранный miniapp/dist
cd relay-server
npm ci --ignore-scripts
node src/main.ts        # печатает: Relay listening on port …; mode=production; protocol=2.3
```

Автозапуск — обычный systemd unit (или служба Windows): `ExecStart=node src/main.ts`,
`WorkingDirectory=<relay-server>`, env из файла с правами 600, `Restart=always`.
Корректно гасится по SIGTERM. Логи — stdout, ничего секретного в них не пишется.

## Данные, бэкап, приватность

- Вся база — один файл SQLite. Бэкап: копия файла (+ `RELAY_COMMAND_PAYLOAD_KEY`).
- В базе: публичные ключи установок, хэши сессий/кодов привязки, названия
  разрешённых вкладок и их статусы, настройки уведомлений, журнал команд.
- В базе НЕТ: переписки, ответов модели, путей, токенов с ПК. Текст команды
  хранится шифрованным и удаляется после исполнения. Потеря ключа шифрования
  не катастрофа: нечитаемыми станут только недоставленные команды.
- Встроены: проверка подписи Telegram `initData`, короткие сессии, rate limit,
  лимиты размеров. Все права на беседы выдаются только на компьютере владельца
  вкладки, сервер их выдать не может.

## Telegram-бот

Production-бот создаётся у BotFather (можно перевести существующего
@ENCY_Kuzmich_bot). У бота прописывается Mini App URL = `https://kuzmich.<домен>/`
(Bot Settings → Configure Mini App). Это единственная настройка на стороне Telegram.
Токен передаётся админу защищённым каналом и живёт только в env службы.

## Чек-лист для админа

1. VM/контейнер с Node 24+, доступ наружу к `api.telegram.org:443`.
2. Поддомен + сертификат, 443 открыт снаружи (телефоны и ПК сотрудников ходят из интернета).
3. nginx с WebSocket upgrade → `127.0.0.1:8787`, `X-Forwarded-Proto: https`.
4. systemd-служба, env-файл с тремя секретами (токен, username, ключ шифрования).
5. Бэкап файла SQLite (достаточно раз в сутки) и env-файла.
6. Мониторинг: процесс жив + HTTPS 200 на `/` (отдаёт страницу Mini App).

Связанное: `relay-server/README.md`, `relay-server/API.md`,
`docs/TELEGRAM_MINIAPP_PLAN.md`, `docs/RELAY_CONTRACT.md`.
