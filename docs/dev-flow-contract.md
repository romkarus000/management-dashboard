# Dev Flow warehouse — контракт

Дополнение к [`warehouse-v2-contract.md`](./warehouse-v2-contract.md) для отдела разработки.

`warehouseVersion`: **2.0** · `department`: **development** · зерно: **day** (`YYYY-MM-DD`)

Канон метрик: vault `06_Notes/N019 Dev Flow Metrics.md`, ТЗ: `N020`.

---

## Дерево

```text
warehouse/dev/
  latest.json
  card/YYYY-MM-DD.json
  series/YYYY-MM-DD.json
  wip/YYYY-MM-DD.json
  tasks_closed/YYYY-MM-DD.json
```

| Dataset | Путь | Содержание |
|---------|------|------------|
| `dev.card` | `dev/card/` | KPI карточки (7 метрик) + previous + playbook |
| `dev.series` | `dev/series/` | throughput по неделям, daily p50, WIP history |
| `dev.wip` | `dev/wip/` | снимок секций + aging + oldest |
| `dev.tasks_closed` | `dev/tasks_closed/` | факты закрытых за сутки |

Envelope — как management v2: `warehouseVersion`, `dataset`, `period`, `fetchedAt`, `checksum`, `filters`, `meta`, `data`.

---

## Sync / deploy

```bash
export ASANA_PAT='…'   # или ~/.config/asana.env

node scripts/sync-dev-warehouse.mjs
node scripts/sync-dev-warehouse.mjs --skip-stories          # быстрее, без cycle
node scripts/sync-dev-warehouse.mjs --lookback-days=90

./scripts/deploy.sh warehouse
```

Источник: Asana project `1203496842794391` (`⌘ dev EDPRObiz`).  
Кэш stories: `.cache/dev-flow-timestamps.json` (gitignore).
