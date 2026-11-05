# Mailroom

The Mailroom is a resident module built into the Kiki Agent. It does one thing: **everything that needs to reach you goes into the same inbox first, and then Kiki routes it.**

```
Sources (in)                            Inbox                       Out
───────────                            ───────                   ──
Pushed in by external agents (mailbox, A2A, ACP)  ┐
Scheduled checks (web pages, RSS, APIs, folders)  ├─► postroom/inbox.jsonl ─► Kiki routes to a bot ─► notification channel (currently: the Kiki UI)
Kiki internals (background tasks, scheduled tasks) ┘                         └► notify only (route: false)
```

- **Inbox**: `~/Kiki/postroom/inbox.jsonl`, one entry per line. Written to disk before routing, so nothing is lost on restart.
- **Dispatched work**: `postroom/outbox.jsonl`. When the other side replies, it includes the dispatch ID (`re`), and the result goes straight back into the conversation that dispatched it.
- **Notification channels** are separate from the inbox (`src/notify.ts`). Right now there is only the Kiki UI; later, Telegram, WeChat, or mobile push can be added as plugins.
- Things that need your attention (the other side errored, the other side flagged it for attention, routing failed) show up in the "Mailroom" card in the rightmost column.

## Timeliness: pushes are handled immediately, rules sort first

- Push-type sources are handled the moment they arrive, without waiting for the once-a-minute sweep: a file dropped into a mailbox folder is picked up right away; local programs can `POST /api/postroom/push/<source name>` directly with a body of `{"title", "text", "attention", "bao", "re"}`; ACP hands results back as soon as it finishes; when an A2A config includes `pushUrl` (a Kiki address the other side can reach), the other side pushes results over when done. Only scheduled-check sources are polled at their interval.
- Quick sorting by rules comes first: if the other side sets `attention`, or the message matches `postroom/key-rules.md` (one rule per line, either `- from: xxx` or `- contains: xxx`; wrap in slashes for a regex), the program immediately marks it as important and alerts you without waiting for the AI, then hands it to Kiki as usual.
- The Mailroom only handles getting things out promptly. Where notifications ultimately go (system notifications, Telegram, Bark, …) is decided by the notification channel plugin; important ones carry an `urgent` flag.

## Registering sources

Every folder under `postroom/mailbox/` automatically counts as a mailbox. Everything else goes in `postroom/agents.json`:

| kind | Used for | What to write |
| --- | --- | --- |
| `mailbox` | Any program that can read and write a folder | `dir` (optional, defaults to `postroom/mailbox/<name>`) |
| `a2a` | Bots that speak the A2A protocol (e.g. Grokbot) | `url`, optionally `headers` |
| `acp` | Coding agents such as Claude Code and Codex | `preset`: `claude-code` or `codex` (or write your own `command` + `args`); `cwd` is the folder where the work happens |
| `watch` | Periodically check a place | `url` (web page / RSS / API) or `path` (file / folder), optionally `every` (minutes), `route: false` (notify only, don't route) |

See `postroom/mailbox/README.md` for examples.

### A2A

Dispatch uses `message/send` (non-blocking), then polls with `tasks/get` each round. When it finishes, fails, or the other side needs a human reply, that counts as one reply. Cancelling calls `tasks/cancel`. Tasks still waiting are recorded in `postroom/state/<name>.json`.

### ACP

Kiki plays the editor role: it starts the agent process, opens a new session for each piece of work, collects the text it returns, and hands the answer back when done.
When the other side asks for permission, Kiki decides by its approval rules: commands go through cc-safety-net first; deletions, force pushes, outbound sends, and spending money get an approval card attached to the conversation that dispatched the work; everything else is approved directly.
If `claude-code-acp` or `codex-acp` isn't installed, the official adapter package is pulled on demand with `npx -y`, which requires Node on the machine.

### Scheduled checks

The first run only records the current state and reports nothing. After that: feeds and folders report newly appearing entries or files; web pages, APIs, and files report newly appearing lines.

## For code

- Post an internal source: `postroom.post("background task", { title, text, route: false })`
- Dispatch work: `postroom.send(agent, text, title, origin)`; if you need to wait for the result (external executors on the task board), use `postroom.run(agent, text, { signal })`
- Bot tools: `kiki_outside` (`list` / `send`)

## How Kiki reads mail and the watchlist

Each new message in the inbox (not a reply to dispatched work, and not a task result already written into a conversation) is handled in two steps, and nobody reads everything:

1. **Which bot it goes to**: if the other side specified one, use it; otherwise look at the keyword-bearing entries in each bot's watchlist, and the bot with the most matches takes it directly (no model needed); if nothing matches, a cheap model (`TRIAGE_MODEL`, or `SUMMARY_MODEL` if unset) picks one based only on each bot's one-line description.
2. **That bot judges using only its own watchlist**: the watchlist is `agents/<bot>/watchlist.md`. Entries with 〔keywords: …〕 are only shown to the model when a message matches; entries without keywords use the most recent 40. It decides whether to alert you right away and whether to hand it to the bot to handle; when something new worth watching comes up, it records an entry (with keywords); when it's resolved, it strikes it out (`[x]`) and tells you; for things that are relevant but not yet settled: if it's tied to a task card (〔task: id〕), it goes back to that task to continue; if it's tied to a conversation (`[continue](kiki:bot/conversation)`), it goes back to that conversation, and you're alerted at the same time.

When a task needs to wait for follow-up: `watchForTask(dataDir, { taskId, agent: bot, about, match, session })`; to cancel or stop watching: `unwatchTask(dataDir, botList, taskId)`. When an entry tied to a task matches a new message, the Mailroom calls `postroom.followTask(taskId, body)` (the task board hooks in).

If the model errors, fall back to the old way: hand the whole thing to Kiki to route.
