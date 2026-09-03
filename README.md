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

## Как действуем дальше

```
total-lk-yii (API)  →  сверка контракта ключей  →  этот репо (если нужно)  →  ./scripts/deploy.sh
```

1. В монолите доработали backend и задеплоили `management-report` API.
2. Смотрим ответ `partnerActivity.summary.current`: изменились ли **имена ключей** или смысл групп earned/manual.
3. **Если да** — обновляем `assets/app.js` здесь, коммитим, деплоим на сервер.
4. **Если нет** (поменяли только SQL/пороги, ключи те же) — фронт не трогаем, цифры подтянутся сами.

Push в GitHub **не** обновляет http://46.149.70.15:8080/ — только `./scripts/deploy.sh`.

### Когда обновлять фронт

| Ситуация | Фронт |
|---|---|
| Новый / переименованный / удалённый ключ в JSON | **да** |
| Способ переехал из «ручная» в «заработано» (или наоборот) | **да** — `EARNED_KEYS` / `MANUAL_KEYS` |
| Новая подпись или hint на карточке | **да** |
| Правка вёрстки / фильтров / графиков | **да** |
| Только SQL, пороги, кэш, auth — ключи те же | **нет** |
| Правки админки owner-отчёта в Yii | **нет** (другой UI) |

Порядок при смене контракта:

1. Backend (`total-lk-yii`) на prod.
2. Этот фронт + `./scripts/deploy.sh app.js`.
3. При необходимости на app-сервере: `./yii management-report/warm-cache`.

Правило для агентов: `.cursor/rules/when-to-update-frontend.mdc`.

## Ключи метрик partnerActivity (schema 2.0)

**Заработанные** (`EARNED_KEYS`):

`purchase`, `registration`, `hybrid`, `adv`, `club`, `partner_registration`, `product_education`, `overlap`

**Ручные** (`MANUAL_KEYS`):

`manual_ambassador`, `manual_barter_influence`, `manual_barter_solo`, `manual_coach`, `manual_human`

Приоритет ручных: амбассадоры (parent 4264877 / comment «амбассадор*») → бартер инфлюенс (группа 3823) → бартер самостоятельный («блогер*») → коучи/наставники/кураторы/сотрудники → human.

**Overview:** `total`, `manual` (из API), `earned` (сумма `EARNED_KEYS` на фронте)

SQL-логика: `OwnerPartnerActivityStatsRepository` в монолите `total-lk-yii`.

## Связь с монолитом

Backend: `api/modules/v1/controllers/ManagementReportController.php`,  
`common/models/services/managementReport/*`,  
`common/models/reports/OwnerPartnerActivity*`.
