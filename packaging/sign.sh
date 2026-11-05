#!/bin/bash
# Signing and notarization, called by build.sh. Without a developer certificate configured, only local signing is done (same as before).
#   sign.sh app <Kiki.app>             sign the whole app
#   sign.sh dmg <Kiki.dmg> <Kiki.app>  sign the .dmg, hand the whole .dmg to Apple for notarization once (the app inside is notarized along with it),
#                                      once it passes, staple the ticket into the .dmg and the app (the zip used for auto-update is built from the app afterwards)
#
# Environment variables (set by the release workflow from GitHub Secrets, see docs/signing.md):
#   KIKI_SIGN_IDENTITY   "Developer ID Application: Name (Team ID)"; set to "-" for CI self-test: local signing but with hardened runtime enabled
#   Notarization, pick one: NOTARY_KEY_PATH + NOTARY_KEY_ID + NOTARY_ISSUER (App Store Connect API key, recommended)
#              or APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID (app-specific password)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ID="${KIKI_SIGN_IDENTITY:-}"
command -v codesign >/dev/null || exit 0   # not on a Mac: do nothing

# Hardened runtime + timestamp are hard requirements for notarization; the local signing used for CI self-test can't get a timestamp
if [ "$ID" = "-" ]; then TS=--timestamp=none; else TS=--timestamp; fi
cs() { codesign --force $TS --options runtime --sign "$ID" "$@"; }

auth() {
  if [ -n "${NOTARY_KEY_PATH:-}" ]; then
    AUTH=(--key "$NOTARY_KEY_PATH" --key-id "${NOTARY_KEY_ID:?missing NOTARY_KEY_ID}" --issuer "${NOTARY_ISSUER:?missing NOTARY_ISSUER}")
  elif [ -n "${APPLE_ID:-}" ]; then
    AUTH=(--apple-id "$APPLE_ID" --password "${APPLE_APP_PASSWORD:?missing APPLE_APP_PASSWORD}" --team-id "${APPLE_TEAM_ID:?missing APPLE_TEAM_ID}")
  else
    return 1
  fi
  [ -n "$ID" ] && [ "$ID" != "-" ] || { echo "No developer certificate, cannot notarize"; exit 1; }
}

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[process.argv[1]]??"")}catch{}})' "$1"; }

# Submit a file to Apple and wait for the result; on failure print the reason Apple gave and fail (this build won't be released)
notarize() {
  local f="$1" out status id
  echo "Submitting $(basename "$f") to Apple for notarization (usually a few minutes)…"
  out=$(xcrun notarytool submit "$f" "${AUTH[@]}" --wait --timeout 2h --output-format json) || true
  echo "$out"
  status=$(printf '%s' "$out" | jget status)
  id=$(printf '%s' "$out" | jget id)
  if [ "$status" != Accepted ]; then
    echo "Notarization failed (${status:-no result})"
    [ -n "$id" ] && xcrun notarytool log "$id" "${AUTH[@]}" || true
    exit 1
  fi
  echo "Notarization passed: $(basename "$f")"
}

case "${1:-}" in
  app)
    APP="$2"
    if [ -z "$ID" ]; then
      codesign --force --deep --sign - "$APP" 2>/dev/null || true
      exit 0
    fi
    echo "Signing: ${ID}"
    RES="$APP/Contents/Resources"
    AGENT="$APP/Contents/Helpers/KikiAgent.app"
    # Inside out: first sign every Mach-O in the dependencies (native modules, bundled helper programs), then sign "Kiki Agent" (Node, with JIT and privacy permissions), and finally sign the app
    find "$RES" -type f -print0 | xargs -0 file -N -F $'\t' | { grep -F 'Mach-O' || true; } | cut -f1 |
      while IFS= read -r f; do cs "$f"; done
    cs --entitlements "$HERE/entitlements.plist" "$AGENT"
    # The background scripts in Contents/MacOS must also be signed individually (signatures live in extended attributes, which ditto and .dmg both preserve)
    for f in "$APP/Contents/MacOS/"*; do
      [ "$(basename "$f")" = Kiki ] || cs "$f"
    done
    cs "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
    ;;
  dmg)
    DMG="$2"; APP="$3"
    [ -n "$ID" ] && [ "$ID" != "-" ] || exit 0
    codesign --force --timestamp --sign "$ID" "$DMG"
    auth || { echo "No notarization key configured, skipping notarization"; exit 0; }
    # Submit once per chip: Apple issues the ticket based on the code hash, and the app inside the .dmg is the same code as the one outside, so it can be stapled directly
    notarize "$DMG"
    xcrun stapler staple "$DMG"
    xcrun stapler staple "$APP"
    ;;
  *) echo "Usage: sign.sh app <Kiki.app> | sign.sh dmg <Kiki.dmg> <Kiki.app>"; exit 2 ;;
esac
