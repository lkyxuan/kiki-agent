<div align="center">

**English** · [简体中文](https://github.com/lkyxuan/kiki/blob/main/README.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lkyxuan/kiki/main/docs/assets/banner-en-dark.svg">
  <img src="https://raw.githubusercontent.com/lkyxuan/kiki/main/docs/assets/banner-en-light.svg" alt="Kiki · Your personal AI team, on your own Mac" width="100%">
</picture>

<h3>Your personal AI team.</h3>

<p>Hand Kiki a goal. It breaks the work down, assigns the right agents and follows up.<br>
Many agents work in parallel, and the results come back to you in one place.</p>

<p>
  <a href="https://github.com/lkyxuan/kiki/releases/latest"><img src="https://img.shields.io/github/v/release/lkyxuan/kiki?style=flat-square&color=5b6cf0&label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/macOS-13.5%2B-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS 13.5+">
  <img src="https://img.shields.io/badge/Apple%20silicon%20%2B%20Intel-supported-5b6cf0?style=flat-square" alt="Apple silicon and Intel">
  <img src="https://img.shields.io/badge/data-100%25%20local-5b6cf0?style=flat-square" alt="Your data stays local">
  <img src="https://img.shields.io/badge/status-private%20beta-f5a524?style=flat-square" alt="Private beta">
</p>

<p>
  <a href="https://dl.kikibao.com/latest/Kiki-mac-arm64.dmg"><b>Download for Mac (Apple silicon)</b></a> ·
  <a href="https://dl.kikibao.com/latest/Kiki-mac-x64.dmg">Intel version</a> ·
  <a href="https://getkiki.ai">getkiki.ai</a>
</p>

</div>

---

## What is Kiki?

Kiki is a personal AI team that runs on your Mac. You give it a goal, Kiki splits the work across several agents running in parallel, and brings the results back to you.

A chat assistant answers one question at a time. Kiki takes on whole tasks: it breaks them down, runs them in parallel and in the background, and only interrupts you when something is done, needs a decision or goes wrong. The rest of the time is yours.

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/lkyxuan/kiki/main/docs/assets/screenshot-dark.png">
    <img src="https://raw.githubusercontent.com/lkyxuan/kiki/main/docs/assets/screenshot-light.png" alt="The Kiki app: your agents on the left, an agent's main chat in the middle, a task thread and status on the right" width="100%">
  </picture>
  <p><sub>Your agents on the left, an agent's main chat in the middle, a task thread and the agent's status on the right.</sub></p>
</div>

## Why Kiki

<table>
<tr>
<td width="33%" valign="top">

**🎯 Give goals, not steps**

No prompt engineering. Brief Kiki like a colleague, and it picks the right agents, each with its own skills, memory and ground rules.

</td>
<td width="33%" valign="top">

**🧵 One goal, many tracks**

Big tasks are split across agents with different strengths. They work at the same time and report back together.

</td>
<td width="33%" valign="top">

**🌙 Always on**

Long tasks keep running in the background and schedules run on their own. A daily brief sums up progress and what needs your decision.

</td>
</tr>
<tr>
<td valign="top">

**🛡️ You have the final say**

Fully automatic by default. Spending, sending things out and deleting can each be set to "ask me first". Files are backed up before deletes and overwrites, and a monthly budget cap keeps costs in check.

</td>
<td valign="top">

**🧠 Learns how you work**

Every correction is recorded and reviewed nightly. Mistakes that keep coming back become rules every agent follows, each one citing why and where it came from.

</td>
<td valign="top">

**🔒 Your data stays local**

Conversations, memory and settings are plain Markdown files on your Mac. Read, back up or move them anytime. Your keys never touch our servers.

</td>
</tr>
</table>

### Try saying

> Prepare next Wednesday's product launch
>
> Send me an AI news brief every day at 8
>
> Fix the login bug and open a PR
>
> Book the best flights and hotel for Tokyo next week

## Works with the tools you already use

- **Claude Code, Codex, Gemini and more.** Your local coding sessions show up in Kiki's overview automatically. Kiki alerts you when they finish, need approval or fail, and one click takes you back to the session.
- **Any major model provider.** Bring an API key from Anthropic, OpenAI, Gemini, DeepSeek and others, or sign in with a subscription you already have.
- **A model per job.** Routing, coding, writing, vision and summaries can each use a different model, so cheap models handle the cheap work.

## Every agent picks its own engine

In one Kiki, some agents run on the lightweight Kiki engine while others run real Claude Code. Switch per agent, and Kiki shows you what changes before you switch. Routing is always handled by Kiki.

| Engine | Status | Best for |
|---|---|---|
| **Kiki engine** | Default | Fast to start and extensible. Works with Anthropic, OpenAI, Gemini, DeepSeek and more. Built on the open-source pi. |
| **Claude Code** | Supported | Coding and long-running tasks. Agents run the real Claude Code with your own Claude subscription, exactly as it works in your terminal. |
| **DeepSeek Harness** | Supported | DeepSeek's official agent framework. Runs DSH plugins, and plugins with a UI open right in Kiki's side panel. |

More engines are on the way.

## Get started

Kiki for Mac is in private beta. You need a Mac with macOS 13.5 or later; Apple silicon and Intel are both supported.

1. **Install.** Download the [Apple silicon](https://dl.kikibao.com/latest/Kiki-mac-arm64.dmg) or [Intel](https://dl.kikibao.com/latest/Kiki-mac-x64.dmg) build (also on the [releases page](https://github.com/lkyxuan/kiki/releases/latest)), drag Kiki into Applications and open it from there.
2. **Enter your invite code.** The beta opens in batches. Kiki asks for your code the first time it starts.
3. **Add a model.** Paste a key from any provider, or sign in with your subscription.
4. **Give a goal.** Kiki handles the rest.

Prefer Terminal? One line installs the latest version:

```bash
curl -fsSL https://raw.githubusercontent.com/lkyxuan/kiki/main/packaging/install.sh | bash
```

Kiki updates itself: it checks for new versions every hour, installs when idle, and rolls back automatically if a new version fails to start. For an always-on setup, run Kiki on a Mac mini and reach it from your other devices over an encrypted [Tailscale](https://tailscale.com) connection.

> If macOS says it can't verify the developer on first launch, click Done, then open System Settings → Privacy & Security, scroll to the bottom and click Open Anyway.

## Pricing

You pay your model provider directly, with your own account or subscription. Kiki never touches the bill.

## Changelog

Each version's changes are listed on the [Releases](https://github.com/lkyxuan/kiki/releases) page, and the app shows the notes after every update.

## Feedback

Found a bug or have an idea? Open an [issue](https://github.com/lkyxuan/kiki/issues). We read every one.

---

<sub>Kiki's releases and feedback now live in <a href="https://github.com/lkyxuan/kiki">lkyxuan/kiki</a>. This repository no longer holds source code; code published here earlier remains under the license it was released with (FSL-1.1-ALv2) and is still in the commit history. "Kiki", "奇奇" and the Kiki icon are trademarks, and signed Kiki installers are published only by us. Product names and logos mentioned above belong to their owners and are shown only to indicate compatibility.</sub>
