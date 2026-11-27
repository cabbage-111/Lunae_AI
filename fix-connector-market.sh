#!/usr/bin/env bash
#
# fix-connector-market.sh
#
# Purpose:
#   Seed the WorkBuddy connector marketplace directory when the client has
#   skipped its own bootstrap step.
#
# Background:
#   In "market API" mode, ConnectorCatalogChains.current() resolves to
#   MarketCatalogChain. Its syncOnInit() logs
#       "market api enabled, skip marketplace zip download on init"
#   and never downloads the catalog. The follow-up runMarketInspection('init')
#   cannot compensate: inspectMarketplace() begins with
#       if (getInstalled().size === 0) return;
#   so on a zero-install machine no catalog is ever laid down.
#
#   Meanwhile UI catalog reads go through
#       readLocalManifest() -> marketplaceStore.snapshot().manifest
#   which only ever reflects on-disk marketplace directories. Empty dir =>
#   empty catalog => PluginRecommendationError CONNECTOR_CATALOG_UNAVAILABLE
#   => the "connector unavailable" state in the UI.
#
#   This script performs exactly the three steps downloadAndReplace() would
#   have performed: download -> extract -> atomically place into the first
#   marketplaceDirCandidates() entry.
#
# What it changes:
#   Creates  ~/.workbuddy/connectors-marketplace-sources/<marketplace-name>/
#   It never deletes or rewrites existing user data. Idempotent.
#
# Usage:
#   bash fix-connector-market.sh              # install if missing
#   bash fix-connector-market.sh --force      # re-download and replace
#   bash fix-connector-market.sh --check      # report only, no changes
#
set -euo pipefail

MARKET_NAME="workbuddy-connector-plugins-official"
ZIP_URL="https://static.workbuddy.cn/connector-agent-plugins/connector-plugins.zip"
CONFIG_DIR="${HOME}/.workbuddy"
SOURCES_DIR="${CONFIG_DIR}/connectors-marketplace-sources"
TARGET_DIR="${SOURCES_DIR}/${MARKET_NAME}"
MANIFEST_REL=".codebuddy-plugin/marketplace.json"
STAMP="${CONFIG_DIR}/connectors-marketplace.meta.json"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --force) MODE="force" ;;
    --check) MODE="check" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

have_manifest() {
  [ -f "${TARGET_DIR}/${MANIFEST_REL}" ]
}

count_packages() {
  [ -d "${TARGET_DIR}/connectors" ] && ls "${TARGET_DIR}/connectors" | wc -l | tr -d ' ' || echo 0
}

report() {
  if have_manifest; then
    log "catalog present: ${TARGET_DIR}"
    log "packages: $(count_packages)  size: $(du -sh "${TARGET_DIR}" | cut -f1)"
  else
    log "catalog MISSING: ${TARGET_DIR}"
    log "this is the state that produces the empty connector list"
  fi
}

if [ "$MODE" = "check" ]; then
  report
  exit 0
fi

if have_manifest && [ "$MODE" != "force" ]; then
  log "already seeded, nothing to do (use --force to refresh)"
  report
  exit 0
fi

command -v curl >/dev/null || die "curl not found"
command -v unzip >/dev/null || die "unzip not found"

mkdir -p "$SOURCES_DIR"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/connector-market-XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

log "downloading ${ZIP_URL}"
HTTP_CODE="$(curl -sSL --max-time 600 -o "${WORK_DIR}/catalog.zip" \
  -w '%{http_code}' "$ZIP_URL" || echo 000)"
[ "$HTTP_CODE" = "200" ] || die "download failed (HTTP ${HTTP_CODE})"

BYTES="$(wc -c < "${WORK_DIR}/catalog.zip" | tr -d ' ')"
log "downloaded ${BYTES} bytes"

log "extracting"
unzip -q "${WORK_DIR}/catalog.zip" -d "${WORK_DIR}/stage"
[ -f "${WORK_DIR}/stage/${MANIFEST_REL}" ] || die "manifest missing from archive: ${MANIFEST_REL}"

NAMES="$(python3 - "${WORK_DIR}/stage/${MANIFEST_REL}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(d.get("name", ""), len(d.get("plugins") or []))
PY
)"
ARCHIVE_NAME="${NAMES%% *}"
PLUGIN_COUNT="${NAMES##* }"

if [ -n "$ARCHIVE_NAME" ] && [ "$ARCHIVE_NAME" != "$MARKET_NAME" ]; then
  log "warning: archive declares name='${ARCHIVE_NAME}', expected '${MARKET_NAME}'"
fi
log "manifest ok: name=${ARCHIVE_NAME} plugins=${PLUGIN_COUNT}"

if [ -e "$TARGET_DIR" ]; then
  BACKUP="${SOURCES_DIR}/.replaced-${MARKET_NAME}-$(date +%s)"
  log "existing catalog moved aside: ${BACKUP}"
  mv "$TARGET_DIR" "$BACKUP"
fi

mv "${WORK_DIR}/stage" "$TARGET_DIR"

# Record the source identity so the client can compare it against its own
# resolved source later, instead of treating the directory as foreign.
python3 - "${STAMP}" "$MARKET_NAME" "$ZIP_URL" "${WORK_DIR}/catalog.zip" <<'PY' || true
import hashlib, json, os, sys
path, name, url, zpath = sys.argv[1:5]
h = hashlib.sha256()
with open(zpath, "rb") as fh:
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        h.update(chunk)
data = {"sourceKey": f"{name}\n{url}", "sha256": h.hexdigest(), "marketplaceName": name}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
os.replace(tmp, path)
PY

log "seeded ${TARGET_DIR}"
report
log "now fully quit the client (Cmd+Q) and relaunch so scan() reruns"
