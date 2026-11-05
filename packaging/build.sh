#!/bin/bash
# Package Kiki.app: bundled Node + compiled Kiki + production dependencies (including the pinned pi 1.4.0) + web UI.
# Only building on a Mac gives you a native window (GitHub Actions uses macOS machines); building on Linux works too, but the UI opens in a browser.
# Usage: packaging/build.sh [arm64|x64]      Output: out/Kiki-mac-<arch>.zip, (on Mac) out/Kiki-mac-<arch>.dmg and out/SHA256SUMS
set -euo pipefail
ARCH="${1:-arm64}"
NODE_VERSION="${NODE_VERSION:-22.23.4}"   # pi requires Node >= 22.19
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION=$(node -p 'require("./package.json").version')
OUT="$ROOT/out"
APP="$OUT/build-$ARCH/Kiki.app"
RES="$APP/Contents/Resources"
echo "Packaging Kiki ${VERSION} (mac-${ARCH}, Node ${NODE_VERSION})"

rm -rf "$OUT/build-$ARCH"
mkdir -p "$APP/Contents/MacOS" "$RES/app" "$RES/node/bin"

# 1. Compile TypeScript
rm -rf dist
npx tsc -p tsconfig.build.json
cp -R dist public data-template bao-skills package.json package-lock.json "$RES/app/"

# 2. Install production dependencies only, picking optional dependencies for the macOS platform; skip install scripts (none of these dependencies need them)
(cd "$RES/app" && npm ci --omit=dev --ignore-scripts --os=darwin --cpu="$ARCH" --no-audit --no-fund --loglevel=error)
rm -f "$RES/app/package-lock.json"

# 3. Official Node (signed with the Node project's signature); verify, then take only the node binary itself
CACHE="$OUT/cache"; mkdir -p "$CACHE"
TGZ="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
[ -f "$CACHE/$TGZ" ] || curl -fsSL -o "$CACHE/$TGZ" "https://nodejs.org/dist/v$NODE_VERSION/$TGZ"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $TGZ\$" > "$CACHE/$TGZ.sha256"
(cd "$CACHE" && { command -v sha256sum >/dev/null && sha256sum -c "$TGZ.sha256" || shasum -a 256 -c "$TGZ.sha256"; } >/dev/null)
tar -xzf "$CACHE/$TGZ" -C "$RES/node" --strip-components=1 "node-v$NODE_VERSION-darwin-$ARCH/bin/node" "node-v$NODE_VERSION-darwin-$ARCH/LICENSE"

# 3b. Wrap Node in a small "Kiki Agent" app (Contents/Helpers/KikiAgent.app): that's what the system privacy settings recognize,
#     it shows up as "Kiki Agent", its signing identity is fixed, and permissions survive auto-updates. Leave a link at the old node/bin/node pointing to it.
AGENT="$APP/Contents/Helpers/KikiAgent.app"
mkdir -p "$AGENT/Contents/MacOS" "$AGENT/Contents/Resources"
mv "$RES/node/bin/node" "$AGENT/Contents/MacOS/kiki-node"
ln -s ../../../Helpers/KikiAgent.app/Contents/MacOS/kiki-node "$RES/node/bin/node"
sed "s/__VERSION__/$VERSION/g" packaging/agent-Info.plist > "$AGENT/Contents/Info.plist"
cp packaging/AppIcon.icns "$AGENT/Contents/Resources/"

# 4. App shell
sed "s/__VERSION__/$VERSION/g" packaging/Info.plist > "$APP/Contents/Info.plist"
cp packaging/kiki-server "$APP/Contents/MacOS/"
cp packaging/kiki-setup packaging/swap.sh packaging/client-update.sh packaging/AppIcon.icns "$RES/"
# Native window: compile with swiftc on a Mac; other systems can't compile it, so fall back to the "open in browser" script
if command -v swiftc >/dev/null && [ "$(uname)" = Darwin ]; then
  T=$([ "$ARCH" = x64 ] && echo x86_64 || echo arm64)
  swiftc -O -target "$T-apple-macos12" -framework Cocoa -framework WebKit \
    -o "$APP/Contents/MacOS/Kiki" packaging/mac/main.swift
else
  echo "(this machine can't compile the native window, so Kiki.app will open the UI in a browser)"
  cp packaging/mac/launcher.sh "$APP/Contents/MacOS/Kiki"
fi
chmod +x "$APP/Contents/MacOS/"* "$RES/kiki-setup" "$RES/swap.sh" "$RES/client-update.sh" "$AGENT/Contents/MacOS/kiki-node"

# Signing: if a developer certificate is configured (KIKI_SIGN_IDENTITY), sign properly and submit to Apple for notarization; otherwise sign locally as before. See docs/signing.md
packaging/sign.sh app "$APP"

# 5. Build a .dmg on a Mac: for first-time installers, open it and drag Kiki into Applications.
#    Auto-updates still download the zip (smaller, and unzipping doesn't require mounting).
if command -v hdiutil >/dev/null; then
  DMG="Kiki-mac-$ARCH.dmg"
  STAGE="$OUT/dmg-$ARCH"
  rm -rf "$STAGE" "$OUT/$DMG"
  mkdir -p "$STAGE"
  ditto "$APP" "$STAGE/Kiki.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "Kiki ${VERSION}" -srcfolder "$STAGE" -ov -format UDZO "$OUT/$DMG"
  rm -rf "$STAGE"
  packaging/sign.sh dmg "$OUT/$DMG" "$APP"   # sign + notarize, and staple the ticket into the app too
  (cd "$OUT" && shasum -a 256 "$DMG") > "$OUT/$DMG.sha256"
  echo "Done: $OUT/${DMG} ($(du -h "$OUT/$DMG" | cut -f1))"
fi
# 6. Zip (after notarization and stapling; preserve symlinks and executable permissions) + checksum
ZIP="Kiki-mac-$ARCH.zip"
rm -f "$OUT/$ZIP"
if command -v ditto >/dev/null; then
  ditto -c -k --keepParent "$APP" "$OUT/$ZIP"
else
  (cd "$OUT/build-$ARCH" && zip -qry "$OUT/$ZIP" Kiki.app)
fi
(cd "$OUT" && { command -v sha256sum >/dev/null && sha256sum "$ZIP" || shasum -a 256 "$ZIP"; }) > "$OUT/$ZIP.sha256"

cat "$OUT"/Kiki-mac-*.sha256 > "$OUT/SHA256SUMS"
echo "Done: $OUT/${ZIP} ($(du -h "$OUT/$ZIP" | cut -f1))"
