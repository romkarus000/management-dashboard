# AGENTS.md — management-dashboard

Статический SPA управленческого отчёта (активности партнёров) для EdPro Biz.

## Где что

- Код фронта — этот репозиторий.
- Backend API — монолит `total-lk-yii` (`management-report` API).
- Prod: `root@46.149.70.15:/var/www/management-report/`, URL `http://46.149.70.15:8080/`.

## Как действуем (процесс)

1. Доработали бэкенд в `total-lk-yii` → задеплоили API.
2. Сверили **контракт** ответа `partnerActivity.summary` (ключи и смысл).
3. Если контракт/подписи/UI изменились — правим этот репо и деплоим:
   ```bash
   ./scripts/deploy.sh app.js   # или all
   ```
4. Если поменялась только внутренняя логика SQL без смены ключей — **фронт не трогаем**.

Подробное правило: `.cursor/rules/when-to-update-frontend.mdc`.

## Когда обновлять фронт (кратко)

**Да:** новые/переименованные/удалённые ключи; перенос earned↔manual; новые подписи; вёрстка.

**Нет:** только SQL/пороги/кэш/auth при тех же ключах JSON.

Push в GitHub ≠ деплой. Prod обновляется только `./scripts/deploy.sh`.

## Как деплоить

```bash
./scripts/deploy.sh app.js
# или
./scripts/deploy.sh all
```

## Правила

- Не коммить секреты и токены.
- При смене ключей метрик: сначала backend на prod, потом этот фронт.
- Источник подписей и групп на UI — `assets/app.js` (`METRICS`, `EARNED_KEYS`, `MANUAL_KEYS`).
- Подробности — `README.md`.
