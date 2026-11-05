---
name: connect-coding-agents
description: Connect the user's Claude Code and Codex to Kiki so Kiki knows what tasks they are working on and how they are going (started, waiting for approval, done). Use when the user says "connect/hook up Claude Code, Codex" or "let Kiki manage my coding tasks".
---

# Connect Claude Code / Codex

How it works: install a few hooks into Claude Code and configure notify in Codex; when they start, need approval, finish a turn, or shut down, they send a small JSON payload to Kiki.
Kiki only records status, shows it in the right column, and groups it under bots by project folder. The scripts use only the built-in `sh` and `curl`, no Node required.

The commands below all run on **the computer running Kiki**. Kiki's address is `http://127.0.0.1:${PORT:-4567}`, written as `$K` below:

```sh
K="http://127.0.0.1:${PORT:-4567}"
```

## 1. Check the current state

```sh
curl -s "$K/api/coders/setup"
```

In the response:
- `claude.found` / `codex.found`: whether Claude Code (`~/.claude`) and Codex (`~/.codex`) exist on this computer
- `claude.on` / `codex.on`: whether they are already connected
- `tailscale`: this computer's Tailscale address (an empty array means not installed or not logged in)
- `lastPing`: the last time a hook was received

## 2. This machine: install directly

Install whichever is present on this machine, no need to ask the user (the original config is backed up first; only Kiki's own entries are added, the user's existing hooks are left untouched):

```sh
curl -s -X POST "$K/api/coders/setup" -H 'content-type: application/json' -d '{"target":"claude","on":true}'
curl -s -X POST "$K/api/coders/setup" -H 'content-type: application/json' -d '{"target":"codex","on":true}'
```

After installing, run a self-check (sends a test message, no card is left in the UI), then see whether `lastPing` has updated:

```sh
curl -s -X POST "$K/api/coders/test"
curl -s "$K/api/coders/setup"
```

Tell the user: Claude Code / Codex sessions that are already open need to be restarted for this to take effect.

## 3. Claude Code / Codex on another computer

This step is only needed when the user says Claude Code runs on **another computer**. For purely local use, Tailscale is not needed; don't mention it.

- `tailscale` has an address (e.g. `100.123.241.60`): give the user the following line to run in that computer's terminal (that computer must also be logged in to the same Tailscale):

  ```sh
  curl -sf http://<Tailscale address>:${PORT:-4567}/api/coders/install.sh | sh
  ```

  When it finishes it prints "Connected: Claude Code Codex". When that computer cannot reach Kiki, progress is stored in `~/.kiki/spool/` there first and sent on the next connection.
- `tailscale` is empty: tell the user both computers need Tailscale installed and logged in to the same account first (https://tailscale.com/download), then come back to you.

## 4. Remove

```sh
curl -s -X POST "$K/api/coders/setup" -H 'content-type: application/json' -d '{"target":"claude","on":false}'
curl -s -X POST "$K/api/coders/setup" -H 'content-type: application/json' -d '{"target":"codex","on":false}'
```

If Codex had its own notify before, it is restored when removed.

## When something goes wrong

- The response contains `error`: tell the user exactly what it says; common cases are `~/.claude/settings.json` not being valid JSON, or the notify in `~/.codex/config.toml` being written across multiple lines.
- Installed but nothing ever appears in the right column: confirm the user has spoken in a **newly opened** session; then check `lastPing`.
- A project is filed under the wrong bot: the user can reassign it on the card in the right column; or `curl -s -X POST "$K/api/coders/bao" -H 'content-type: application/json' -d '{"cwd":"/project/folder","bao":"bot name"}'`.
