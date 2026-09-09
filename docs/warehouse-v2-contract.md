# Warehouse + Drill API — контракт v2

Контракт для `management-dashboard` и монолита `total-lk-yii` (`management-report`).

`warehouseVersion`: **2.0**  
Дата: 2026-09-09

---

## 1. Зачем v2

В v1 один файл `periods/YYYY-MM.json` держал все секции месяца.  
Для drill (KPI + годовые графики) так нельзя: другое зерно и больший объём.

v2 режет склад **по домену и зерну** (как таблицы витрины).

---

## 2. Дерево warehouse

```text
warehouse/
  manifest.json
  filters.json
  main/
    profit/YYYY-MM.json
  owner/
    marketing/YYYY-MM.json
  activity/
    summary/YYYY-MM.json
    drill/
      {type}/YYYY-MM.json
```

| Dataset id | Путь | Зерно | Потребитель |
|---|---|---|---|
| `main.profit` | `main/profit/YYYY-MM.json` | месяц | вкладка Main |
| `owner.marketing` | `owner/marketing/YYYY-MM.json` | месяц | вкладка Owner |
| `activity.summary` | `activity/summary/YYYY-MM.json` | месяц | вкладка Активности |
| `activity.drill.{type}` | `activity/drill/{type}/YYYY-MM.json` | месяц × корзина | `drill.html` |

`periods/YYYY-MM.json` (v1) — legacy, не писать в новых sync.

---

## 3. Общий envelope датасета

Каждый файл месяца:

```json
{
  "warehouseVersion": "2.0",
  "dataset": "main.profit",
  "period": "2026-08",
  "fetchedAt": "2026-09-08T08:21:57.495Z",
  "checksum": "acfe53e2a0118a15",
  "filters": {
    "periodType": "month",
    "period": "2026-08",
    "compareMode": "previous",
    "companyId": 0
  },
  "meta": {},
  "data": {}
}
```

- `dataset` — id из таблицы выше (`activity.drill.manual_human` для drill).
- `data` — тело секции (см. ниже).
- `checksum` — sha256 (16 hex) от нормализованного `data` (без `fetchedAt`).

---

## 4. Тела датасетов (summary)

### 4.1 `main.profit` → `data`

Как блок API `blocks.main.profit`:

```json
{
  "labels": {},
  "periods": { "current": {}, "previous": {} },
  "summary": {
    "current": { "grossTurnover": 0, "netTotal": 0, "creditTurnover": 0 },
    "previous": {},
    "delta": {}
  },
  "byCompany": [],
  "companyScoped": true
}
```

Источник sync: `GET …/query?reportType=main&section=profit`  
или `query-batch` с `mainSections=profit`.

### 4.2 `owner.marketing` → `data`

Как `blocks.owner.companyMarketing` (summary / byCompany / periods).

Источник: `reportType=owner&section=companyMarketing`.

### 4.3 `activity.summary` → `data`

Как `blocks.owner.partnerActivity` (счётчики партнёров по корзинам).

Ключи `summary.current` (стабильный набор):

`total`, `manual`, `earned` (на фронте может считаться),  
`purchase`, `registration`, `hybrid`, `adv`, `club`,  
`partner_registration`, `product_education`, `overlap`,  
`manual_ambassador`, `manual_barter_influence`, `manual_cross_marketing`,  
`manual_barter_solo`, `manual_coach`, `manual_human`.

Источник: `reportType=owner&section=partnerActivity`.

---

## 5. Drill API (монолит) — контракт для витрины

### 5.1 Существующий endpoint (расширяем)

```http
GET /api/v1/management-report/partner-activity/drill
  ?type={basket}
  &periodType=month
  &period=YYYY-MM
  &companyId=0
  &compareMode=previous
```

Authorization: `Bearer <token>`

#### `type` (корзины)

`total`, `manual`,  
`purchase`, `registration`, `hybrid`, `adv`, `club`,  
`partner_registration`, `product_education`, `overlap`,  
`manual_ambassador`, `manual_barter_influence`, `manual_cross_marketing`,  
`manual_barter_solo`,  
`manual_coach`, `manual_human`.

### 5.2 Ответ `data` (обязательные поля для warehouse)

```json
{
  "type": "manual_human",
  "window": {
    "label": "Август 2026",
    "from": "2026-08-01",
    "to": "2026-08-31"
  },
  "meta": {
    "label": "Аккаунты компании",
    "partnerCount": 206,
    "elapsedMs": 1200
  },
  "totals": {
    "reg_count": 1540,
    "revenue": 1234567.89
  },
  "previous": {
    "reg_count": 1400,
    "revenue": 1100000.00
  },
  "delta": {
    "reg_count": {
      "absolute": 140,
      "percent": 10.0,
      "meaningful": true,
      "isNew": false
    },
    "revenue": {
      "absolute": 134567.89,
      "percent": 12.23,
      "meaningful": true,
      "isNew": false
    }
  },
  "partners": [
    {
      "partner_id": 1,
      "fio": "…",
      "email": "…",
      "reg_count": 10,
      "revenue": 1000.5
    }
  ],
  "leads": [
    {
      "partner_id": 1,
      "partner_fio": "…",
      "client_fio": "…",
      "client_email": "…",
      "channel": "cpc",
      "payment_count": 2,
      "revenue": 500.25
    }
  ]
}
```

