# Kiki Mac App: install, auto-update, remote use

Kiki runs on a Mac mini that stays on, and you use it remotely from a MacBook or iPhone in a browser (or as an "app" added to the Dock/home screen).

## What it looks like

- **Kiki.app** bundles its own runtime (Node) and the Kiki Engine, so you don't need to install anything else on the Mac, and it won't install global commands into the system.
- Double-click Kiki.app: it opens Kiki's own window (a native macOS window with a Dock icon and menus) and registers Kiki as a background service (starts automatically at login, restarts if it crashes). Close the window or quit the app and Kiki keeps running in the background, so it's still usable from your phone.
- All data lives in `~/Kiki`; installing, reinstalling and updating never touch it. Logs are in `~/Library/Logs/Kiki/`.

## Install

Requires macOS 12 or later. Run one line in Terminal (or download the `.dmg` from the releases page, see below).

```bash
curl -fsSL https://raw.githubusercontent.com/lkyxuan/kiki-agent/main/packaging/install.sh | bash
```

It downloads the latest version, verifies the checksum, puts it in Applications and launches Kiki. The script is the recommended way to install because Kiki isn't signed with an Apple developer certificate yet, so an app downloaded in a browser gets blocked by macOS (the signing and notarization process is already set up, see [signing.md](signing.md)).

If you'd rather not use Terminal, download the `.dmg` from the [releases page](https://github.com/lkyxuan/kiki-agent/releases/latest) (arm64 for Apple silicon, x64 for Intel), open it and drag Kiki into Applications, then open it **from Applications** (if you double-click it directly in the mounted disk image, Kiki will ask you to drag it in first). The first time you open it, macOS will say the developer can't be verified: click "Done", go to "System Settings → Privacy & Security", scroll to the bottom and click "Open Anyway".

If there's no release yet, you can also build and install it yourself from the repo (requires Node 22.19 or later on the machine):

```bash
npm ci && packaging/build.sh arm64 && packaging/install.sh out/Kiki-mac-arm64.zip
```

### After the first install

1. On first launch, choose "Run on this computer", then enter a model API key: click "Settings → Providers" in the bottom-left of Kiki, choose DeepSeek, click "Enter API key" and paste your key (get one at https://platform.deepseek.com/api_keys) and you're ready to go; you can also choose another provider and sign in with a subscription. Which model each step uses is chosen in "Settings → Models". The key is stored in `~/Kiki/engine/auth.json` and only you can read it; the DeepSeek key can also go in `DEEPSEEK_API_KEY` in `~/Kiki/.env` (under "Advanced" below DeepSeek in Settings).

   Advanced: if you don't want the key sitting in a file in plain text, you can put it in the macOS keychain (retrievable after login). Kiki runs in the background with nobody at the computer to approve prompts, so the key has to be somewhere it can get to on its own:
   ```bash
   # replace sk-… with your key; if you use 1Password you can write -w "$(op read 'op://vault/item/field')"
   security add-generic-password -U -a "$USER" -s kiki-deepseek -w 'sk-…'
   ```
   Then write `DEEPSEEK_API_KEY=keychain:kiki-deepseek` in `~/Kiki/.env`.
   `op://` references are also supported, but the background process needs 1Password authorization on every restart, and with nobody to approve it the key can't be fetched (Kiki still starts, it just can't reach the model), so it isn't recommended.
2. If you edited `.env` by hand, restart Kiki for it to take effect (there's also "Restart now" in Settings): `launchctl kickstart -k gui/$(id -u)/com.lkyxuan.kiki.en`
3. To keep Kiki available on the Mac mini, turn on "Automatically log in" (System Settings → Users & Groups); Kiki starts with login. The first time you install it, macOS will say "Background item added" — that's Kiki's background service, allow it.

## Auto-update

The approach borrows from Hermes' `hermes update` (git pull + self-check + rollback on failure + receipt), but Kiki is a packaged app with no git, so it downloads from GitHub Releases instead:

1. On startup and every hour after that, it checks GitHub for the latest release.
2. When there's a new version, "New version vX · Update" appears in the top-right of the web UI. By default it **installs automatically when no conversation is running**; to install manually, write `KIKI_AUTO_UPDATE=0` in `~/Kiki/.env`.
3. The install process: download → verify checksum → unzip to a staging area → run a self-check with the new version → back up `registry.json`, `AGENTS.md`, `.env` (to `~/Kiki/backups/`, keeping the last 5) → swap in the new app → restart.
4. If the new version doesn't come up within 45 seconds, it automatically switches back to the old version, the web UI says "rolled back", and that version won't be retried automatically.
5. Every result is recorded in `~/Library/Logs/Kiki/last-update.json` and `update.log`. The previous version stays in a hidden folder in Applications, `.Kiki-previous.app`, so you can switch back manually if needed.

Checking for updates doesn't require a GitHub login. If you've set `GITHUB_TOKEN` in `.env`, or the machine is logged in to `gh`, Kiki will use it too, to avoid hitting GitHub's anonymous rate limit (60 requests per hour; Kiki only checks once an hour, so it usually doesn't matter).

