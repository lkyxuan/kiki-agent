// Local chat web page: listens only on 127.0.0.1, so other machines can't connect (remote access goes through Tailscale Serve, see docs/mac-app.md).
// The page is public/index.html; data goes through the endpoints below, live updates go through SSE.
//
// Channel boundary: any "channel" (this web page, future WeChat plugins, ...) only needs to call router.handle(chatId, text, reply).
import type { WorkBook } from "./work.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { Acks, markForReply } from "./ack.js";
import { ackPrompt, cleanAck, ROLES, roleModel, roleOf, validSpec } from "./modelroles.js";
import { MAIN_SESSION } from "./bao.js";
import type { Agents, ChatLine } from "./agents.js";
import type { Approvals, Decision } from "./approval.js";
import { rejectReason, tailscaleIp } from "./guard.js";
import type { Registry } from "./registry.js";
import { answerText, deliveryText, type Postroom } from "./postroom.js";
import type { Notifier } from "./notify.js";
import type { Coders } from "./coders.js";
import { type CoderSetup, hookScript, mergeClaude, mergeCodex, remoteInstallScript } from "./coders-setup.js";
import { SETUP_BAO, SETUP_PENDING } from "./migrate.js";
import type { Router } from "./router.js";
import { OPEN } from "./tasks.js";
import { Logins } from "./login.js";
import { setProviderModels, setProviderOn } from "./modelprefs.js";
import { imageMime, saveImage, uploadsDir, validImageName } from "./images.js";
import { baoLook, setEnvLine, settingsApi } from "./settings.js";
import { baoShareApi } from "./baoshare.js";
import { type Updater, VERSION } from "./update.js";

const run = promisify(execFile);

const MAIN = "main"; // the main bot's path in the web page
const CHAT_ID = "app"; // the main bot's chat id as seen by the router
const POSTROOM_CHAT = "postroom"; // messages the Mailroom hands to Kiki get their own chat id, so they don't disturb your "current conversation"
const STATIC: Record<string, string> = {
  "/manifest.webmanifest": "application/manifest+json",
  "/icon.svg": "image/svg+xml",
  "/icon-180.png": "image/png",
  "/settings.html": "text/html; charset=utf-8", // settings page
  "/qiqi.png": "image/png", // Kiki's avatar
  "/qiqi-base.png": "image/png", // animated avatar: base image with the eyes painted black
  "/qiqi-closed.png": "image/png", // animated avatar: the closed-eyes layer
  "/qiqi-eyes.js": "text/javascript; charset=utf-8",
  "/theme.css": "text/css; charset=utf-8", // light / dark colors, shared by both pages
  "/theme.js": "text/javascript; charset=utf-8", // appearance switch (follow system / light / dark)
  "/bots.js": "text/javascript; charset=utf-8", // default bot avatars: little robots generated from the name
};

