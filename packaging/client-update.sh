#!/bin/bash
# Client self-update: for Kiki instances that are "UI only, connected to a remote", or when the local background service won't start.
# Called by the Kiki window app: client-update.sh <App path> <window process PID> <local|remote>
# Download the latest version → verify the checksum → wait for the window to exit → swap the App (the old one stays as .Kiki-previous.app) → reopen.
# In local mode, the old background service is stopped first; the new App re-registers itself when it opens.
set -euo pipefail
APP="$1"; PID="$2"; MODE="${3:-remote}"
REPO="${KIKI_REPO:-lkyxuan/kiki}"
LABEL=com.lkyxuan.kiki.en
ARCH=$(uname -m); [ "$ARCH" = x86_64 ] && ARCH=x64
ZIPNAME="Kiki-mac-$ARCH.zip"
DIR=$(dirname "$APP")
LOGDIR="$HOME/Library/Logs/Kiki"; mkdir -p "$LOGDIR"
exec >>"$LOGDIR/client-update.log" 2>&1
echo "[$(date '+%F %T')] Client update started ($MODE)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP" "$DIR/.Kiki-client-update"' EXIT

fail() { echo "Failed: $1"; open "$APP" 2>/dev/null || true; exit 1; }

curl -fsSL -m 600 -o "$TMP/$ZIPNAME" "https://github.com/$REPO/releases/latest/download/$ZIPNAME" || fail "download failed"
curl -fsSL -m 60 -o "$TMP/SHA256SUMS" "https://github.com/$REPO/releases/latest/download/SHA256SUMS" || fail "failed to download checksums"
(cd "$TMP" && grep " $ZIPNAME\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || fail "checksum mismatch"

STAGE="$DIR/.Kiki-client-update"
rm -rf "$STAGE"; mkdir -p "$STAGE"
ditto -x -k "$TMP/$ZIPNAME" "$STAGE" || fail "failed to unzip"
[ -d "$STAGE/Kiki.app" ] || fail "the archive does not contain Kiki.app"
xattr -dr com.apple.quarantine "$STAGE/Kiki.app" 2>/dev/null || true

# Wait for the window app to exit (up to 30 seconds)
for _ in $(seq 1 60); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done

if [ "$MODE" = local ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
rm -rf "$DIR/.Kiki-previous.app"
mv "$APP" "$DIR/.Kiki-previous.app" || fail "could not move the old App aside"
if ! mv "$STAGE/Kiki.app" "$APP"; then
  mv "$DIR/.Kiki-previous.app" "$APP"
  fail "could not install the new App; reverted to the old version"
fi
echo "[$(date '+%F %T')] Swapped in $(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo new version)"
open "$APP"
