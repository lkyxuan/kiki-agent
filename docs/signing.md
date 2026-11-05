# Apple code signing and notarization

Once signed and notarized, anyone who downloads the `.dmg` from the website can double-click it and open it, with no more "cannot verify the developer" warning.
The release workflow (`.github/workflows/release.yml`) is already wired up, but **it only does this if the certificates are filled in under the repository Secrets**; without them it does local signing only, exactly as before, and nothing breaks.

## Secrets to fill in on the repository

Create them at <https://github.com/lkyxuan/kiki-agent/settings/secrets/actions>:

| Name | Contents | When it's needed |
| --- | --- | --- |
| `MACOS_CERT_P12` | The .p12 exported from the Developer ID Application certificate, as the text produced by `base64 -i kiki-cert.p12 \| pbcopy` | Required |
| `MACOS_CERT_PASSWORD` | The password set when exporting the .p12 | Required |
| `ASC_KEY_P8` | The full contents of the App Store Connect API key .p8 file | Notarization method A (recommended) |
| `ASC_KEY_ID` | The ID of this key | Notarization method A |
| `ASC_ISSUER_ID` | The Issuer ID | Notarization method A |
| `APPLE_ID` | The Apple ID email | Notarization method B |
| `APPLE_APP_PASSWORD` | An app-specific password | Notarization method B |
| `APPLE_TEAM_ID` | The 10-character team ID | Notarization method B |

For step-by-step instructions on applying for the certificate and keys, see the project document "Kiki Apple code signing and notarization: what to do once the account is approved".

## What happens during a release

1. Import the certificate into a temporary keychain (deleted when the run finishes).
2. `packaging/sign.sh app`: sign from the inside out, with hardened runtime enabled and a timestamp on everything. Native modules in dependencies (`.node`) are signed first; the bundled Node package lives in the "Kiki Agent" helper app (`Contents/Helpers/KikiAgent.app`) and gets the entitlements in `packaging/entitlements.plist` (JIT, loading native modules, automation, and the privacy permissions for Calendar/Contacts/Photos/Microphone/Camera); the `Contents/MacOS/kiki-server` script is signed separately; finally the whole app is signed.
3. Build the `.dmg`, then `packaging/sign.sh dmg`: sign the `.dmg` and submit the whole thing to Apple for notarization (one submission per chip type, with the app inside notarized along with it), and once it passes, staple the ticket to the `.dmg` and the app.
4. Then build the `.zip` used for auto-updates from the stapled app.
5. If notarization fails or takes more than 2 hours, this release is simply not published, and the log contains the reason Apple gave. Apple is slow to review when an account is new (the first one takes about an hour), and after that it's usually a few minutes.

The check on every PR (`check.yml`) does the same hardened-runtime signing with a local certificate and runs the self-check, confirming that Node still runs normally under the notarization requirements.

## Auto-update

- An already-installed (locally signed) Kiki upgrades to the first signed release as usual.
- Starting with the signed release, before updating it verifies the new version with `codesign -R`: the signature is intact, the certificate chain reaches Apple, it's a Developer ID certificate, and the team ID matches its own; if any of that fails, the update is abandoned (`src/update.ts`).
- After switching to the signed release, the system may ask once more for permissions such as Accessibility and Screen Recording; once granted, later updates won't ask again.

## System permissions (Privacy & Security)

- The thing that actually does the work is the "Kiki Agent" launched by launchd (`Contents/Helpers/KikiAgent.app`, identifier `com.lkyxuan.kiki.en.agent`); the system's privacy permissions are all recorded against it, and Settings shows "Kiki Agent". `Resources/node/bin/node` is just a link pointing to it.
- Under hardened runtime, any privacy permission not declared in `entitlements.plist` is denied outright by the system without even a prompt; the usage descriptions for the ones we need are in `packaging/agent-Info.plist`. If you add a new permission later, add it in both places.
- The first time Kiki opens, it goes straight to the "Mac permissions" page in Settings; "Request all" makes the agent itself bring up, one after another, the Accessibility, Screen Recording, and per-app Automation dialogs; Apple doesn't allow a prompt for Full Disk Access, so it opens the Settings page and points out "Kiki Agent" in Finder (`src/macperm.ts`).
- As long as the signing identity and team ID stay the same, permissions already granted survive auto-updates.
