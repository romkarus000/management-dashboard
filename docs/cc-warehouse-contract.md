# Warehouse: cc.kpis

Dataset: `cc.kpis`  
Path: `warehouse/cc/kpis/{YYYY-MM}.json`  
Страница: `callcenter.html` · `assets/callcenter.js`  
Каталог: секция «Продажи» → карточка «Колл-центр».

Sync: `node scripts/sync-cc-warehouse.mjs --from=2026-08 --to=2026-09 --companies=0,3`  
Источник: MCP **`mcp_cc_qualification_rate`** + **`mcp_cc_sla_first_call`**.

---

## Envelope

```json
{
  "warehouseVersion": "2.0",
  "dataset": "cc.kpis",
  "period": "2026-09",
  "fetchedAt": "…",
  "checksum": "…",
  "filters": { "periodType": "month", "period": "2026-09" },
  "meta": {
    "source": "mcp_cc_qualification_rate + mcp_cc_sla_first_call",
    "funnel_version": "v2",
    "was_in_cc_value": "Да",
    "qualified_cc_value": "Да",
    "first_touch_attr": "cc_sla_first_touch_at",
    "qualification_date_attr": "cc_qualification_date",
    "sla_cc_department_id": 47,
    "sla_work_hours": "09:00–20:00",
    "sla_exclude": "returned_from_op + заявки вне 09:00–20:00"
  },
  "data": {
    "byCompany": {
      "0": {
        "cc_touched": 120,
        "cc_qualified_same_month": 48,
        "qualification_rate": 0.4,
        "sla_first_call_avg_min": 12.5,
        "sla_first_call_median_min": 4.2,
        "sla_orders_with_call": 90,
        "sla_p70_min": 8.1,
        "sla_p90_min": 25.0,
        "sla_within_5min": 50,
        "sla_within_15min": 70,
        "sla_within_1h": 85,
        "sla_src_order": 40,
        "sla_src_user": 30,
        "sla_src_unbound": 20,
        "dial_rate": null
      }
    }
  }
}
```

---

## % квалификации (главный KPI) — канон

**Вариант A, зафиксирован 2026-09-16.**

Когорта месяца = лиды с **первым касанием КЦ** в выбранном месяце.  
Квалификация засчитывается **только в том же месяце**.

| Часть | Правило |
|-------|---------|
| **Зерно** | уникальный `order_id` в воронке `version=v2` |
| **Знаменатель `cc_touched`** | `was_in_cc = «Да»` **и** `cc_sla_first_touch_at` ∈ [from, to] |
| **Числитель `cc_qualified_same_month`** | из знаменателя: `qualified_cc = «Да»` **и** `cc_qualification_date` ∈ [from, to] |
| **`qualification_rate`** | `cc_qualified_same_month / cc_touched` (доля 0…1); если знаменатель 0 → `null` |
| **Окно** | календарный месяц; текущий месяц — до сегодня (МСК), как у sales |
| **MCP** | `mcp_cc_qualification_rate(date_from, date_to, company_id?, mode)` |

### Поля CRM (`lk.funnel_order_attributes`)

| UI | `attribute_name` | Роль в формуле |
|----|------------------|----------------|
| Лид был в КЦ | `was_in_cc` | признак «был в КЦ» (`«Да»`) |
| Дата первого касания SLA КЦ | `cc_sla_first_touch_at` | **дата когорты** (первое касание) |
| Квалифицирован КЦ | `qualified_cc` | признак квалификации (`«Да»`) |
| Дата квалификации | `cc_qualification_date` | **дата числителя** (write-once) |

Не путать с метрикой ОП `mcp_sales_qual_leads_per_mop` (`qualified_cc` + **`op_call_date`**).

### Краевые случаи

- Есть `was_in_cc`, но нет `cc_sla_first_touch_at` → **не** в знаменателе (нет даты первого касания).
- Касание в сентябре, квалификация в октябре → в сентябре только знаменатель; в октябре **не** попадает в числитель (когорта не того месяца).
- Касание и квалификация в одном месяце → в числителе и знаменателе.

---

## SLA 1 звонка КЦ — канон

