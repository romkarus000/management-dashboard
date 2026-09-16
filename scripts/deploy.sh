#!/usr/bin/env bash
# Деплой статики management-dashboard на prod-сервер.
# См. README.md
set -euo pipefail

SERVER="${MGMT_DASHBOARD_SERVER:-root@46.149.70.15}"
REMOTE_ROOT="${MGMT_DASHBOARD_PATH:-/var/www/management-report}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_ROOT="${REPO_ROOT}"

usage() {
    cat <<EOF
Usage: $(basename "$0") [app.js|styles.css|index.html|management.html|marketing.html|marketing.js|drill.html|drill.js|development.html|development.js|sales.html|sales.js|callcenter.html|callcenter.js|bots.html|bots.js|snapshot.json|warehouse|sync-script|all]

Deploy management dashboard static files to ${SERVER}:${REMOTE_ROOT}

Environment overrides:
  MGMT_DASHBOARD_SERVER   SSH target (default: root@46.149.70.15)
  MGMT_DASHBOARD_PATH     Remote document root (default: /var/www/management-report)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

TARGET="${1:-app.js}"

if [[ ! -f "${LOCAL_ROOT}/index.html" ]]; then
    echo "Local dashboard not found in: ${LOCAL_ROOT}" >&2
    exit 1
fi

deploy_file() {
    local rel="$1"
    local local_path="${LOCAL_ROOT}/${rel}"
    if [[ ! -f "${local_path}" ]]; then
        echo "Skip missing: ${local_path}" >&2
        return 1
    fi
    echo "→ ${rel}"
    # shellcheck disable=SC2029
    ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/$(dirname "${rel}")"
    scp "${local_path}" "${SERVER}:${REMOTE_ROOT}/${rel}"
}

deploy_warehouse() {
    ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/warehouse/main/profit ${REMOTE_ROOT}/warehouse/owner/marketing ${REMOTE_ROOT}/warehouse/activity/summary ${REMOTE_ROOT}/warehouse/activity/drill ${REMOTE_ROOT}/warehouse/crm/leading ${REMOTE_ROOT}/warehouse/crm/base ${REMOTE_ROOT}/warehouse/crm/rfm ${REMOTE_ROOT}/warehouse/sales/kpis ${REMOTE_ROOT}/warehouse/cc/kpis ${REMOTE_ROOT}/warehouse/dev/card ${REMOTE_ROOT}/warehouse/dev/series ${REMOTE_ROOT}/warehouse/dev/wip ${REMOTE_ROOT}/warehouse/dev/tasks_closed ${REMOTE_ROOT}/warehouse/bots/funnel ${REMOTE_ROOT}/scripts"
    # Сохраняем prod-only datasets (bots.* и т.п.), которых может не быть в локальном manifest
    ssh "${SERVER}" "python3 - <<'PY'
from pathlib import Path
import json
p = Path('${REMOTE_ROOT}/warehouse/manifest.json')
if p.exists():
    m = json.loads(p.read_text(encoding='utf-8'))
    keep = {k: v for k, v in (m.get('datasets') or {}).items() if str(k).startswith('bots.')}
    Path('/tmp/mgmt-manifest-bots-keep.json').write_text(json.dumps(keep), encoding='utf-8')
else:
    Path('/tmp/mgmt-manifest-bots-keep.json').write_text('{}', encoding='utf-8')
print('kept', list(json.loads(Path('/tmp/mgmt-manifest-bots-keep.json').read_text()).keys()))
PY"
    deploy_file "warehouse/manifest.json" || true
    ssh "${SERVER}" "python3 - <<'PY'
from pathlib import Path
import json
from datetime import datetime, timezone
root = Path('${REMOTE_ROOT}/warehouse')
manifest_path = root / 'manifest.json'
keep = json.loads(Path('/tmp/mgmt-manifest-bots-keep.json').read_text(encoding='utf-8'))
if manifest_path.exists():
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
else:
    manifest = {'version': '2.0', 'schemaVersion': '2.0', 'warehouseVersion': '2.0', 'datasets': {}}
datasets = manifest.setdefault('datasets', {})
for k, v in keep.items():
    datasets[k] = v
# если keep пуст, но файлы bots/funnel есть — восстановим
funnel_dir = root / 'bots' / 'funnel'
if 'bots.funnel' not in datasets and funnel_dir.is_dir():
    periods = {}
    for f in sorted(funnel_dir.glob('*.json')):
        period = f.stem
        try:
            env = json.loads(f.read_text(encoding='utf-8'))
            periods[period] = {
                'fetchedAt': env.get('fetchedAt'),
                'checksum': env.get('checksum'),
                'file': f'bots/funnel/{period}.json',
                'source': 'n8n-bots-funnel',
            }
        except Exception:
            periods[period] = {'file': f'bots/funnel/{period}.json'}
    if periods:
        keys = sorted(periods)
        datasets['bots.funnel'] = {
            'path': 'bots/funnel',
            'coverage': {'from': keys[0], 'to': keys[-1], 'count': len(keys)},
            'periods': periods,
        }
manifest['generatedAt'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('manifest bots.funnel:', 'bots.funnel' in datasets)
PY"
    if [[ -f "${LOCAL_ROOT}/warehouse/filters.json" ]]; then
        deploy_file "warehouse/filters.json" || true
    fi
    if [[ -f "${LOCAL_ROOT}/docs/warehouse-v2-contract.md" ]]; then
        ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/docs"
        deploy_file "docs/warehouse-v2-contract.md" || true
    fi
    if [[ -f "${LOCAL_ROOT}/docs/dev-flow-contract.md" ]]; then
        ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/docs"
        deploy_file "docs/dev-flow-contract.md" || true
    fi
    for rel in main/profit owner/marketing activity/summary crm/leading crm/base crm/rfm sales/kpis cc/kpis; do
        if [[ -d "${LOCAL_ROOT}/warehouse/${rel}" ]]; then
            echo "→ warehouse/${rel}/ (rsync)"
            rsync -az --delete "${LOCAL_ROOT}/warehouse/${rel}/" "${SERVER}:${REMOTE_ROOT}/warehouse/${rel}/"
        fi
    done
    if [[ -f "${LOCAL_ROOT}/docs/sales-warehouse-contract.md" ]]; then
        ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/docs"
        deploy_file "docs/sales-warehouse-contract.md" || true
    fi
    if [[ -f "${LOCAL_ROOT}/docs/cc-warehouse-contract.md" ]]; then
        ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/docs"
        deploy_file "docs/cc-warehouse-contract.md" || true
    fi
    if [[ -f "${LOCAL_ROOT}/docs/bots-warehouse-contract.md" ]]; then
        ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/docs"
        deploy_file "docs/bots-warehouse-contract.md" || true
    fi
    if [[ -d "${LOCAL_ROOT}/warehouse/bots" ]]; then
        echo "→ warehouse/bots/ (rsync, no --delete)"
        rsync -az "${LOCAL_ROOT}/warehouse/bots/" "${SERVER}:${REMOTE_ROOT}/warehouse/bots/"
    fi
    if [[ -d "${LOCAL_ROOT}/warehouse/activity/drill" ]]; then
        echo "→ warehouse/activity/drill/ (rsync)"
        rsync -az --delete "${LOCAL_ROOT}/warehouse/activity/drill/" "${SERVER}:${REMOTE_ROOT}/warehouse/activity/drill/"
    fi
    if [[ -d "${LOCAL_ROOT}/warehouse/dev" ]]; then
        echo "→ warehouse/dev/ (rsync)"
        rsync -az --delete "${LOCAL_ROOT}/warehouse/dev/" "${SERVER}:${REMOTE_ROOT}/warehouse/dev/"
    fi
    # legacy v1 — только если явно попросили (по умолчанию не деплоим)
    if [[ "${MGMT_DEPLOY_LEGACY_PERIODS:-0}" == "1" && -d "${LOCAL_ROOT}/warehouse/periods" ]]; then
        echo "→ warehouse/periods/ legacy (rsync)"
        rsync -az --delete "${LOCAL_ROOT}/warehouse/periods/" "${SERVER}:${REMOTE_ROOT}/warehouse/periods/"
    fi
}

case "${TARGET}" in
    app.js)
        deploy_file "assets/app.js"
        ;;
    styles.css)
        deploy_file "assets/styles.css"
        ;;
    index.html)
        deploy_file "index.html"
        ;;
    management.html)
        deploy_file "management.html"
        ;;
    marketing.html)
        deploy_file "marketing.html"
        ;;
    marketing.js)
        deploy_file "assets/marketing.js"
        ;;
    drill.html)
        deploy_file "drill.html"
        ;;
    drill.js)
        deploy_file "assets/drill.js"
        ;;
    development.html)
        deploy_file "development.html"
        ;;
    development.js)
        deploy_file "assets/development.js"
        ;;
    sales.html)
        deploy_file "sales.html"
        ;;
    sales.js)
        deploy_file "assets/sales.js"
        ;;
    bots.html)
        deploy_file "bots.html"
        ;;
    bots.js)
        deploy_file "assets/bots.js"
        ;;
    callcenter.html)
        deploy_file "callcenter.html"
        ;;
    callcenter.js)
        deploy_file "assets/callcenter.js"
        ;;
    snapshot.json)
        deploy_file "snapshot.json"
        ;;
    warehouse)
        deploy_warehouse
        ;;
    sync-script)
        deploy_file "scripts/sync-warehouse.mjs"
        deploy_file "scripts/sync-dev-warehouse.mjs" || true
        deploy_file "scripts/sync-sales-warehouse.mjs" || true
        deploy_file "scripts/sync-cc-warehouse.mjs" || true
        deploy_file "scripts/ingest_dev_warehouse.py" || true
        ;;
    all)
        deploy_file "index.html"
        deploy_file "management.html"
        deploy_file "marketing.html"
        deploy_file "drill.html"
        deploy_file "development.html" || true
        deploy_file "sales.html" || true
        deploy_file "callcenter.html" || true
        deploy_file "bots.html" || true
        deploy_file "assets/app.js"
        deploy_file "assets/marketing.js"
        deploy_file "assets/drill.js"
        deploy_file "assets/development.js" || true
        deploy_file "assets/sales.js" || true
        deploy_file "assets/callcenter.js" || true
        deploy_file "assets/bots.js" || true
        deploy_file "assets/styles.css"
        deploy_file "scripts/sync-warehouse.mjs"
        deploy_file "scripts/sync-dev-warehouse.mjs" || true
        deploy_file "scripts/sync-sales-warehouse.mjs" || true
        deploy_file "scripts/sync-cc-warehouse.mjs" || true
        deploy_file "scripts/ingest_dev_warehouse.py" || true
        deploy_warehouse
        ;;
    *)
        echo "Unknown target: ${TARGET}" >&2
        usage >&2
        exit 1
        ;;
esac

echo "Done. Dashboard: http://46.149.70.15:8080/"
