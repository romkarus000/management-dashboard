# Bots warehouse — контракт

Дополнение к [`warehouse-v2-contract.md`](./warehouse-v2-contract.md) для блока **Боты** (Помогатор / Достигаторы).

`warehouseVersion`: **2.0** · отдел: **bots** · зерно: **день** (`YYYY-MM-DD`, snapshot «на дату»)

---

## Источники (Neon, n8n-flow)

| Бот | n8n workflow | Neon schema |
|-----|--------------|-------------|
| Помогатор | `ПОМОГАТОР, основной сценарий` (`2Yl7K80h67J82cUg`) | `pomogator_da` |
| Достигатор на СП | `Бот-Достигатор на СП` (`Jl7yN7ltuOV6zaA7`) | `pomogator` |
| Достигатор на внешний рынок | `Бот-Достигатор на внешний рынок` (`ZT4ROuEtq3uxeVZO`) | `pomogator_vr` |

Primary sync: n8n `[Bots] Funnel Metrics Daily` → HTTP ingest → `warehouse/bots/funnel/`.

---

## Дерево

```text
warehouse/bots/
  funnel/YYYY-MM-DD.json
```

| Dataset | Путь | Содержание |
|---------|------|------------|
| `bots.funnel` | `bots/funnel/` | KPI участников + воронки active/churned по ботам |

Фронт: `bots.html` + `assets/bots.js` (периоды из `manifest.json` → `datasets.bots.funnel`).

---

## Определения метрик

### KPI

| Ключ | Смысл |
|------|--------|
| `participants_total` | Все участники в схеме бота |
| `participants_active` | Не завершили программу и не отпали |
| `participants_churned` | Отпали (молчат ≥ `churn_days`), программа ещё не завершена |
| `participants_completed` | Завершили работу / программа или entitlement закончились |

`churn_days` по умолчанию **7**.

### Этапы воронки (одинаковые ключи у всех ботов)

| Ключ | Помогатор (`pomogator_da`) | Достигаторы (`pomogator` / `pomogator_vr`) |
|------|----------------------------|-------------------------------------------|
| `entered` | есть строка в `users` | есть `messenger_identities` |
| `survey` | `survey_done ∈ {Yes, Done}` | `welcome_done` / `q_index > 0` / заполнены анкетные поля |
| `goals_set` | `goals_done ∈ {Yes, Done}` | есть `coaching_goals` (draft/active/completed) или `goal_approved_at` |
| `goals_achieved` | цель с `total_pct ≥ 100` или `progress ≥ 100` | цель `status = completed` |
| `completed` | дата окончания программы прошла | все цели `completed`, активных целей нет |

### Две воронки

1. **`funnel_active` (воронка успеха)** — **все** участники, кумулятивно: сколько дошли хотя бы до этапа.
2. **`funnel_churned`** — только отпавшие: на каком этапе остановились (точный этап).

---

## Envelope

Как management v2:

```json
{
  "warehouseVersion": "2.0",
  "dataset": "bots.funnel",
  "period": "2026-09-14",
  "fetchedAt": "...",
  "checksum": "...",
  "filters": { "periodType": "day", "period": "2026-09-14", "timezone": "Europe/Moscow", "churnDays": 7 },
  "meta": { "source": "n8n-bots-funnel", "department": "bots", "asOf": "2026-09-14" },
  "data": {
    "asOf": "2026-09-14",
    "churnDays": 7,
    "bots": [
      {
        "id": "pomogator",
        "label": "Помогатор",
        "schema": "pomogator_da",
        "participants_total": 0,
        "participants_active": 0,
        "participants_churned": 0,
        "participants_completed": 0,
        "funnel_active": { "entered": 0, "survey": 0, "goals_set": 0, "goals_achieved": 0, "completed": 0 },
        "funnel_churned": { "entered": 0, "survey": 0, "goals_set": 0, "goals_achieved": 0, "completed": 0 }
      }
    ]
  }
}
```

`bots[].id`: `pomogator` | `dostigator_sp` | `dostigator_vr`.

---

## Прод-контур

```text
Neon (pomogator_da / pomogator / pomogator_vr)
   ↓
n8n flow.ai.edpro.io
  [Bots] Funnel Metrics Daily
  cron: 0 8 * * * Europe/Moscow
  Code: scripts/n8n/bots_funnel_build.js  (собирает ответы Postgres → ingest body)
   ↓ POST Bearer
https://dashboard.edpro.ru/api/dev-warehouse/ingest
   ↓
warehouse/bots/funnel/**
+ merge manifest.bots.funnel
```

Ingest: `scripts/ingest_dev_warehouse.py` — префикс `bots/` + `manifestBotsDatasets`.