export function startServer(opts: {
  port: number;
  dataDir: string;
  publicDir: string;
  agents: Agents;
  registry: Registry;
  router: Router;
  updater?: Updater;
  approvals?: Approvals;
  postroom?: Postroom;
  notifier?: Notifier;
  works?: WorkBook;
  coders?: Coders;
  coderSetup?: CoderSetup;
}) {
  const { agents, registry, router } = opts;
  const mainLog = join(opts.dataDir, "main.jsonl"); // the main bot's chat log
  const clients = new Set<ServerResponse>();
  const settings = settingsApi({ dataDir: opts.dataDir, port: opts.port });
  const baoShare = baoShareApi({ dataDir: opts.dataDir }); // bot export / import, see baoshare.ts
  const logins = new Logins(() => agents.modelRuntime(), opts.dataDir, agents.engineDir);
  // Model menu: what's in use, what's available, whether ChatGPT is logged in
  const modelInfo = async () => {
    const models = await agents.modelChoices();
    return {
      current: agents.currentModel,
      models,
      vision: (await agents.visionChoice(models))?.spec ?? null, // when the current model can't see images, hand them to this one first
      chatgpt: { loggedIn: await logins.loggedIn("openai").catch(() => false), login: logins.state.provider === "openai" ? logins.state : { status: "idle" } },
      login: logins.state, // login in progress (any provider)
    };
  };
  const saveEnv = (key: string, value: string) => {
    const envFile = join(opts.dataDir, ".env");
    try {
      writeFileSync(envFile, setEnvLine(existsSync(envFile) ? readFileSync(envFile, "utf8") : "", key, value), { mode: 0o600 });
    } catch (e) {
      console.warn(`Failed to write ${key} back to .env:`, (e as Error).message);
    }
    process.env[key] = value;
  };

  const push = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  agents.on("delta", (d) => push("delta", d));
  agents.on("busy", (d) => push("busy", d));
  agents.on("activity", (d) => push("activity", d)); // thinking / which tool is being called
  // Kiki's routing progress: the web page shows "thinking about which bot to hand this to… / handed to X", and after handing off it follows that conversation's progress
  let mainLive: { since: number; status: string; follow?: string } | null = null;
  router.progress = (chatId, p) => {
    if (chatId !== CHAT_ID) return;
    mainLive = { since: mainLive?.since ?? Date.now(), status: p.status, follow: p.path };
    push("activity", { path: MAIN, live: mainLive });
  };
  agents.on("message", (d) => push("message", d)); // background tasks report back to the original conversation
  // Quick ack: as soon as a message arrives, put a reaction on the bubble (👀 / queued / ⏳ / ✅ / ✋ / ❗) without waiting for the model, see ack.ts
  const acks = new Acks();
  acks.on("change", (d) => push("ack", d));
  // "Quick ack": only runs if a small model is selected, in parallel with the main model; if it answers slower than the main reply, it isn't shown
  const quickLine = (ack: string, who: string, text: string) => {
    const spec = roleModel("ack");
    if (!spec || text.trim().startsWith("/")) return;
    agents
      .complete(ackPrompt(who), text.slice(0, 2000), spec)
      .then((raw) => acks.say(ack, cleanAck(raw)))
      .catch((e) => console.warn("[ack] quick ack failed:", (e as Error).message));
  };
  router.tasks.on("update", (t) => {
    acks.onTask(t);
    push("task", t);
    push("tree", tree());
  });
  opts.works?.on("change", () => push("tree", tree())); // reclassifying work updates the right column
  opts.updater?.on("state", (s) => push("update", s));
  opts.approvals?.on("change", (list) => push("approvals", list)); // cards for ready to send, over budget
  opts.approvals?.actions.on("change", () => push("actions", opts.approvals!.actions.list(20))); // what Kiki did automatically

  const mainSay = (role: ChatLine["role"], text: string, ack?: string) => {
    appendFileSync(mainLog, JSON.stringify({ role, text, ts: new Date().toISOString() }) + "\n");
    if (role === "assistant" && mainLive) {
      mainLive = null; // Kiki replied, so this round is done
      push("activity", { path: MAIN, live: null });
    }
    push("message", { path: MAIN, role, text, ...(ack ? { ack } : {}) });
  };
  // Background tasks started from this chat after this message was sent and not yet attached to another message (there can be several when split into pieces)
  const tasksSince = (chatId: string, since: number) =>
    router.tasks.list((t) => t.chatId === chatId && Date.parse(t.created) >= since - 1000 && !acks.linked(t.id));

  const mainHistory = (): ChatLine[] =>
    existsSync(mainLog)
      ? readFileSync(mainLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  // One of the notification channels: the Kiki UI, adds a line in Kiki's chat
  opts.notifier?.add({ id: "kiki-ui", name: "Kiki UI", send: (n) => mainSay("assistant", `${n.urgent ? "⚠️ " : "📮 "}${n.title}\n\n${n.text}`) });

  // Mailroom: new messages in the inbox are handed to Kiki for routing (same path as talking to Kiki yourself, with its own chat id),
  // Kiki's receipt comes back to you through the notification channel; replies to a particular assignment are recorded straight back into that conversation
  const pr = opts.postroom;
  const viewing = new Map<string, number>(); // path -> last time it reported "currently open"
  if (pr) {
    pr.deliver = (it) =>
      new Promise((ok, fail) => {
        let first = "";
        router
          .handle(POSTROOM_CHAT, deliveryText(it, (b) => agents.exists(b)), async (r) => {
            first ||= r;
            void opts.notifier?.send({
              title: `Mailroom · "${it.from}" sent ${it.title ? `"${it.title}"` : "a message"}`,
              text: r,
              source: `Mailroom · ${it.from}`, // important ones were already alerted separately on arrival; this is Kiki's receipt, so no system notification
            });
            push("tree", tree());
          })
          .then(() => ok(first), fail);
      });
    pr.answer = async (it, sent) => {
      const rec = sent.origin ? registry.byPath(sent.origin) : undefined;
      if (!rec) return false;
      await agents.note(rec.agent, rec.path, answerText(it, sent));
      return true;
    };
    // Only reached when you don't have that conversation open: tells you where the result was written
    pr.notify = async (it) => {
      const rec = it.path && it.path !== MAIN ? registry.byPath(it.path) : undefined;
      const where = rec ? `\n\nResult in [${rec.name === "main chat" ? rec.agent : rec.name}](kiki:${rec.agent}/${rec.name})` : "";
      const title = it.status === "replied" || it.re ? `"${it.from}" replied${it.title ? ` to "${it.title}"` : ""}` : (it.title ?? `New message from "${it.from}"`);
      const why = it.urgent ? `(Important: ${it.urgent})\n` : "";
      await opts.notifier?.send({ title, text: `${why}${it.text.length > 600 ? `${it.text.slice(0, 600)}…` : it.text}${where}`, urgent: !!it.urgent, source: it.from });
    };
    // The web page reports which conversations you have open (middle + right column); if it doesn't report again within 90 seconds, you're considered gone
    pr.isViewing = (p) => (viewing.get(p) ?? 0) > Date.now() - 90_000;
    pr.followUp = async (session, watch, it) => {
      const rec = registry.find(session)[0];
      if (!rec) throw new Error(`Conversation "${session}" not found`);
      const msg = `[Mailroom] There's a new message about "${watch}", which you handled earlier (from ${it.from}):\n\n${it.title ? `${it.title}\n` : ""}${it.text}\n\n(Compare against what was done before and explain in a few sentences what the user needs to do now, or what you'll do next.)`;
      agents
        .send(rec.agent, rec.path, msg)
        .then((r) => agents.announce(rec.path, r))
        .catch((e) => agents.announce(rec.path, `Something went wrong: ${(e as Error).message}`));
      return `Handed back to [${rec.name === "main chat" ? rec.agent : rec.name}](kiki:${rec.agent}/${rec.name}), which will give the next step with the earlier context.`;
    };
    pr.on("change", () => push("tree", tree()));
    // Routing failures, external agent errors: also announced through the notification channel (not just a line in the status column)
    pr.on("attention", (a: { title: string; why: string; from: string }) =>
      void opts.notifier?.send({ title: `Mailroom · "${a.from}" ${a.title}`, text: a.why, urgent: true, source: `Mailroom · ${a.from}` }),
    );
  }

  // Claude Code / Codex in the terminal: refresh the right column on any state change; say something when one is stuck waiting for your approval
  const cs = opts.coders;
  let lastPing: string | undefined;
  cs?.on("change", (s?: { status: string; waitingFor?: string; tool: string; repo: string; title: string; bao: string }, kind?: string) => {
    push("tree", tree());
    if (s && kind === "waiting" && s.waitingFor === "approval")
      void opts.notifier?.send({ title: `${s.tool === "codex" ? "Codex" : "Claude Code"} is waiting for your approval in ${s.repo}`, text: s.title || "Take a look in the terminal", source: s.tool });
  });

  const tree = () => ({
    // all unfinished ones (to-dos, scheduled, waiting on you…), and only the latest 40 finished ones
    tasks: [...router.tasks.list((t) => OPEN.includes(t.status)), ...router.tasks.list((t) => !OPEN.includes(t.status)).slice(-40)],
    current: registry.current(CHAT_ID)?.path,
    main: mainLive, // Kiki's routing progress, null if none
    acks: acks.list(), // reactions on bubbles
    postroom: pr?.state() ?? null, // Mailroom: external agent status, things that need your attention
    coders: cs?.state() ?? [], // Claude Code / Codex in the terminal
    setupBao: SETUP_BAO, // Butler: doesn't connect to your projects, so it's not listed when switching bots
    welcome: existsSync(join(opts.dataDir, SETUP_PENDING)) ? SETUP_BAO : null, // first open: go straight to the Butler
    agents: agents.listAgents().map((name) => ({
      name,
      works: opts.works?.list(name) ?? [], // what this bot is working on (the right column groups by it)
      ...baoLook(opts.dataDir, name), // avatar emoji
      sessions: registry.list(name).map((s) => ({ ...s, busy: agents.isBusy(s.path), live: agents.progress(s.path) ?? null })),
    })),
  });

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const body = async () => {
      let s = "";
      for await (const chunk of req) s += chunk;
      return JSON.parse(s || "{}");
    };

    if (url.pathname === "/api/tree") {
      await router.ensureMains().catch(() => {}); // a bot just created in settings also gets its main chat right away
      return json(tree());
    }
    if (url.pathname.startsWith("/api/settings")) return settings(req, res, url); // settings page, see settings.ts
    if (url.pathname.startsWith("/api/bao/")) return baoShare(req, res, url); // bot export / import

    // Mailroom: GET for the overview; POST /api/postroom/poll to fetch a round immediately, send {agent, text, title} to assign work, dismiss {id} to stop seeing it
    // The web page reports which conversations you currently have open (empty when the page is in the background). The Mailroom uses this to decide whether to notify and to clear unread
    if (url.pathname === "/api/viewing" && req.method === "POST") {
      const b = await body();
      const paths: string[] = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === "string") : [];
      const now = Date.now();
      for (const [p] of viewing) if (!paths.includes(p)) viewing.delete(p);
      for (const p of paths) viewing.set(p, now);
      pr?.markRead(paths);
      return json({ ok: true });
    }
    // Push: a local program (or an A2A push notification) POSTs straight here and it's received immediately. /api/postroom/push/<source name> {title, text, attention, bao, re}
    if (url.pathname.startsWith("/api/postroom/push/") && req.method === "POST" && pr) {
      const from = decodeURIComponent(url.pathname.slice("/api/postroom/push/".length));
      if (!/^[\p{L}\p{N} _.-]{1,40}$/u.test(from)) return json({ error: "Invalid source name" }, 400);
      try {
        const it = pr.push(from, await body());
        return json({ ok: true, id: it?.id });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    // First time Kiki is opened: once the web page lands in the Butler's conversation, clear the marker and the Butler says hello first
    if (url.pathname === "/api/welcome/seen" && req.method === "POST") {
      const f = join(opts.dataDir, SETUP_PENDING);
      if (existsSync(f)) {
        try { unlinkSync(f); } catch {}
        const m = registry.get(SETUP_BAO, MAIN_SESSION);
        if (m) await agents.note(SETUP_BAO, m.path, "Hi, I'm the Butler — I take care of Kiki's own affairs. Let's get Kiki set up first: connect a model and grant Mac permissions. If you normally use Claude Code or Codex, I can hook those up too so Kiki knows what they're doing. Where would you like to start?").catch(() => {});
        push("tree", tree());
      }
      return json({ ok: true });
    }
    // Claude Code / Codex in the terminal (see coders.ts, coders-setup.ts)
    if (url.pathname.startsWith("/api/coders") && cs) {
      const kikiUrl = () => {
        const host = String(req.headers.host || `127.0.0.1:${opts.port}`);
        return `http://${host}`;
      };
      const text = async () => {
        let s = "";
        for await (const chunk of req) s += chunk;
        return s;
      };
      if (url.pathname === "/api/coders" && req.method === "GET") return json(cs.state());
      if (url.pathname === "/api/coders/event" && req.method === "POST") {
        const tool = url.searchParams.get("tool") || "";
        lastPing = new Date().toISOString();
        let raw: unknown;
        try { raw = JSON.parse(await text()); } catch { return json({ error: "Not JSON" }, 400); }
        if ((raw as any)?.session_id === "kiki-selftest") return json({ ok: true, test: true });
        const s = await cs.ingest(tool, raw, url.searchParams.get("host") || undefined);
        return json({ ok: true, id: s?.id });
      }
      if (url.pathname === "/api/coders/batch" && req.method === "POST") {
        lastPing = new Date().toISOString();
        return json({ ok: true, n: await cs.ingestLines(await text()) });
      }
      if (url.pathname === "/api/coders/test" && req.method === "POST") {
        // Send a test message with the installed script to see whether it gets through
        const script = opts.coderSetup?.script;
        if (!script || !existsSync(script)) return json({ error: "The script isn't installed yet — connect Claude Code or Codex first" }, 400);
        const before = lastPing;
        await new Promise<void>((ok) => {
          const p = execFile(script, ["claude-code"], { timeout: 5000 }, () => ok());
          p.stdin?.end(JSON.stringify({ session_id: "kiki-selftest", hook_event_name: "SessionStart", cwd: "" }));
        });
        return json({ ok: lastPing !== before, lastPing });
      }
      if (url.pathname === "/api/coders/setup" && opts.coderSetup) {
        if (req.method === "GET") return json({ ...opts.coderSetup.status(), tailscale: await tailscaleOwnedIps(), port: opts.port, lastPing });
        try {
          const b = await body();
          if (b.target !== "claude" && b.target !== "codex") return json({ error: "target must be claude or codex" }, 400);
          return json({ ok: true, note: opts.coderSetup.set(b.target, b.on !== false) });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
      if (url.pathname === "/api/coders/bao" && req.method === "POST") {
        try {
          const b = await body();
          cs.setBao(String(b.cwd ?? ""), String(b.bao ?? ""));
          return json({ ok: true });
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
      // Another computer: curl -sf http://<Tailscale address>:4567/api/coders/install.sh | sh
      const sh = (s: string) => {
        res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8" });
        res.end(s);
      };
      if (url.pathname === "/api/coders/install.sh") return sh(remoteInstallScript(kikiUrl()));
      if (url.pathname === "/api/coders/hook.sh") return sh(hookScript({ url: kikiUrl(), spool: "$HOME/.kiki/spool" }));
      if (url.pathname === "/api/coders/merge" && req.method === "POST") {
        // Another computer sends its config file over; Kiki merges it and sends it back (that machine doesn't need Node installed)
        const script = String(req.headers["x-kiki-script"] || "");
        if (!script.includes("kiki-hook")) return json({ error: "Missing x-kiki-script" }, 400);
        try {
          const cur = await text();
          const out = url.searchParams.get("target") === "codex" ? mergeCodex(cur, script) : { text: mergeClaude(cur, script) };
          if ("prev" in out && out.prev) return json({ error: "Codex on this computer already has another notify configured; left it untouched" }, 409);
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(out.text);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
    }
    if (url.pathname.startsWith("/api/postroom") && pr) {
      if (url.pathname === "/api/postroom") return json(pr.state());
      if (req.method !== "POST") return json({ error: "Use POST" }, 405);
      try {
        if (url.pathname === "/api/postroom/poll") await pr.poll();
        else if (url.pathname === "/api/postroom/send") {
          const b = await body();
          if (!String(b.text ?? "").trim()) return json({ error: "Empty message" }, 400);
          await pr.send(String(b.agent ?? ""), String(b.text), b.title ? String(b.title) : undefined, undefined, "user");
        } else if (url.pathname === "/api/postroom/dismiss") pr.dismiss(String((await body()).id ?? ""));
        else return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json(pr.state());
    }

    // Health check: after an auto-update swaps versions, this confirms the new version came up
    if (url.pathname === "/api/health") return json({ ok: true, version: VERSION });

    // Updates: GET for status, POST /api/update/check to check now, POST /api/update/apply to install now
    if (url.pathname.startsWith("/api/update") && opts.updater) {
      const u = opts.updater;
      if (url.pathname === "/api/update/log") return json({ lines: u.logTail(80) });
      if (url.pathname === "/api/update") {
        u.readReceipt(); // The receipt is written by swap.sh only after the new version comes up, so read it fresh for accuracy
        return json(u.state);
      }
      if (req.method !== "POST") return json({ error: "Use POST" }, 405);
      if (url.pathname === "/api/update/check") return json(await u.check());
      if (url.pathname === "/api/update/apply") {
        try {
          return json(await u.apply());
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }
    }

    // Cards: GET for ready-to-send cards and cards that need your click; POST /api/approvals/decide {id, decision: yes|no|always} (no on a ready-to-send card = undo)
    if (url.pathname === "/api/approvals" && opts.approvals) return json(opts.approvals.list());
    if (url.pathname === "/api/approvals/decide" && req.method === "POST" && opts.approvals) {
      const { id, decision } = await body();
      if (!["yes", "no", "always"].includes(decision)) return json({ error: "decision must be yes, no or always" }, 400);
      try {
        opts.approvals.decide(String(id), decision as Decision);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json({ ok: true });
    }

    // What Kiki did: GET recent risky actions it took automatically; POST /api/actions/undo {id} to undo
    if (url.pathname === "/api/actions" && opts.approvals) return json(opts.approvals.actions.list(Number(url.searchParams.get("limit")) || 50));
    if (url.pathname === "/api/actions/undo" && req.method === "POST" && opts.approvals) {
      const { id } = await body();
      try {
        return json({ ok: true, note: opts.approvals.actions.undo(String(id)) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    // Models: GET for the menu; POST /api/models/use {spec} to switch models (written back to .env, so it persists after restart)
    if (url.pathname === "/api/models") return json(await modelInfo());
    if (url.pathname === "/api/models/use" && req.method === "POST") {
      const { spec } = await body();
      if (typeof spec !== "string" || !/^[\w.-]+\/[\w.:/-]+$/.test(spec)) return json({ error: "Invalid model name" }, 400);
      try {
        await agents.useModel(spec);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      saveEnv("MODEL", spec);
      push("model", { current: spec });
      return json(await modelInfo());
    }
    // Per-purpose model config (modelroles.ts): GET shows what's selected for each purpose; POST {id, spec} to change it, empty spec means none
    if (url.pathname === "/api/models/roles") {
      if (req.method === "POST") {
        const { id, spec } = await body();
        const role = roleOf(String(id));
        const want = String(spec ?? "").trim();
        if (!role || !validSpec(want)) return json({ error: "Invalid purpose or model name" }, 400);
        if (want && !(await agents.modelChoices()).some((c) => c.spec === want)) return json({ error: "No such model, or you're not signed in to that provider yet" }, 400);
        saveEnv(role.env, want);
        if (role.id === "vision") agents.visionSpec = want;
        push("model", {});
      }
      return json({ roles: ROLES.map((r) => ({ ...r, spec: roleModel(r.id) ?? "" })), models: await agents.modelChoices() });
    }
    // Vision model: POST /api/models/vision {spec}
    if (url.pathname === "/api/models/vision" && req.method === "POST") {
      const { spec } = await body();
      const pick = (await agents.modelChoices()).find((c) => c.spec === spec && c.image);
      if (!pick) return json({ error: "This model can't see images, or you're not signed in" }, 400);
      agents.visionSpec = pick.spec;
      saveEnv("VISION_MODEL", pick.spec);
      push("model", { vision: pick.spec });
      return json(await modelInfo());
    }
    // Sign in with a ChatGPT subscription: start returns the sign-in URL; for remote code, paste back the URL after the redirect; cancel / logout
    if (url.pathname.startsWith("/api/models/chatgpt/") && req.method === "POST") {
      const action = url.pathname.slice("/api/models/chatgpt/".length);
      try {
        if (action === "start") await logins.start("openai", "oauth");
        else if (action === "code") await logins.answer(String((await body()).input ?? ""));
        else if (action === "cancel") logins.cancel();
        else if (action === "logout") await logins.logout("openai");
        else return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json(await modelInfo());
    }
    // Providers: GET the list; POST /api/models/login/start {provider, type: api_key|oauth}, answer {value}, cancel, logout {provider}
    if (url.pathname === "/api/models/providers") return json({ providers: await logins.providers(), login: logins.state });
    // Toggles and checkboxes in settings: GET /api/models/provider?id= to see that provider's models; POST /api/models/prefs {provider, on?, models?}
    if (url.pathname === "/api/models/provider") return json({ models: await agents.providerModels(url.searchParams.get("id") ?? "") });
    if (url.pathname === "/api/models/prefs" && req.method === "POST") {
      const b = await body();
      const id = String(b.provider ?? "");
      if (!(await logins.providers()).some((p) => p.id === id)) return json({ error: "No such provider" }, 400);
      if (typeof b.on === "boolean") setProviderOn(opts.dataDir, id, b.on);
      if (Array.isArray(b.models)) setProviderModels(opts.dataDir, id, b.models);
      push("model", {});
      return json({ providers: await logins.providers(), login: logins.state });
    }
    if (url.pathname.startsWith("/api/models/login/") && req.method === "POST") {
      const action = url.pathname.slice("/api/models/login/".length);
      const b = await body();
      try {
        if (action === "start") {
if (b.type !== "api_key" && b.type !== "oauth") return json({ error: "type must be api_key or oauth" }, 400);
          await logins.start(String(b.provider ?? ""), b.type);
        } else if (action === "answer") await logins.answer(String(b.value ?? ""));
        else if (action === "cancel") logins.cancel();
        else if (action === "logout") await logins.logout(String(b.provider ?? ""));
        else return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      push("model", {});
      return json({ providers: await logins.providers(), login: logins.state });
    }

    // Images: POST /api/image {data: data:URL} stores it and returns the marker to put in a message; GET /api/image/<name> views the image
    if (url.pathname === "/api/image" && req.method === "POST") {
      try {
        return json({ mark: saveImage(opts.dataDir, String((await body()).data ?? "")) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    if (url.pathname.startsWith("/api/image/")) {
      const name = url.pathname.slice("/api/image/".length);
      const f = join(uploadsDir(opts.dataDir), name);
      if (!validImageName(name) || !existsSync(f)) return json({ error: "No such image" }, 404);
      res.writeHead(200, { "content-type": imageMime(name), "cache-control": "private, max-age=31536000, immutable" });
      res.end(readFileSync(f));
      return;
    }

    if (url.pathname === "/api/history") {
      const path = url.searchParams.get("path") ?? MAIN;
      if (path === MAIN) return json(mainHistory());
      if (!registry.byPath(path)) return json({ error: "No such conversation" }, 404);
      return json(agents.history(path));
    }

    if (url.pathname === "/api/send" && req.method === "POST") {
      const { path, text } = await body();
      if (!text?.trim()) return json({ error: "Empty message" }, 400);
      if (path === MAIN) {
        // Main bot: hand it to the router, where commands and forwarding both live
        const ack = acks.add(MAIN, text);
        const sent = Date.now();
        mainSay("user", text, ack);
        json({ ok: true, ack });
        quickLine(ack, "Kiki, responsible for routing the user's business to the right bot", text);
        router
          .handle(CHAT_ID, text, async (r) => {
            const m = markForReply(r);
            if (m === "bg") acks.link(ack, tasksSince(CHAT_ID, sent)); // from here on, follow the status of these tasks
            else if (m !== undefined && !acks.get(ack)?.tasks) acks.set(ack, m);
            mainSay("assistant", r);
            push("tree", tree()); // /new, /bg and the like change the list
          })
          .catch((e) => {
            acks.set(ack, "error");
            mainSay("assistant", `Something went wrong: ${(e as Error).message}`);
          });
        return;
      }
      const rec = registry.byPath(path);
      if (!rec) return json({ error: "No such conversation" }, 404);
      // This conversation is a background task stuck waiting on your answer: hand the answer to the task so it can carry on and report back as usual when done
      const stuck = router.tasks.blockedBySession(path);
      const ack = acks.add(path, text, !stuck && agents.occupied(path));
      json({ ok: true, ack });
      push("message", { path, role: "user", text, ack });
      if (stuck) {
        const t = router.tasks.answer(stuck.id, text);
        if (t) acks.link(ack, [t]);
        return;
      }
      quickLine(ack, rec.name === MAIN_SESSION ? `${rec.agent} (${agents.describe(rec.agent) || "an assistant"})` : `${rec.agent}, discussing "${rec.name}"`, text);
      agents
        .send(rec.agent, rec.path, text, { onStart: () => acks.start(ack) })
        .then((r) => {
          acks.set(ack, null);
          push("message", { path, role: "assistant", text: r });
        })
        .catch((e) => {
          acks.set(ack, "error");
          push("message", { path, role: "assistant", text: `Something went wrong: ${(e as Error).message}` });
        });
      return;
    }

    // Buttons on the board: start now / cancel or stop / retry
    if (url.pathname.startsWith("/api/tasks/") && req.method === "POST") {
      const { id } = await body();
      const act = url.pathname.slice("/api/tasks/".length);
      const t =
        act === "run" ? router.tasks.runNow(id)
        : act === "cancel" || act === "stop" ? await router.tasks.stop(id)
        : act === "retry" ? router.tasks.retry(id)
        : undefined;
      if (!t) return json({ error: "This task can't do that right now" }, 400);
      return json(t);
    }

    if (url.pathname === "/api/new" && req.method === "POST") {
      const { agent, name } = await body();
      if (!agents.exists(agent)) return json({ error: `No agent ${agent}` }, 400);
      if (!name?.trim()) return json({ error: "It needs a name" }, 400);
      if (registry.get(agent, name.trim())) return json({ error: "That name is already taken" }, 400);
      const rec = await router.newSession(agent, name.trim());
      push("tree", tree());
      return json(rec);
    }

    // Delete a thread / clear the main chat: records are moved into data folder/trash/, never really deleted
    // Work: you re-categorize by hand. merge {agent, from, into} merges; detach {agent, id, path} moves a conversation out; set {agent, id, status?, title?}
    if (url.pathname.startsWith("/api/work/") && req.method === "POST" && opts.works) {
      const b = await body(), act = url.pathname.slice("/api/work/".length), agent = String(b.agent ?? "");
      if (!agents.exists(agent)) return json({ error: "No such bot" }, 400);
      const w =
        act === "merge" ? opts.works.merge(agent, String(b.from), String(b.into))
        : act === "detach" ? opts.works.detach(agent, String(b.id), String(b.path))
        : act === "set" ? opts.works.set(agent, String(b.id), { status: b.status, title: b.title })
        : undefined;
      if (!w) return json({ error: "Couldn't find that work item" }, 400);
      push("tree", tree());
      return json({ ok: true, work: w });
    }
    if (url.pathname === "/api/delete" && req.method === "POST") {
      const { path } = await body();
      const gone = registry.byPath(String(path));
      try {
        await router.deleteSession(String(path));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      if (gone) opts.works?.forget(gone.agent, gone.path);
      push("tree", tree());
      return json({ ok: true });
    }
    if (url.pathname === "/api/clear" && req.method === "POST") {
      const { path } = await body();
      if (path === MAIN) {
        // Kiki's own chat log: move the whole file away, start from a blank slate next time
        if (existsSync(mainLog)) {
          const dir = join(opts.dataDir, "trash", "Kiki inbox");
          mkdirSync(dir, { recursive: true });
          renameSync(mainLog, join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-main.jsonl`));
        }
        push("cleared", { path: MAIN });
        return json({ ok: true });
      }
      let fresh: string;
      try {
        fresh = (await router.clearMain(String(path))).path;
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      const rec = registry.byPath(fresh);
      if (rec) opts.works?.repoint(rec.agent, String(path), fresh);
      push("tree", tree());
      push("cleared", { path, fresh });
      return json({ ok: true, path: fresh });
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    json({ error: "not found" }, 404);
  }

  const server = createServer((req, res) => {
    const denied = rejectReason(req);
    if (denied) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Kiki rejected this request: ${denied}`);
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      api(req, res, url).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      });
      return;
    }
    // Icons and manifest for installing as an app; every other path serves that one page
    const asset = STATIC[url.pathname];
    if (asset) {
      res.writeHead(200, { "content-type": asset });
      res.end(readFileSync(join(opts.publicDir, url.pathname.slice(1))));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(opts.publicDir, "index.html")));
  });

  // Tasks started on a schedule, after a restart, or recorded by an agent with a tool report to the inbox when done or stuck
  router.tasks.defaultNotify = (t) => {
    const msg = router.notice(t);
    if (msg) mainSay("assistant", msg);
  };
  // Background tasks left unfinished when we last quit: mark them interrupted and say so in the inbox
  const lost = router.tasks.recover();
  if (lost.length)
    mainSay(
      "assistant",
      `When Kiki shut down last time, ${lost.length} background tasks were left unfinished:\n${lost.map((t) => `- "${t.title}" /retry ${t.id}`).join("\n")}`,
    );

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`Kiki is up: http://localhost:${opts.port}  (data folder ${opts.dataDir})`);
  });
  if (process.env.KIKI_TAILSCALE_LISTEN !== "0") listenOnTailscale(server, opts.port);
  return server;
}

/** IPv4 addresses on this machine's network interfaces that fall in the Tailscale range (100.64.0.0/10). Carriers' CGNAT can hand out this range too, so treat them only as candidates. */
export function candidateAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && tailscaleIp(a.address))
    .map((a) => a!.address);
}

const TAILSCALE_BINS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
];

/** This machine's Tailscale addresses (for "connect from another computer") */
async function tailscaleOwnedIps(): Promise<string[]> {
  const owned = await tailscaleOwned();
  return candidateAddresses().filter((ip) => owned.has(ip));
}

/** Ask Tailscale itself which IPv4 addresses it assigned to this machine. If Tailscale isn't found or won't answer, return empty (better not to open at all). */
async function tailscaleOwned(): Promise<Set<string>> {
  for (const bin of TAILSCALE_BINS) {
    if (!existsSync(bin)) continue;
    try {
      const { stdout } = await run(bin, ["ip", "-4"], { timeout: 5000 });
      return new Set(stdout.split(/\s+/).filter((ip) => tailscaleIp(ip)));
    } catch {
      /* try the next one */
    }
  }
  return new Set();
}

/**
 * Open another door on the same port at Tailscale's IP, so other devices can connect by entering 100.x.x.x:port directly.
 * Only opens on addresses Tailscale itself confirms it assigned (100.64/10 can also be a carrier's CGNAT),
 * so neither the LAN nor the public internet can reach it; incoming requests go through the same guard as local ones.
 * Tailscale may come up after Kiki, so check once a minute. Set KIKI_TAILSCALE_LISTEN=0 to turn it off.
 */
function listenOnTailscale(main: ReturnType<typeof createServer>, port: number) {
  const open = new Map<string, ReturnType<typeof createServer>>();
  const failed = new Set<string>(); // don't retry ones that won't open every minute and spam the log
  const scan = async () => {
    const local = candidateAddresses().filter((ip) => !open.has(ip) && !failed.has(ip));
    if (!local.length) return;
    const owned = await tailscaleOwned();
    for (const ip of local) {
      if (!owned.has(ip) || open.has(ip)) continue;
      const s = createServer((req, res) => main.emit("request", req, res));
      open.set(ip, s);
      s.on("error", (e) => {
        console.warn(`Couldn't open Tailscale address ${ip}:${port}: ${(e as Error).message}`);
        open.delete(ip);
        failed.add(ip);
        s.close();
      });
      s.listen(port, ip, () => console.log(`Reachable remotely: http://${ip}:${port} (Tailscale network)`));
    }
  };
  void scan();
  setInterval(() => void scan(), 60_000).unref();
  main.on("close", () => {
    for (const s of open.values()) s.close();
  });
}
