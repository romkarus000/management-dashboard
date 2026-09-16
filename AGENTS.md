# AGENTS.md — management-dashboard

Статический SPA управленческого отчёта для EdPro Biz.

## Где что

- Код фронта — этот репозиторий.
- Backend API — монолит `total-lk-yii` (`management-report` API).
- Warehouse v2 — `warehouse/` по датасетам (см. `docs/warehouse-v2-contract.md`).
- Prod: `root@46.149.70.15:/var/www/management-report/`, URL `http://46.149.70.15:8080/`.

## Вкладки / страницы

1. **`index.html`** — каталог дашбордов по отделам.
2. **`management.html`** — блок «Управление»: owner / main / активности + drill.
3. **`marketing.html`** — блок «CRM Маркетинг»: обзор / коммуникации / база / воронка / RFM (warehouse `crm.*`).
4. **`sales.html`** — блок «Отдел продаж»: C2 / ср.чек / SLA / … (warehouse `sales.kpis`).
5. **`callcenter.html`** — блок «Колл-центр» (в группе Продажи): % квалификации / SLA / % дозвона (warehouse `cc.kpis`, см. `docs/cc-warehouse-contract.md`).
6. **`development.html`** — блок «Отдел разработки» (Asana flow metrics, warehouse `dev/*`).
7. **`bots.html`** — блок «Боты»: Помогатор / Достигатор СП / ВР (warehouse `bots/funnel`).

## Warehouse sync (v2)

```bash
export MGMT_REPORT_API_TOKEN='...'
node scripts/sync-warehouse.mjs --mode=mass --tabs=main,owner,activity --from=2021-01 --to=2026-08
node scripts/sync-warehouse.mjs --mode=refresh --tabs=all --include-previous
node scripts/sync-warehouse.mjs --tabs=activity-drill --drill-types=manual_human --months=2026-08
```

Миграция с v1 `periods/`:

```bash
node scripts/migrate-warehouse-v2.mjs
# node scripts/migrate-warehouse-v2.mjs --delete-legacy
```

Файлы: `main/profit/`, `owner/marketing/`, `activity/summary/`, `activity/drill/{type}/`, `crm/leading|base|rfm/`, `sales/kpis/`, `cc/kpis/`, `dev/*`, `bots/funnel/`. 
Реестр: `warehouse/manifest.json`. Контракты: `docs/warehouse-v2-contract.md`, `docs/crm-warehouse-contract.md`, `docs/sales-warehouse-contract.md`, `docs/cc-warehouse-contract.md`, `docs/dev-flow-contract.md`, `docs/bots-warehouse-contract.md`. 
CRM primary: n8n `[CRM] Leading Metrics Daily` → HTTP ingest → `warehouse/crm/` (каналы enKod/Salebot/BotHelp пока carry).
Bots primary: n8n `[Bots] Funnel Metrics Daily` → HTTP ingest → `warehouse/bots/funnel/`.

## Как действуем

1. Доработали бэкенд в `total-lk-yii` → задеплоили API.
2. Сверили контракт секций / drill totals.
3. При смене UI/ключей — правь этот репо + `./scripts/deploy.sh all`.
4. После mass/refresh — `./scripts/deploy.sh warehouse`.

## Правила

- Не коммить секреты и токены.
- Датасеты warehouse в `.gitignore` — на prod через sync + deploy warehouse.
- Push ≠ деплой. Prod только через `./scripts/deploy.sh`.
