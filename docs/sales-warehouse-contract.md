# Warehouse: sales.kpis

Dataset: `sales.kpis`  
Path: `warehouse/sales/kpis/{YYYY-MM}.json`  
Sync: `node scripts/sync-sales-warehouse.mjs --from=2026-07 --to=2026-08 --companies=0,3`  
Источник: MCP `mcp_segment_orders` + `mcp_sales_qual_leads_per_mop` + `mcp_sales_op_sla_first_call` + `mcp_funnel_statistics` (канон `tool_mcp_edprobiz/docs/sales-c2-contract.md`).

## Envelope

```json
{
  "warehouseVersion": "2.0",
  "dataset": "sales.kpis",
  "period": "2026-08",
  "fetchedAt": "…",
  "checksum": "…",
  "filters": { "periodType": "month", "period": "2026-08" },
  "meta": {
    "source": "mcp_segment_orders + mcp_sales_qual_leads_per_mop + mcp_sales_op_sla_first_call + mcp_funnel_statistics",
    "academy_op_department_ids": [5, 7, 9, 23, 25, 27],
    "sales_v2_funnel_ids": [257, 337, 339, 341, 343, 345, 347, 631],
    "ndz_substatus": "Клиент не берет телефон",
    "ndz_exclude_stage": "В работе КЦ",
    "ndz_closed_reasons": ["Недозвон (НДЗ = 10)", "Контакт не состоялся"]
  },
  "data": {
    "byCompany": {
      "0": { "c2": 0.03, "avg_check": 21000, "qual_leads_mop_day": 1, "ndz_share": 0.26, "…": "…" },
      "3": { "…": "…" }
    }
  }
}
```

## Поля компании

| Ключ | Смысл |
|------|--------|
| `applications` / `application_users` | заявки C2: заказы и уник. клиенты (после spam/line exclude) |
| `application_client_sublines` | уник. заявки как пары клиент×курс: Σ `distinct_users` по `dimension=subline_id` |
| `payments` / `payment_users` | оплаты C2: заказы и уник. клиенты (после spam/line exclude) |
| `c2` | `payments / application_client_sublines` (доля 0…1) |
| `c2_users` | сверка: `payment_users / application_users` |

### Фильтры C2 (канон)

- **Заявки:** `created`, cat 15/19/45, `application_match=offer_or_ads`
- **Оплаты:** `paid`, cat 17/29, `status_id=20`, `paid_only`
- **Знаменатель:** Σ `distinct_users` по `subline_id` (клиент × курс)
- **Числитель:** `orders_count` оплат
- **Исключить line_id:** `33`, `53`, `65`
- **Исключить spam** (`user_detail.id = order.user_id`):
  - phone digits `79990000000`
  - email: `autotest-ui@loc.ru`, `test.mayya@yandex.ru`, `ploshadnova.v@mail.ru`, `test.ploshadnova.v@yandex.ru`
| `payment_net_sum` | чистый итог как `/admin/reports/main` (`with_payment_net`: без тега «Тест», company remapping line 53+EDPRODPO→EdproBiz) |
| `completed_paid_count` | знаменатель ср.чека |
| `avg_check` | `avg_payment_net` |
| `payment_net_dpo_course` | чистый итог только по заказам с позициями cat **17/29** (+ C2 spam/line exclude) |
| `avg_check_dpo_course` | `payment_net_sum / payments` |
| `avg_check_dpo_course_cat` | `payment_net_dpo_course / payments` |
| `qualified_leads` / `mop_count` / `calendar_days` | сумма лидов; снимок МОП; число дней в среднем |
| `mean_leads_per_mop` | среднее `leads_d/mop` (дробь) |
| `qual_leads_mop_day` | `round(mean(leads_d/mop))` по дням 1…N; N=сегодня в текущем месяце |
| `qual_period` | `{ from, to, capped_to_today }` — фактическое окно квал.лидов |
| `sla_first_call_hours` / `sla_first_call_minutes` | AVG рабочих минут → часы/минуты (канон MCP 2026-09-16) |
| `sla_first_call_median_hours` / `sla_first_call_median_minutes` | MEDIAN рабочих минут |
| `sla_orders_with_call` | заказов v2 с `was_in_cc` пусто и найденным 1-м звонком ОП |

### SLA 1 звонка ОП (канон)

**Зафиксирован 2026-09-16.**

- MCP: `mcp_sales_op_sla_first_call` → `avg_hours` / `median_hours` (см. `tool_mcp_edprobiz/docs/sales-c2-contract.md`).
- Когорта: воронка **v2** + **`was_in_cc` пусто**.
- Без CRM `op_sla_first_call_at`, без `LEAST`.
- Первый outbound timeline: order / user / unbound, окно до следующего заказа клиента.
- Фильтр звонка: менеджер **не КЦ** (`sales_department_id <> 47`).
- Рабочие минуты пн–пт МСК: Нутра (dept **5**) 09–18; остальные 10–19.
- **Карточки:** среднее (`sla_first_call_hours`) и медиана (`sla_first_call_median_hours`).
| `sales_department_ids` | линейки ОП `[5,7,9,23,25,27]` |
| `ndz_orders_open` | статус «Клиент не берет телефон» вне этапа «В работе КЦ» |
| `ndz_orders_closed` | этап «Закрыто…» + причина из `ndz_closed_reasons` |
| `ndz_orders_closed_by_reason` | разбивка закрытых НДЗ по причинам |
| `ndz_orders` | `ndz_orders_open + ndz_orders_closed` |
| `ndz_orders_in_cc` | статус «Клиент не берет телефон» на этапе «В работе КЦ» (в долю не входят) |
| `ndz_base_orders` | заказы в воронках V2 за окно НДЗ, **кроме** этапа «В работе КЦ» |
| `ndz_share` | `ndz_orders / ndz_base_orders` (доля 0…1) |
| `ndz_period` | `{ from, to, capped_to_today, window: "last_7_days_of_month" }` — фактическое окно НДЗ |

### % недозвона (НДЗ)

- Источник: `mcp_funnel_statistics` (`mode=summary`, `date_field=funnel_entered`, `channel=none`).
- **Окно:** последние **7 календарных дней** выбранного месяца (не весь месяц).  
  Прошлый месяц — до последнего дня; текущий — до сегодня (МСК).  
  Примеры: авг → `2026-08-25…31`; сен (14-е) → `2026-09-08…14`.
- Воронки: `funnel.version=v2` по каталогу (ids в `meta.sales_v2_funnel_ids`), без «Тестовая воронка V2».
- **Статус** = `funnel_substatus.name` (не этап `funnel_status`).
- **Причины отказа** (`funnel_order.status_reason` → в summary поле `substatus`), точное равенство:
  - **`Недозвон (НДЗ = 10)`** — автозакрытие по тех.счётчику;
  - **`Контакт не состоялся`**.
  Ручные «ндз» / «НДЗ, но читает сообщения» не входят.
- **Этап** «В работе КЦ» исключается из знаменателя; открытый НДЗ на этом этапе — в `ndz_orders_in_cc`.
- Этап/статус/причина — **текущий снимок** на момент sync; период фильтра — дата **входа** в воронку.
- Срез `company_id` пока общий (тул не фильтрует по компании): одно значение для `0` и `3`.

Фронт `assets/sales.js` читает `byCompany[companyId]` (fallback на `"0"`).
