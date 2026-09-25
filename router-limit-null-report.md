# Баг-репорт: `/v1/me/limit` не отдаёт квоту (все числа `null`)

> Дополнение 24.09.2026: API уже заполняет квоту. Исторические ответы от 23.09 ниже сохранены.
> Обнаружено другое расхождение: `used_credits=4243.930034`, а
> `ledger_used_credits=18635.923965` при `limit_credits=37000`.
> Пользователь подтвердил расход около 18 658 до 28.09.2026. Прежний вывод
> «Клиент дорабатывать не требуется» больше не применяется: UI теперь выбирает ledger
> и согласованно пересчитывает процент/остаток. Подробности — [ROUTER_USAGE.md](docs/ROUTER_USAGE.md).

**Кому:** разработчику `router.encycam.com`
**От кого:** Codex Desk (вкладка Codex, индикатор «Роутер»)
**Дата проверки:** 2026-09-23, около 06:57 UTC
**Аккаунт:** `k.belousov@encycam.com`, ключ `coder-k.belousov@encycam.com`, тариф `TierA`, состояние `ACTIVE`
**Хост:** `https://router.encycam.com`, авторизация `Authorization: Bearer sk-cf3cd…` (ключ из `model_providers.<provider>.experimental_bearer_token` в `~/.codex/config.toml`)

## Суть

Запросы проходят успешно (`200 OK`), но **все числовые поля квоты приходят `null`**. Из-за этого
клиент не может показать ни потраченную долю лимита, ни остаток, ни процент. При этом расход
и дата сброса приходят нормально — то есть отказ выборочный, а не общий сбой ответа.

Ожидалось: `limit_credits` и `used_credits` заполнены, чтобы можно было показать «использовано N %».
Фактически: заполнены только `key`, `available`, `tier`, `state`, `reset_at`.

## Что именно вернул сервер

### `GET /v1/me/limit` → 200

```json
{
  "email": "k.belousov@encycam.com",
  "limits": [
    {
      "key": "coder-k.belousov@encycam.com",
      "available": true,
      "tier": "TierA",
      "state": "ACTIVE",
      "blocked_reason": null,
      "reset_at": "2026-09-28T03:00:00+00:00",
      "limit_credits": null,
      "used_credits": null,
      "remaining_credits": null,
      "ledger_used_credits": null,
      "bonus_credits": null,
      "used_percent": null,
      "requests": null
    }
  ]
}
```

Пустые: `limit_credits`, `used_credits`, `remaining_credits`, `ledger_used_credits`,
`bonus_credits`, `used_percent`, `requests`.

### `GET /v1/me/overview` → 200

```json
{
  "email": "k.belousov@encycam.com",
  "key": "coder-k.belousov@encycam.com",
  "tier": "TierA",
  "state": "ACTIVE",
  "reset_at": "2026-09-28T03:00:00+00:00",
  "limit_credits": null,
  "used_credits": null,
  "remaining_credits": null,
  "last_24h": {
    "requests": 2973,
    "failures": 6,
    "input_tokens": 278619022,
    "output_tokens": 1032277,
    "cache_read_tokens": 269060608,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0,
    "first_at": "2026-09-22T07:47:23.610740+00:00",
    "last_at": "2026-09-23T06:56:21.905957+00:00",
    "success_rate_pct": 99.8,
    "credits": 10273.083775
  }
}
```

Блок лимита в `overview` пуст ровно так же, а `last_24h` заполнен полностью.

### `GET /v1/me/usage?period=7d` → 200 (для сравнения: расход считается)

```json
{
  "window": { "label": "7d", "since": "2026-09-16T06:57:02.801885+00:00", "until": "2026-09-23T06:57:02.801885+00:00" },
  "sources": { "omniroute": true, "core": true },
  "coverage": {
    "omniroute": { "complete": true,  "oldest": "2026-07-15T15:51:15.946Z" },
    "core":      { "complete": false, "oldest": "2026-09-21T05:52:30.814517+00:00" },
    "ledger":    { "complete": true,  "oldest": "2026-09-09T06:56:24.294000+00:00" }
  },
  "summary": { "requests": 12256, "failures": 522, "success_rate_pct": 95.74, "credits": 52084.676525 }
}
```

### `GET /v1/me/limit/series?bucket=day` → 200 (тоже только расход, без квоты)

Кредиты по суткам приходят нормально, последние дни:
`2026-09-18: 5822`, `09-19: 7656.8`, `09-20: 1152.6`, `09-21: 5783.3`, `09-22: 9829`, `09-23: 961.1`.
Поля с величиной лимита в ответе нет вовсе.

## Почему это заметно пользователю

Со стороны выглядит как «кредиты показывает, дату сброса показывает, а лимит — нет». Разбор:

| Что видно в UI | Откуда берётся | Состояние |
|---|---|---|
| Потраченные кредиты | `overview.last_24h.credits` | приходит, но это **расход за 24 часа**, не доля квоты |
| Дата сброса | `limits[].reset_at` | приходит |
| Лимит / остаток / процент | `limits[].limit_credits`, `used_credits`, `remaining_credits`, `used_percent` | **`null`** |

Подставлять суточный расход вместо потраченной доли лимита нельзя — это разные величины и разные
окна (сутки против периода до `reset_at` 28.09). Поэтому клиент честно показывает «—» вместо числа,
а не рисует правдоподобную неправду.

Ни один из проверенных endpoint'ов (`/v1/me/limit`, `/v1/me/overview`, `/v1/me/usage`,
`/v1/me/limit/series`) величины квоты не содержит, так что посчитать процент на стороне клиента
тоже не из чего.

Отдельно: `GET /v1/me` (он указан в `router-me-api.md` как «почта, ключи, тариф, состояние места»)
отвечает **404**. Возможно, endpoint переименован или ещё не выкачен — стоит либо поднять его,
либо поправить документацию.

## Что просим

1. Заполнять `limit_credits` и `used_credits` в `/v1/me/limit` и `/v1/me/overview` для тарифа
   `TierA` (и проверить остальные тарифы). Достаточно этих двух — `remaining_credits` и
   `used_percent` клиент посчитает сам, но если сервер их отдаёт, лучше согласованно.
2. Если для какого-то тарифа квоты действительно нет по дизайну (безлимит/постоплата) — отдавать
   это явным признаком, например `unlimited: true` или `limit_credits: 0` с пояснением, чтобы
   клиент показывал «без лимита», а не «данные недоступны».
3. Прояснить статус `GET /v1/me` (сейчас 404).

## Как воспроизвести

```powershell
curl.exe -H "Authorization: Bearer <ключ coder-…>" https://router.encycam.com/v1/me/limit
curl.exe -H "Authorization: Bearer <ключ coder-…>" https://router.encycam.com/v1/me/overview
```

```bash
curl -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" https://router.encycam.com/v1/me/limit
```

## Со стороны клиента

Клиент дорабатывать не требуется — он корректно обрабатывает `null` и не подменяет его нулём.
Поведение: при заполненной квоте индикатор показывает «Роутер · N %», при `null` — измеренный
суточный расход «Роутер · N кр./сут» и поясняет в карточке, что квота сервером не публикуется.
Как только сервер начнёт отдавать `limit_credits`/`used_credits`, процент появится сам, без
обновления приложения. Реализация: `electron/router-usage.mjs`, `src/RouterUsage.tsx`;
описание — `docs/ROUTER_USAGE.md`.
