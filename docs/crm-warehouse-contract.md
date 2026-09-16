# CRM warehouse — контракт

Дополнение к [`warehouse-v2-contract.md`](./warehouse-v2-contract.md) для блока **CRM Маркетинг**.

`warehouseVersion`: **2.0** · отдел: **CRM** · зерно: **месяц** (`YYYY-MM`)  
Канон метрик: `PROJECT.md` crm-leading-dashboard (2026-09-10).

---

## Дерево

```text
warehouse/crm/
  leading/YYYY-MM.json
  base/YYYY-MM.json
  rfm/YYYY-MM.json
```

| Dataset | Путь | Содержание |
|---------|------|------------|
| `crm.leading` | `crm/leading/` | коммуникации (email/tg/vk/max) + заявки / C2 / regs |
| `crm.base` | `crm/base/` | размеры баз + active/cold/hot (email) + payers_12m |
| `crm.rfm` | `crm/rfm/` | RFM-сегменты плательщиков ~12 мес по направлениям |

Envelope — как management v2.  
Фронт: `marketing.html` + `assets/marketing.js` (периоды из `manifest.json` → `datasets.crm.leading`).

---

## Прод-контур (primary = n8n)

```text
EdproBiz MCP (leads / C2 / RFM)
   ↓
n8n flow.ai.edpro.io
  [CRM] Leading Metrics Daily  (AoiBSNwB2RODMDBD)
  cron light: 0 7 * * * Europe/Moscow
  cron heavy: 0 3 * * 0 Europe/Moscow (вс)
  Code: scripts/n8n/crm_leading_build.js
   ↓ POST Bearer
https://dashboard.edpro.ru/api/dev-warehouse/ingest
   ↓ nginx → 127.0.0.1:8791 (systemd: dev-warehouse-ingest)
/var/www/management-report/warehouse/crm/**
+ merge manifest.crm.*
```

| Mode | Когда | Что делает |
|------|--------|------------|
| **light** (default) | ежедневно 07:00, Manual, webhook без `mode` | EdproBiz + enKod sent/OR/CTR; Salebot/email_base из кэша/carry; догон ≤400 новых имён писем |
| **heavy** | вс 03:00 или webhook `?mode=heavy` / body `{"mode":"heavy"}` | enKod `email_base` + догон ≤5000 имён; **Salebot full scan — вне n8n** (`scripts/crm_heavy_refresh.py`) из‑за task timeout 300s |


Кэши: `crm/_cache/salebot_base.json`, `crm/_cache/enkod_message_names.json`.

| Шаг | Прод | Примечание |
|-----|------|------------|
| Источник заявок/C2/RFM | EdproBiz MCP | токен в Code node n8n |
| messenger base TG/VK | Salebot `get_clients` | **heavy**; light → кэш |
| Запись склада | HTTP ingest (тот же token, что Dev Flow) | пути `crm/**` разрешены |
| UI | `marketing.html` | читает warehouse |

Ingest: `scripts/ingest_dev_warehouse.py` (allows `dev/` + `crm/`).

---

## Направления

| Код | utm_medium | line_id |
|-----|------------|---------|
| nutra | `rass_edpro_nutra` | 3 |
| psi | `user_kp_psi` | 17 |
| sex | `user_kp_sex` | 5 |
| icf | `user_kp_icf` | 11 |
| design | `user_kp_design` | 23 |

Заявки: `offer_categories = [13, 15, 19, 45]`.  
C2: `mcp_channel_segment_revenue` · `lead_cohort` · `since_lead=true` · `date_to` исключительно.

Ежедневный **light** обновляет **предыдущий + текущий** месяц. RFM — только текущий (тяжело).
**Heavy** (раз в неделю) обновляет базы Salebot/enKod.

---

## Ручной прогон

В n8n: Manual Trigger или webhook:

```bash
# light
curl -sS -X POST 'https://flow.ai.edpro.io/webhook/crm-leading-run' -H 'Content-Type: application/json' -d '{}'
# heavy
curl -sS -X POST 'https://flow.ai.edpro.io/webhook/crm-leading-run?mode=heavy' -H 'Content-Type: application/json' -d '{"mode":"heavy"}'
```

Проверка:

```bash
curl -sS https://dashboard.edpro.ru/warehouse/crm/leading/2026-09.json | head
curl -sS https://dashboard.edpro.ru/api/dev-warehouse/health
```

---

## Что ещё не в автосборе

| Источник | Статус |
|----------|--------|
| enKod sent/OR/CTR | **да** (light); `email_base` — **heavy** |
| Salebot `get_clients` (база TG/VK) | **heavy**; light → кэш `salebot_base.json` |
| email active/cold/hot сегменты | carry (нет стабильных segment id в API групп) |
| Salebot sent | Playwright / UI session |
| BotHelp MAX broadcast / база | Playwright; OAuth часто 403 |

Пока эти поля **переносятся (carry)** из seed/прошлого прогона, чтобы C2/заявки обновлялись без дыр в UI.
