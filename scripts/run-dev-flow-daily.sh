#!/usr/bin/env bash
# Ежедневный контур Dev Flow: Asana → warehouse/dev → deploy на dashboard.edpro.ru
# См. docs/dev-flow-contract.md · vault N020 / AG005
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}"

LOG_DIR="${REPO_ROOT}/logs"
mkdir -p "${LOG_DIR}"
STAMP="$(TZ=Europe/Moscow date +%Y-%m-%d)"
LOG_FILE="${LOG_DIR}/dev-flow-daily-${STAMP}.log"
LATEST_JSON="${REPO_ROOT}/warehouse/dev/latest.json"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="/usr/local/bin/node"
fi
if [[ ! -x "${NODE_BIN}" ]]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi

usage() {
  cat <<EOF
Usage: $(basename "$0") [--if-stale] [--skip-deploy] [--skip-stories] [--lookback-days N]

  --if-stale       пропуск, если warehouse/dev/latest.json уже за сегодня (MSK)
  --skip-deploy    только sync, без ./scripts/deploy.sh warehouse
  --skip-stories   быстрее (без cycle / time_to_commit из stories)
  --lookback-days  окно закрытых задач (default 180)
EOF
}

IF_STALE=0
SKIP_DEPLOY=0
SYNC_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --if-stale)
      IF_STALE=1
      shift
      ;;
    --skip-deploy)
      SKIP_DEPLOY=1
      shift
      ;;
    --skip-stories)
      SYNC_ARGS+=(--skip-stories)
      shift
      ;;
    --lookback-days)
      SYNC_ARGS+=(--lookback-days="$2")
      shift 2
      ;;
    --lookback-days=*)
      SYNC_ARGS+=("$1")
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log() {
  local line="[$(TZ=Europe/Moscow date +%Y-%m-%dT%H:%M:%S%z)] $*"
  echo "${line}" | tee -a "${LOG_FILE}"
}

if [[ ! -x "${NODE_BIN}" ]]; then
  log "ERROR: node not found"
  exit 1
fi

if [[ "${IF_STALE}" -eq 1 && -f "${LATEST_JSON}" ]]; then
  PERIOD="$(python3 -c "import json; print(json.load(open('${LATEST_JSON}')).get('period',''))" 2>/dev/null || true)"
  if [[ "${PERIOD}" == "${STAMP}" ]]; then
    log "SKIP: already synced for ${STAMP} (period=${PERIOD})"
    exit 0
  fi
fi

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# ASANA_PAT подхватит sync из ~/.config/asana.env
log "START sync-dev-warehouse ${SYNC_ARGS[*]:-}"
set +e
"${NODE_BIN}" "${REPO_ROOT}/scripts/sync-dev-warehouse.mjs" "${SYNC_ARGS[@]}" >>"${LOG_FILE}" 2>&1
SYNC_RC=$?
set -e
if [[ "${SYNC_RC}" -ne 0 ]]; then
  log "ERROR: sync failed rc=${SYNC_RC} — deploy skipped"
  exit "${SYNC_RC}"
fi
log "OK sync"

if [[ "${SKIP_DEPLOY}" -eq 1 ]]; then
  log "SKIP deploy (--skip-deploy)"
  exit 0
fi

log "START deploy.sh warehouse"
set +e
"${REPO_ROOT}/scripts/deploy.sh" warehouse >>"${LOG_FILE}" 2>&1
DEPLOY_RC=$?
set -e
if [[ "${DEPLOY_RC}" -ne 0 ]]; then
  log "ERROR: deploy failed rc=${DEPLOY_RC}"
  exit "${DEPLOY_RC}"
fi
log "OK deploy → https://dashboard.edpro.ru/warehouse/dev/latest.json"
exit 0
