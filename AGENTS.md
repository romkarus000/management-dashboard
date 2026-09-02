# AGENTS.md — management-dashboard

Статический SPA управленческого отчёта (активности партнёров) для EdPro Biz.

## Где что

- Код фронта — этот репозиторий.
- Backend API — монолит `total-lk-yii` (`management-report` API).
- Prod: `root@46.149.70.15:/var/www/management-report/`, URL `http://46.149.70.15:8080/`.

## Как деплоить

```bash
./scripts/deploy.sh app.js
# или
./scripts/deploy.sh all
```

## Правила

- Не коммить секреты и токены.
- При смене ключей метрик в API сначала backend, потом этот фронт.
- Подробности — `README.md`.