**Зафиксирован 2026-09-16.** CRM-поля `cc_sla_first_touch_at` / `cc_sla_first_call_at` **не** используются (дают завышенные часы). Считаем по timeline.

| Часть | Правило |
|-------|---------|
| **Когорта** | funnel `v2` + `was_in_cc=«Да»` + `returned_from_op` пусто + `TIME(order.created)` ∈ `[09:00, 20:00)` |
| **Событие** | первый исходящий звонок (`timeline.item_type=3`, `direction=outbound`) менеджера `sales_department_id=47` после `order.created` |
| **Привязка звонка** | на заказе (`entity_type=1`) **или** на пользователе (`entity_type=2`) **или** unbound |
| **Окно** | от `order.created` до следующего заказа того же `user_id` (или ∞) |
| **Период** | по `order.created` |
| **Карточка** | `sla_first_call_avg_min`, `sla_first_call_median_min` (минуты) |
| **Hint** | «исключены звонки в нерабочее время и возвращенные из ОП» |
| **MCP** | `mcp_cc_sla_first_call(date_from, date_to, company_id?, mode)` |

### Поля warehouse (SLA)

| Ключ | Смысл |
|------|--------|
| `sla_first_call_avg_min` | среднее минут до 1-го звонка КЦ |
| `sla_first_call_median_min` | медиана (p50) минут |
| `sla_orders_with_call` | заказов со звонком (`orders_with_sla`) |
| `sla_p70_min` / `sla_p90_min` | перцентили (деталка) |
| `sla_within_5min` / `15min` / `1h` | счётчики порогов (деталка) |
| `sla_src_order` / `user` / `unbound` | разбивка источника звонка (деталка) |

### Деталка SQL (канон-сводка, для возврата)

Построчный запрос (sample до 500) и сводка avg / median / p70 / p90 — ниже. Параметры дат подставлять вручную.

