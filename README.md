# Management Dashboard

Статический SPA дашбордов для EdPro Biz.

## Структура UI

1. **`index.html`** — каталог дашбордов по отделам.
2. **`management.html`** — блок «Управление»: вкладки owner / main / активности.
3. **`drill.html`** — drill активностей.

Данные: live API монолита или **warehouse** (месячные JSON + manifest).

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
├── index.html                 # каталог по отделам
├── management.html            # блок «Управление»
├── drill.html
├── snapshot.json
├── warehouse/
│   ├── manifest.json
│   ├── latest.json
│   └── periods/YYYY-MM.json
├── assets/
│   ├── app.js
│   ├── drill.js
│   └── styles.css
└── scripts/
    ├── sync-warehouse.mjs
    └── deploy.sh
```

## Warehouse sync

Один API-запрос = один месяц (`query-batch`: profit + companyMarketing + partnerActivity).

```bash
export MGMT_REPORT_API_TOKEN='…'

node scripts/sync-warehouse.mjs --mode=mass --from=2021-01 --to=2026-08
node scripts/sync-warehouse.mjs --mode=refresh --include-previous
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
- Token: `?token=…` пробрасывается между страницами.

## Связь с монолитом

Backend: `ManagementReportController`, `common/models/services/managementReport/*`.
