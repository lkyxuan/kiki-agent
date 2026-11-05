#!/bin/bash
# Last step of the auto-update, run by the "old version" (copied to a temp directory first, so it doesn't depend on the App being replaced):
#   Swap in the new App → restart the service → wait for the new version to report the correct version number → if it doesn't come up within 45 seconds, swap the old one back.
# Usage: swap.sh <App path> <new App path> <old version> <new version> <port> <log directory>
set -u
APP="$1"; NEW="$2"; FROM="$3"; TO="$4"; PORT="$5"; LOGDIR="$6"
LABEL=com.lkyxuan.kiki.en
DIR="$(dirname "$APP")"
PREV="$DIR/.Kiki-previous.app"   # Keep a copy of the previous version, so manual rollback works too
RECEIPT="$LOGDIR/last-update.json"

log() { echo "[$(date '+%F %T')] $*"; }
receipt() {
  printf '{"from":"%s","to":"%s","result":"%s","at":"%s"}\n' "$FROM" "$TO" "$1" "$(date -u +%FT%TZ)" > "$RECEIPT"
  log "receipt: $1"
}
restart() { launchctl kickstart -k "gui/$(id -u)/$LABEL"; }
healthy() {
  for _ in $(seq 1 45); do
    v=$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    [ "$v" = "$1" ] && return 0
    sleep 1
  done
  return 1
}

log "Starting update $FROM → $TO"
sleep 1
rm -rf "$PREV"
if ! mv "$APP" "$PREV"; then log "Couldn't move the old version"; receipt failed; exit 1; fi
if ! mv "$NEW" "$APP"; then mv "$PREV" "$APP"; log "Couldn't put the new version in place"; receipt failed; exit 1; fi
rmdir "$(dirname "$NEW")" 2>/dev/null
touch "$APP"   # Make Finder and the Dock refresh the icon
restart
if healthy "$TO"; then receipt ok; exit 0; fi

log "New version $TO didn't come up, rolling back to $FROM"
rm -rf "$DIR/.Kiki-failed.app"
mv "$APP" "$DIR/.Kiki-failed.app"
mv "$PREV" "$APP"
restart
if healthy "$FROM"; then receipt rolled_back; else receipt rollback_failed; fi
