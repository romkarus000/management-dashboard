# Management Dashboard

Статический SPA дашбордов для EdPro Biz.

## Структура UI

1. **`index.html`** — каталог дашбордов по отделам.
2. **`management.html`** — блок «Управление»: вкладки owner / main / активности.
3. **`marketing.html`** — CRM Маркетинг (warehouse `crm.leading` / `crm.base` / `crm.rfm`).
4. **`sales.html`** — Отдел продаж (C2 / ср.чек / …; пока заглушки, данные из MCP).
5. **`drill.html`** — drill активностей.
6. **`development.html`** — блок «Отдел разработки» (Asana flow metrics, warehouse `dev/*`).

Данные: live API монолита или **warehouse v2** (датасеты по папкам + manifest).

Контракт management: [`docs/warehouse-v2-contract.md`](docs/warehouse-v2-contract.md).  
Контракт разработки: [`docs/dev-flow-contract.md`](docs/dev-flow-contract.md).  
Канон C2/ср.чека ОП: `n8n-corp/tool_mcp_edprobiz/docs/sales-c2-contract.md`.

## Prod

| | |
|---|---|
| URL | http://46.149.70.15:8080/ |
| SSH | `root@46.149.70.15` |
| Document root | `/var/www/management-report/` |
| API proxy | `/api/management-report/` → `https://biz.edpro.ru/api/v1/management-report/` |

## Структура

```
.
├── index.html
├── management.html
├── marketing.html
├── sales.html
├── development.html
├── drill.html
├── docs/
│   └── warehouse-v2-contract.md
├── warehouse/
│   ├── manifest.json
│   ├── filters.json
│   ├── main/profit/YYYY-MM.json
│   ├── owner/marketing/YYYY-MM.json
│   ├── activity/summary/YYYY-MM.json
│   ├── activity/drill/{type}/YYYY-MM.json
│   ├── crm/{leading,base,rfm}/YYYY-MM.json
│   └── dev/{card,series,wip,tasks_closed}/YYYY-MM-DD.json
├── assets/
│   ├── app.js
│   ├── marketing.js
│   ├── sales.js
│   ├── development.js
│   ├── drill.js
│   └── styles.css
└── scripts/
    ├── sync-warehouse.mjs
    ├── sync-dev-warehouse.mjs
    ├── migrate-warehouse-v2.mjs
    └── deploy.sh
```

## Warehouse sync

```bash
export MGMT_REPORT_API_TOKEN='…'

node scripts/sync-warehouse.mjs --mode=mass --tabs=main,owner,activity --from=2021-01 --to=2026-08
node scripts/sync-warehouse.mjs --mode=refresh --tabs=all --include-previous

# drill-витрина (отдельно, тяжелее; бэкенд отдаёт totals/previous/delta)
node scripts/sync-warehouse.mjs --tabs=activity-drill --drill-types=manual_human --months=2026-08
```

### Dev flow (Asana)

```bash
# ASANA_PAT в env или ~/.config/asana.env
node scripts/sync-dev-warehouse.mjs
node scripts/sync-dev-warehouse.mjs --lookback-days=90
```

Миграция со старых `periods/` (уже разложено в v2-папки):

```bash
node scripts/migrate-warehouse-v2.mjs
# когда UI проверен на v2 — удалить legacy:
node scripts/migrate-warehouse-v2.mjs --delete-legacy
```

После sync:

```bash
./scripts/deploy.sh warehouse
# или
./scripts/deploy.sh all
```

## UI

- Старт: список отделов → клик «Управление» → `management.html`.
- Вкладки: owner / main / activity.
- «Из warehouse» / «Обновить с API».
- Drill: warehouse first (`activity/drill/{type}/`), KPI + годовые графики; fallback — live API.
- Token: один раз `?token=…` → localStorage (из URL убирается).

## Связь с монолитом

Backend: `ManagementReportController`, `common/models/services/managementReport/*`.  
Drill KPI: `GET …/partner-activity/drill` отдаёт `totals` / `previous` / `delta` (см. контракт).
