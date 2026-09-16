# LaunchAgent: Dev Flow Daily

Ежедневно обновляет метрики разработки на https://dashboard.edpro.ru.

## Что делает

`scripts/run-dev-flow-daily.sh --if-stale`:

1. `node scripts/sync-dev-warehouse.mjs` (Asana → `warehouse/dev/`)
2. `./scripts/deploy.sh warehouse` (rsync на `root@46.149.70.15`)

Если `warehouse/dev/latest.json` уже за сегодня (MSK) — skip.

## Установка

```bash
mkdir -p ~/Library/LaunchAgents
cp ~/management-dashboard/scripts/launchd/com.edpro.dev-flow-daily.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.edpro.dev-flow-daily.plist 2>/dev/null || true
launchctl load -w ~/Library/LaunchAgents/com.edpro.dev-flow-daily.plist
launchctl print gui/$(id -u)/com.edpro.dev-flow-daily | head -40
```

Требования:

- `ASANA_PAT` в `~/.config/asana.env`
- SSH на `root@46.149.70.15` без пароля (ключ)
- Mac timezone ≈ Europe/Moscow (слот 06:15)
- Mac включён или проснётся — тогда сработает `RunAtLoad` + `--if-stale`

## Ручной прогон

```bash
~/management-dashboard/scripts/run-dev-flow-daily.sh
~/management-dashboard/scripts/run-dev-flow-daily.sh --if-stale
~/management-dashboard/scripts/run-dev-flow-daily.sh --skip-deploy
```

## Логи

- `~/management-dashboard/logs/dev-flow-daily-YYYY-MM-DD.log`
- `~/management-dashboard/logs/launchd-dev-flow-daily.{out,err}.log`

## Остановка

```bash
launchctl unload -w ~/Library/LaunchAgents/com.edpro.dev-flow-daily.plist
```