#### Семантика KPI (зафиксировано продуктом)

| Поле | Смысл |
|---|---|
| `totals.reg_count` | Сумма `partners[].reg_count` — регистрации 1 линии за период по партнёрам корзины |
| `totals.revenue` | Сумма `partners[].revenue` — выручка (чистый итог) 1 линии за период |
| `previous.*` | Те же метрики за предыдущий период (`compareMode=previous`) |
| `delta.*` | Как в summary-секциях management-report |

**Обязательно на бэкенде:** отдавать `totals` / `previous` / `delta`, чтобы sync и UI не суммировали таблицы сами.  
До миграции бэка sync **может** посчитать `totals` как сумму `partners` (fallback).

### 5.3 Опционально позже: годовая серия

```http
GET …/partner-activity/drill-series?type={basket}&year=2026&companyId=0
```

```json
{
  "type": "manual_human",
  "year": 2026,
  "months": [
    {
      "period": "2026-01",
      "totals": { "reg_count": 0, "revenue": 0 },
      "previous": { "reg_count": 0, "revenue": 0 }
    }
  ]
}
```

Пока **не обязательно**: фронт собирает год из 12 файлов `activity/drill/{type}/YYYY-MM.json`.

---

## 6. Файл `activity.drill.{type}`

Envelope + `data` = тело ответа drill (§5.2) целиком  
(или урезанный вариант без `leads`, если нужна экономия; KPI/графикам хватает `totals`/`previous`/`delta`).

Минимум для графиков и KPI на drill-странице:

```json
{
  "warehouseVersion": "2.0",
  "dataset": "activity.drill.manual_human",
  "period": "2026-08",
  "type": "manual_human",
  "fetchedAt": "…",
  "checksum": "…",
  "filters": { "periodType": "month", "period": "2026-08", "compareMode": "previous", "companyId": 0 },
  "data": {
    "type": "manual_human",
    "totals": { "reg_count": 1540, "revenue": 1234567.89 },
    "previous": { "reg_count": 1400, "revenue": 1100000 },
    "delta": {},
    "partners": [],
    "leads": []
  }
}
```

Путь: `activity/drill/manual_human/2026-08.json`.

---

## 7. Manifest v2

```json
{
  "version": "2.0",
  "schemaVersion": "2.0",
  "warehouseVersion": "2.0",
  "generatedAt": "2026-09-08T08:22:34.998Z",
  "coverage": {
    "from": "2021-01",
    "to": "2026-09",
    "count": 69
  },
  "datasets": {
    "main.profit": {
      "path": "main/profit",
      "coverage": { "from": "2021-01", "to": "2026-09", "count": 69 },
      "periods": {
        "2026-08": {
          "fetchedAt": "…",
          "checksum": "…",
          "file": "main/profit/2026-08.json",
          "changed": false,
          "durationMs": 100
        }
      }
    },
    "owner.marketing": { "path": "owner/marketing", "coverage": {}, "periods": {} },
    "activity.summary": { "path": "activity/summary", "coverage": {}, "periods": {} },
    "activity.drill.manual_human": {
      "path": "activity/drill/manual_human",
      "coverage": {},
      "periods": {}
    }
  },
  "lastRun": {
    "mode": "refresh",
    "tabs": ["main", "owner", "activity"],
    "at": "…",
    "ok": 1,
    "failed": [],
    "changed": 0
  }
}
```

`coverage` корневой — объединение периодов по всем summary-датасетам (для выбора месяца в UI).

---

## 8. Sync CLI

```bash
# summary-витрины
node scripts/sync-warehouse.mjs --mode=mass --tabs=main,owner,activity --from=2021-01 --to=2026-08
node scripts/sync-warehouse.mjs --mode=refresh --tabs=all --include-previous

# drill (отдельно — тяжелее)
node scripts/sync-warehouse.mjs --mode=mass --tabs=activity-drill --from=2026-01 --to=2026-08
node scripts/sync-warehouse.mjs --tabs=activity-drill --drill-types=manual_human,purchase --months=2026-08
```

| Tab CLI | Dataset(s) |
|---|---|
| `main` | `main.profit` |
| `owner` | `owner.marketing` |
| `activity` | `activity.summary` |
| `activity-drill` | `activity.drill.*` |
| `all` | main + owner + activity (**без** drill) |

---

## 9. Порядок внедрения

1. Контракт (этот файл) — **готово**.
2. Sync пишет в папки v2; миграция `periods/` → папки.
3. Фронт читает v2-пути.
4. Бэкенд добавляет `totals`/`previous`/`delta` в drill.
5. Sync `activity-drill` наполняет `activity/drill/{type}/`.
6. UI drill: KPI + годовые графики из warehouse.

---

## 10. Несовместимость

| | v1 | v2 |
|---|---|---|
| Файл месяца | `periods/YYYY-MM.json` | датасеты по папкам |
| `warehouseVersion` | `1.0` | `2.0` |
| Drill в warehouse | нет | `activity/drill/{type}/` |

Фронт v2 **не** обязан читать `periods/`. После миграции legacy можно удалить с диска.