```sql
-- Сводка SLA КЦ: avg / median(=p50) / p70 / p90
WITH params AS (
  SELECT
    '2026-09-01' AS date_from,
    '2026-09-16 23:59:59' AS date_to
),
v2_cc_orders AS (
  SELECT
    o.id AS order_id,
    o.user_id,
    o.created AS order_created,
    o.company_id
  FROM `order` o
  INNER JOIN funnel_order fo ON fo.order_id = o.id
  INNER JOIN funnel f ON f.id = fo.funnel_id AND f.version = 'v2'
  INNER JOIN funnel_order_attributes foa_w
    ON foa_w.funnel_order_id = fo.id
   AND foa_w.attribute_name = 'was_in_cc'
   AND foa_w.attribute_value = 'Да'
  LEFT JOIN funnel_order_attributes foa_r
    ON foa_r.funnel_order_id = fo.id
   AND foa_r.attribute_name = 'returned_from_op'
  WHERE o.created BETWEEN (SELECT date_from FROM params)
                      AND (SELECT date_to FROM params)
    AND TIME(o.created) >= '09:00:00'
    AND TIME(o.created) <  '20:00:00'
    AND (
      foa_r.id IS NULL
      OR NULLIF(TRIM(foa_r.attribute_value), '') IS NULL
      OR LOWER(TRIM(foa_r.attribute_value)) IN ('0', 'нет', 'no', 'false')
    )
  GROUP BY o.id, o.user_id, o.created, o.company_id
),
orders_base AS (
  SELECT
    v.order_id,
    v.user_id,
    v.order_created,
    v.company_id,
    n.next_created AS next_order_created
  FROM v2_cc_orders v
  LEFT JOIN (
    SELECT
      o.id AS order_id,
      LEAD(o.created) OVER (PARTITION BY o.user_id ORDER BY o.created, o.id) AS next_created
    FROM `order` o
    WHERE o.user_id IN (SELECT user_id FROM v2_cc_orders)
  ) n ON n.order_id = v.order_id
),
first_call AS (
  SELECT
    ob.order_id,
    ob.order_created,
    t.created AS first_call_at,
    CASE
      WHEN t.entity_type = 1 AND t.entity_id = ob.order_id THEN 'order'
      WHEN t.entity_type = 2 AND t.entity_id = ob.user_id THEN 'user'
      ELSE 'unbound'
    END AS call_source,
    ROW_NUMBER() OVER (
      PARTITION BY ob.order_id
      ORDER BY t.created ASC, t.id ASC
    ) AS rn
  FROM orders_base ob
  INNER JOIN timeline t
    ON t.user_id = ob.user_id
   AND t.item_type = 3
   AND t.created >= ob.order_created
   AND (ob.next_order_created IS NULL OR t.created < ob.next_order_created)
   AND JSON_UNQUOTE(JSON_EXTRACT(t.item_data, '$.direction')) = 'outbound'
   AND (
        (t.entity_type = 1 AND t.entity_id = ob.order_id)
     OR (t.entity_type = 2 AND t.entity_id = ob.user_id)
     OR (IFNULL(t.entity_type, 0) NOT IN (1, 2) OR IFNULL(t.entity_id, 0) = 0)
       )
  INNER JOIN sales_manager sm
    ON sm.id = t.sales_manager_id
   AND sm.sales_department_id = 47
),
sla AS (
  SELECT
    TIMESTAMPDIFF(SECOND, order_created, first_call_at) AS sla_sec,
    call_source
  FROM first_call
  WHERE rn = 1
)
SELECT
  COUNT(*) AS n,
  ROUND(AVG(sla_sec) / 60, 2) AS avg_min,
  ROUND(
    SUBSTRING_INDEX(
      SUBSTRING_INDEX(GROUP_CONCAT(sla_sec ORDER BY sla_sec), ',', 50 * COUNT(*) / 100 + 1),
      ',', -1
    ) / 60, 2
  ) AS median_min,
  ROUND(
    SUBSTRING_INDEX(
      SUBSTRING_INDEX(GROUP_CONCAT(sla_sec ORDER BY sla_sec), ',', 70 * COUNT(*) / 100 + 1),
      ',', -1
    ) / 60, 2
  ) AS p70_min,
  ROUND(
    SUBSTRING_INDEX(
      SUBSTRING_INDEX(GROUP_CONCAT(sla_sec ORDER BY sla_sec), ',', 90 * COUNT(*) / 100 + 1),
      ',', -1
    ) / 60, 2
  ) AS p90_min,
  SUM(sla_sec <= 300) AS within_5min,
  SUM(sla_sec <= 900) AS within_15min,
  SUM(sla_sec <= 3600) AS within_1h,
  SUM(call_source = 'order') AS src_order,
  SUM(call_source = 'user') AS src_user,
  SUM(call_source = 'unbound') AS src_unbound
FROM sla;
```

Построчная деталка (тот же фильтр когорты / first_call, `WHERE rn = 1`):

```sql
-- … те же CTE v2_cc_orders / orders_base / first_call …
SELECT
  f.order_id,
  f.user_id,
  f.company_id,
  f.order_created,
  f.timeline_id,
  f.first_call_at,
  ROUND(TIMESTAMPDIFF(SECOND, f.order_created, f.first_call_at) / 60, 2) AS minutes_to_first_call,
  f.sales_manager_id,
  CONCAT_WS(' ', ud.surname, ud.name) AS manager_fio,
  f.dialog_sec,
  f.call_source
FROM first_call f
LEFT JOIN user_detail ud ON ud.id = f.sales_manager_id
WHERE f.rn = 1
ORDER BY f.order_id
LIMIT 500;
```

(В построчном CTE `first_call` нужны также `user_id`, `company_id`, `timeline_id`, `sales_manager_id`, `dialog_sec` — см. исходный запрос в истории / MCP `mode=summary`.)

---

## Остальные KPI (заготовки)

| Ключ | Смысл | Статус |
|------|--------|--------|
| `dial_rate` | % дозвона КЦ | скоро (этап «В работе КЦ» / НДЗ) |

---

## Фронт

- Карточки: `% квалификации` (overview), `SLA 1 звонка · среднее`, `SLA 1 звонка · медиана`, `% дозвона`.
- SLA hint: «исключены звонки в нерабочее время и возвращенные из ОП».
- Блок «Деталка SLA» — p70/p90, within_*, источники.
- Срез `byCompany[companyId]`, fallback на `"0"`.
