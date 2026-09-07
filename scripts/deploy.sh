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
Usage: $(basename "$0") [app.js|styles.css|index.html|management.html|drill.html|drill.js|snapshot.json|warehouse|sync-script|all]

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
    ssh "${SERVER}" "mkdir -p ${REMOTE_ROOT}/warehouse/periods ${REMOTE_ROOT}/scripts"
    deploy_file "warehouse/manifest.json" || true
    if [[ -f "${LOCAL_ROOT}/warehouse/filters.json" ]]; then
        deploy_file "warehouse/filters.json" || true
    fi
    if [[ -f "${LOCAL_ROOT}/warehouse/latest.json" ]]; then
        deploy_file "warehouse/latest.json" || true
    fi
    if [[ -d "${LOCAL_ROOT}/warehouse/periods" ]]; then
        echo "→ warehouse/periods/ (rsync)"
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
    drill.html)
        deploy_file "drill.html"
        ;;
    drill.js)
        deploy_file "assets/drill.js"
        ;;
    snapshot.json)
        deploy_file "snapshot.json"
        ;;
    warehouse)
        deploy_warehouse
        ;;
    sync-script)
        deploy_file "scripts/sync-warehouse.mjs"
        ;;
    all)
        deploy_file "index.html"
        deploy_file "management.html"
        deploy_file "drill.html"
        deploy_file "assets/app.js"
        deploy_file "assets/drill.js"
        deploy_file "assets/styles.css"
        deploy_file "scripts/sync-warehouse.mjs"
        deploy_warehouse
        ;;
    *)
        echo "Unknown target: ${TARGET}" >&2
        usage >&2
        exit 1
        ;;
esac

echo "Done. Dashboard: http://46.149.70.15:8080/"
