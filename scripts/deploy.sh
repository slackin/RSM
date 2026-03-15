#!/usr/bin/env bash
# Deploy RSM service to remote router host.
#
# Usage:
#   ./scripts/deploy.sh [--no-build] [--host <user@host>] [--remote-root <path>]
#
# Defaults:
#   --host        root@router
#   --remote-root /opt/rsm
#
# The script:
#   1. Builds shared + service (skip with --no-build)
#   2. Creates a timestamped backup on the remote host
#   3. Syncs dist + package.json + deploy/ files via rsync
#   4. Restarts the OpenRC service (rc-service rsm-service restart)
#   5. Verifies the health endpoint responds 200

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
REMOTE_HOST="root@router"
REMOTE_ROOT="/opt/rsm"
DO_BUILD=1

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build)    DO_BUILD=0; shift ;;
    --host)        REMOTE_HOST="$2"; shift 2 ;;
    --remote-root) REMOTE_ROOT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_PATH="${REMOTE_ROOT}/backups/deploy-${TS}"

echo "──────────────────────────────────────────────"
echo "  RSM deploy  →  ${REMOTE_HOST}:${REMOTE_ROOT}"
echo "  Timestamp:  ${TS}"
echo "──────────────────────────────────────────────"

# ── 1. Build ──────────────────────────────────────────────────────────────────
if [[ $DO_BUILD -eq 1 ]]; then
  echo
  echo "▶ Building shared + service …"
  cd "$REPO_ROOT"
  npm run build -w @rsm/shared
  npm run build -w @rsm/service
  echo "  Build complete."
else
  echo
  echo "▶ Skipping build (--no-build)."
fi

# ── 2. Remote backup ─────────────────────────────────────────────────────────
echo
echo "▶ Backing up current remote artifacts to ${BACKUP_PATH} …"
ssh -o BatchMode=yes "${REMOTE_HOST}" "
  set -e
  mkdir -p '${BACKUP_PATH}/service' '${BACKUP_PATH}/shared' '${BACKUP_PATH}/deploy'
  cp -a '${REMOTE_ROOT}/apps/service/dist'        '${BACKUP_PATH}/service/'
  cp -a '${REMOTE_ROOT}/apps/service/package.json' '${BACKUP_PATH}/service/'
  cp -a '${REMOTE_ROOT}/apps/service/deploy/.'     '${BACKUP_PATH}/deploy/'
  cp -a '${REMOTE_ROOT}/packages/shared/dist'      '${BACKUP_PATH}/shared/'
  cp -a '${REMOTE_ROOT}/packages/shared/package.json' '${BACKUP_PATH}/shared/'
"
echo "  Backup done."

# ── 3. Sync ───────────────────────────────────────────────────────────────────
echo
echo "▶ Syncing build artifacts …"
rsync -az --delete \
  "${REPO_ROOT}/apps/service/dist/" \
  "${REMOTE_HOST}:${REMOTE_ROOT}/apps/service/dist/"

rsync -az \
  "${REPO_ROOT}/apps/service/package.json" \
  "${REMOTE_HOST}:${REMOTE_ROOT}/apps/service/package.json"

rsync -az \
  "${REPO_ROOT}/apps/service/deploy/" \
  "${REMOTE_HOST}:${REMOTE_ROOT}/apps/service/deploy/"

rsync -az --delete \
  "${REPO_ROOT}/packages/shared/dist/" \
  "${REMOTE_HOST}:${REMOTE_ROOT}/packages/shared/dist/"

rsync -az \
  "${REPO_ROOT}/packages/shared/package.json" \
  "${REMOTE_HOST}:${REMOTE_ROOT}/packages/shared/package.json"

echo "  Sync complete."

# Ensure 7za binary is executable (7zip-bin npm package may not preserve +x)
ssh -o BatchMode=yes "${REMOTE_HOST}" \
  "chmod +x '${REMOTE_ROOT}/node_modules/7zip-bin/linux/x64/7za' 2>/dev/null || true"

# ── 4. Restart service ────────────────────────────────────────────────────────
echo
echo "▶ Restarting rsm-service …"
ssh -o BatchMode=yes "${REMOTE_HOST}" \
  "rc-service rsm-service restart && sleep 2 && rc-service rsm-service status"

# ── 5. Health check ───────────────────────────────────────────────────────────
echo
echo "▶ Health check …"
HEALTH_URL="$(echo "${REMOTE_HOST}" | sed 's/.*@//')":8787

# Derive just the hostname/IP portion from the ssh target.
# Works for "root@router", "router", "192.168.1.1".
REMOTE_HOSTNAME="${REMOTE_HOST##*@}"
HEALTH_RESPONSE=$(curl -fsS "http://${REMOTE_HOSTNAME}:8787/health" 2>&1) || {
  echo "  ✗ Health check failed: ${HEALTH_RESPONSE}" >&2
  exit 1
}
echo "  ✓ ${HEALTH_RESPONSE}"

echo
echo "──────────────────────────────────────────────"
echo "  Deploy complete!  backup → ${BACKUP_PATH}"
echo "──────────────────────────────────────────────"