### How to publish a new version (developers)

Bump the version in `package.json` (e.g. `npm version patch --no-git-tag-version`) and merge into main. GitHub Actions will check, test, build both arm64 and x64 packages and create a Release. Kiki on each machine will install it within an hour (if you can't wait, click "Check for updates" in the bottom-left of Settings).

## Using Kiki's app on another computer (split front end and back end)

The first time the app opens it asks: **run on this computer**, or **connect to a remote address**. For example, if Kiki runs on a Mac mini, install Kiki.app on your MacBook too, choose "Connect to a remote address" and enter the Mac mini's Tailscale address (see the next section); that MacBook then acts only as the UI, running no backend and storing no data. To change it later, use the menu "Kiki → Connect to…" (⇧⌘K). Settings is ⌘,, and appearance (follow system / light / dark) is in Settings or the menu "View → Appearance".

The UI is loaded from the backend, so once the backend (the Mac mini) updates, the UI on every computer is the new one too.

On a computer that's only the UI, the window app itself (Kiki.app) updates on its own: it checks GitHub on launch and every 6 hours after that, and when there's a new version it asks "Update now"; clicking it closes the window, downloads the new version, verifies the checksum, swaps it in and reopens automatically — it can update even when it can't reach the remote. You can also click the menu "Kiki → Check for App Updates…" at any time. Records are in `~/Library/Logs/Kiki/client-update.log`.

## Remote use (safely)

Kiki can read and write files and run commands on the Mac mini, so it must **never be exposed directly to the public internet**. It only listens on the local machine (127.0.0.1) and has no login of its own. The recommended way to use it remotely is Tailscale: only devices signed in to the same Tailscale account can connect, all traffic is encrypted end to end, and you get HTTPS.

On the Mac mini:

1. Install Tailscale (App Store or `brew install --cask tailscale`) and sign in.
2. Run this once in Terminal (it takes effect at boot automatically):
   ```bash
   tailscale serve --bg 4567
   ```
   The first time it will tell you to enable HTTPS in the Tailscale admin console; click the link and turn it on. When it's done it tells you the address, something like `https://mac-mini.xxxx.ts.net`.

On the iPhone / MacBook:

1. Install Tailscale there too and sign in to the same account.
2. Open that address and you're in Kiki.
3. To use it as an app: on iPhone, Safari "Share → Add to Home Screen"; on Mac, Safari "File → Add to Dock".

If you want to use the IP directly (the `100.x.x.x` Tailscale assigns) instead of the name: just enter `100.x.x.x:4567` in the client (it will use http automatically; Tailscale itself is encrypted). Besides 127.0.0.1, Kiki also opens the same port on the machine's Tailscale IP, only on the address Tailscale itself confirms it assigned to this machine (it asks `tailscale ip -4`; if Tailscale isn't found it doesn't open it), so only devices on your Tailscale network can connect — not the LAN or the public internet. Find the IP with `tailscale ip -4`. To turn it off, write `KIKI_TAILSCALE_LISTEN=0` in `.env`. (Note: `tailscale serve` forwarding only recognizes names and returns 404 for IP access, so for the IP you connect directly to Kiki's port.)

Notes:

- Use `tailscale serve`, **not `tailscale funnel`** (funnel exposes it to the whole internet).
- Kiki also has its own guard: it only accepts requests from `localhost`, `*.ts.net` and Tailscale private IPs (`100.64.0.0/10`), which blocks malicious web pages from quietly sending commands to Kiki through your browser. To use another domain, add it to `KIKI_ALLOWED_HOSTS` in `.env`.
- Don't add other people's devices to your Tailscale network; any device on that network can use Kiki.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.lkyxuan.kiki.en
rm ~/Library/LaunchAgents/com.lkyxuan.kiki.en.plist
rm -rf /Applications/Kiki.app /Applications/.Kiki-previous.app
# data is in ~/Kiki; whether to delete it is up to you
```

## Possible future work

- Apple developer signing and notarization: the release process is already set up and takes effect once the certificate is configured in the repo, see [signing.md](signing.md).
