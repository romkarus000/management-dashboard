# Warehouse: sales.kpis

Dataset: `sales.kpis`  
Path: `warehouse/sales/kpis/{YYYY-MM}.json`  
Sync: `node scripts/sync-sales-warehouse.mjs --from=2026-07 --to=2026-08 --companies=0,3`  
Источник: MCP `mcp_segment_orders` + `mcp_sales_qual_leads_per_mop` (канон `tool_mcp_edprobiz/docs/sales-c2-contract.md`).

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
    "source": "mcp_segment_orders + mcp_sales_qual_leads_per_mop",
    "academy_op_department_ids": [5, 7, 9, 23, 25, 27]
  },
  "data": {
    "byCompany": {
      "0": { "c2": 0.03, "avg_check": 21000, "qual_leads_mop_day": 1, "…": "…" },
      "3": { "…": "…" }
    }
  }
}
```

## Поля компании

| Ключ | Смысл |
|------|--------|
| `applications` / `application_users` | заявки C2: заказы и уник. клиенты |
| `payments` / `payment_users` | оплаты C2: заказы и уник. клиенты |
| `c2` | `payment_users / application_users` (доля 0…1) |
| `payment_net_sum` | чистый итог (`with_payment_net`) |
| `completed_paid_count` | знаменатель ср.чека |
| `avg_check` | `avg_payment_net` |
| `qualified_leads` / `mop_count` / `calendar_days` | сумма лидов; снимок МОП; число дней в среднем |
| `mean_leads_per_mop` | среднее `leads_d/mop` (дробь) |
| `qual_leads_mop_day` | `round(mean(leads_d/mop))` по дням 1…N; N=сегодня в текущем месяце |
| `qual_period` | `{ from, to, capped_to_today }` — фактическое окно квал.лидов |
| `sales_department_ids` | линейки ОП `[5,7,9,23,25,27]` |

Фронт `assets/sales.js` читает `byCompany[companyId]` (fallback на `"0"`).
