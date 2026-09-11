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
Usage: $(basename "$0") [app.js|styles.css|index.html|management.html|marketing.html|marketing.js|drill.html|drill.js|development.html|development.js|sales.html|sales.js|snapshot.json|warehouse|sync-script|all]

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
    ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/warehouse/main/profit ${REMOTE_ROOT}/warehouse/owner/marketing ${REMOTE_ROOT}/warehouse/activity/summary ${REMOTE_ROOT}/warehouse/activity/drill ${REMOTE_ROOT}/warehouse/crm/leading ${REMOTE_ROOT}/warehouse/crm/base ${REMOTE_ROOT}/warehouse/crm/rfm ${REMOTE_ROOT}/warehouse/dev/card ${REMOTE_ROOT}/warehouse/dev/series ${REMOTE_ROOT}/warehouse/dev/wip ${REMOTE_ROOT}/warehouse/dev/tasks_closed ${REMOTE_ROOT}/scripts"
    deploy_file "warehouse/manifest.json" || true
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
    for rel in main/profit owner/marketing activity/summary crm/leading crm/base crm/rfm; do
        if [[ -d "${LOCAL_ROOT}/warehouse/${rel}" ]]; then
            echo "→ warehouse/${rel}/ (rsync)"
            rsync -az --delete "${LOCAL_ROOT}/warehouse/${rel}/" "${SERVER}:${REMOTE_ROOT}/warehouse/${rel}/"
        fi
    done
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
    snapshot.json)
        deploy_file "snapshot.json"
        ;;
    warehouse)
        deploy_warehouse
        ;;
    sync-script)
        deploy_file "scripts/sync-warehouse.mjs"
        deploy_file "scripts/sync-dev-warehouse.mjs" || true
        deploy_file "scripts/ingest_dev_warehouse.py" || true
        ;;
    all)
        deploy_file "index.html"
        deploy_file "management.html"
        deploy_file "marketing.html"
        deploy_file "drill.html"
        deploy_file "development.html" || true
        deploy_file "sales.html" || true
        deploy_file "assets/app.js"
        deploy_file "assets/marketing.js"
        deploy_file "assets/drill.js"
        deploy_file "assets/development.js" || true
        deploy_file "assets/sales.js" || true
        deploy_file "assets/styles.css"
        deploy_file "scripts/sync-warehouse.mjs"
        deploy_file "scripts/sync-dev-warehouse.mjs" || true
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
