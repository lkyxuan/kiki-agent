#!/bin/bash
# Install (or reinstall) Kiki: download the latest Kiki.app into "Applications", start the background service, open the web page.
# Existing data (~/Kiki) is left untouched.
#
#   One-line install:
#     curl -fsSL https://raw.githubusercontent.com/lkyxuan/kiki-agent/main/packaging/install.sh | bash
#   Using your own build:
#     packaging/install.sh out/Kiki-mac-arm64.zip
set -euo pipefail
REPO="${KIKI_REPO:-lkyxuan/kiki}"
LABEL=com.lkyxuan.kiki.en
ARCH=$(uname -m); [ "$ARCH" = x86_64 ] && ARCH=x64
ZIPNAME="Kiki-mac-$ARCH.zip"
DEST=/Applications; [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

if [ $# -ge 1 ]; then
  ZIP="$1"
else
  echo "Downloading the latest Kiki…"
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
    gh release download --repo "$REPO" --pattern "$ZIPNAME" --pattern SHA256SUMS --dir "$TMP"
  else
    curl -fL --progress-bar -o "$TMP/$ZIPNAME" "https://github.com/$REPO/releases/latest/download/$ZIPNAME"
    curl -fsSL -o "$TMP/SHA256SUMS" "https://github.com/$REPO/releases/latest/download/SHA256SUMS"
  fi
  (cd "$TMP" && grep " $ZIPNAME\$" SHA256SUMS | shasum -a 256 -c - >/dev/null) || { echo "Checksum mismatch, stopping installation"; exit 1; }
  ZIP="$TMP/$ZIPNAME"
fi

# Stop the old service first, then swap in the new app
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -rf "$DEST/Kiki.app"
ditto -x -k "$ZIP" "$DEST"
xattr -dr com.apple.quarantine "$DEST/Kiki.app" 2>/dev/null || true

echo "Installed to $DEST/Kiki.app, starting…"
open "$DEST/Kiki.app"
echo "Done. From now on it will launch at login and update itself. Logs: ~/Library/Logs/Kiki/"
