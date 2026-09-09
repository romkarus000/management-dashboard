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

Файлы: `main/profit/`, `owner/marketing/`, `activity/summary/`, `activity/drill/{type}/`.  
Реестр: `warehouse/manifest.json`. Контракт: `docs/warehouse-v2-contract.md`.

## Как действуем

1. Доработали бэкенд в `total-lk-yii` → задеплоили API.
2. Сверили контракт секций / drill totals.
3. При смене UI/ключей — правь этот репо + `./scripts/deploy.sh all`.
4. После mass/refresh — `./scripts/deploy.sh warehouse`.

## Правила

- Не коммить секреты и токены.
- Датасеты warehouse в `.gitignore` — на prod через sync + deploy warehouse.
- Push ≠ деплой. Prod только через `./scripts/deploy.sh`.
