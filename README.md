# Management Dashboard

Статический SPA «Управленческий отчёт» (активности партнёров) для EdPro Biz.

Данные берёт из API `management-report` монолита `total-lk-yii`. Сам фронт живёт отдельно от монолита.

## Prod

| | |
|---|---|
| URL | http://46.149.70.15:8080/ |
| SSH | `root@46.149.70.15` |
| Document root | `/var/www/management-report/` |
| Nginx | `/etc/nginx/sites-available/management-report` |
| API (через nginx proxy) | `/api/management-report/` → `https://biz.edpro.ru/api/v1/management-report/` |

## Структура

```
.
├── index.html          # UI, window.MGMT_REPORT_API_BASE
├── snapshot.json       # офлайн-демо
├── assets/
│   ├── app.js          # METRICS, EARNED_KEYS / MANUAL_KEYS
│   └── styles.css
└── scripts/
    └── deploy.sh
```

## Локально

Открой `index.html` через любой static server, либо правь и сразу деплой.

Live-режим: Bearer-токен API в query `?token=...` или в `localStorage` (`mgmtReportApiToken`).

## Деплой

```bash
./scripts/deploy.sh app.js   # только JS
./scripts/deploy.sh all      # index + css + js
```

Переменные:

- `MGMT_DASHBOARD_SERVER` — SSH target (по умолчанию `root@46.149.70.15`)
- `MGMT_DASHBOARD_PATH` — remote root (по умолчанию `/var/www/management-report`)

## Когда обновлять

Обновляй этот репозиторий и деплой на сервер, если меняются:

- ключи метрик в ответе `partnerActivity.summary`;
- подписи / группы способов (`earned` vs `manual`);
- вёрстка (`index.html`, `styles.css`).

Backend-only правки в `total-lk-yii` без смены ключей — дашборд не трогать.

Порядок при смене контракта метрик:

1. Задеплоить backend (`total-lk-yii`).
2. Обновить и задеплоить этот фронт: `./scripts/deploy.sh app.js`.
3. При необходимости на app-сервере: `./yii management-report/warm-cache`.

## Ключи метрик partnerActivity (schema 2.0)

**Заработанные** (`EARNED_KEYS`):

`purchase`, `registration`, `hybrid`, `adv`, `club`, `partner_registration`, `product_education`, `overlap`

**Ручные** (`MANUAL_KEYS`):

`manual_role`, `manual_human`

**Overview:** `total`, `manual` (из API), `earned` (сумма `EARNED_KEYS` на фронте)

SQL-логика: `OwnerPartnerActivityStatsRepository` в монолите `total-lk-yii`.

## Связь с монолитом

Backend: `api/modules/v1/controllers/ManagementReportController.php`,  
`common/models/services/managementReport/*`,  
`common/models/reports/OwnerPartnerActivity*`.
