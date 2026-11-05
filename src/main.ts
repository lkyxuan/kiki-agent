// Entry point: read config, wire up the web UI, router, and pi.
import { cpSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { FIRST_LINE_RULE } from "./ack.js";
import { AUTONOMY_RULE } from "./autonomy.js";
import { Agents } from "./agents.js";
import { roleModel } from "./modelroles.js";
import { Approvals } from "./approval.js";
import { handoffTool } from "./handoff.js";
import { loadRules } from "./rules.js";
import { kikiTools } from "./tools.js";
import { lookTool } from "./look.js";
import { type FeatureId, isOn } from "./features.js";
import { Summaries } from "./summary.js";
import { WorkBook, WorkSorter } from "./work.js";
import { MAIN_SESSION } from "./bao.js";
import { addRuleSections, addSetupBao, DEFAULT_BAO, SETUP_BAO, dropConfirmLine, migrateToQiqi, upgradeQiqiNote } from "./migrate.js";
import { Coders } from "./coders.js";
import { CoderSetup } from "./coders-setup.js";
import { Registry } from "./registry.js";
import { Router } from "./router.js";
import { ADAPTERS, Postroom, postroomTool } from "./postroom.js";
import { A2AAgent } from "./a2a.js";
import { AcpAgent } from "./acp.js";
import { WatchAgent } from "./watch.js";
import { Notifier } from "./notify.js";
import { makeTriage, watchForTask, Watchlist } from "./triage.js";
import { startServer } from "./server.js";
import { FileTaskStore, taskPrompt } from "./tasks.js";
import { BRIEFING, briefing, ensureBriefing } from "./briefing.js";
import { taskTools, type WatchList } from "./tasktool.js";
import { Updater, VERSION } from "./update.js";

// The auto-updater runs --selftest before installing a new version: getting here means Node and all the code loaded successfully
if (process.argv.includes("--selftest")) {
  console.log(`kiki ${VERSION} ok`);
  process.exit(0);
}

process.title = "Kiki"; // show Kiki in Activity Monitor instead of node

// Read .env: first the current directory (the repo directory under npm start), then the data folder (Kiki.app uses this).
// Existing environment variables take precedence and are not overwritten (e.g. keys injected by op run).
function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv(".env");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve((process.env.DATA_DIR || "~/Kiki").replace(/^~/, homedir()));
loadEnv(join(dataDir, ".env"));
if (!existsSync(dataDir)) {
  // First launch: copy the template (About me + the default bot "Kiki" + routing rules)
  cpSync(join(root, "data-template"), dataDir, { recursive: true });
  console.log(`Data folder created at ${dataDir}. Remember to edit AGENTS.md (About me).`);
}
// Upgrading an old data folder: keep only Kiki as the default bot, move the old dev, life into archive/ (not deleted)
for (const line of [...migrateToQiqi(dataDir, join(root, "data-template")), ...upgradeQiqiNote(dataDir, join(root, "data-template")), ...addRuleSections(dataDir, join(root, "data-template")), ...dropConfirmLine(dataDir), ...addSetupBao(dataDir, join(root, "data-template"))])
  console.log(`Upgrading data folder: ${line}`);

const agents = new Agents(dataDir, process.env.MODEL || "deepseek/deepseek-flash");
// Approvals: the system catches dangerous actions, logs each one so it can be undone, and only asks you when over budget (see approval.ts)
const approvals = new Approvals(dataDir);
agents.extensions.push(approvals.extension());
// Each background task gets its own subprocess (see workerhost.ts): a crash doesn't take others down, and stopping a task just shuts it down. TASK_ISOLATION=0 runs them in the main process again
if (process.env.TASK_ISOLATION !== "0") {
  const here = fileURLToPath(import.meta.url);
  agents.isolation = {
    script: join(dirname(here), `worker${here.endsWith(".ts") ? ".ts" : ".js"}`),
    approve: (r, signal) => approvals.check(r.toolName, r.input, r.cwd, r.path, signal, r.turn),
  };
}
// Bot skills: Kiki's built-in ones (bao-skills/<bot name>/, updated with Kiki) + skills/ in the bot's own folder
agents.skillPaths = (a) => [join(root, "bao-skills", a), join(agents.agentDir(a), "skills")];
const registry = new Registry(join(dataDir, "registry.json"));
// Background tasks: one Markdown file per task, under tasks/ in the data folder
// Default bot: if the one in .env no longer exists (e.g. the old life was archived), fall back to Kiki
const defaultBao = process.env.DEFAULT_AGENT && agents.exists(process.env.DEFAULT_AGENT) ? process.env.DEFAULT_AGENT : DEFAULT_BAO;
const router = new Router(agents, registry, defaultBao, new FileTaskStore(join(dataDir, "tasks")), {
  concurrency: Number(process.env.TASK_CONCURRENCY || 2),
  timeoutMs: Number(process.env.TASK_TIMEOUT_MIN || 30) * 60_000,
});
// An agent in a conversation can hand a new piece of work off to a new conversation (writing the handoff note itself)
router.rules = () => loadRules(dataDir);
const TOOL_FEATURE: Record<string, FeatureId> = {
  kiki_handoff: "handoff",
  kiki_peek: "peek",
  kiki_relay: "relay",
  kiki_remember: "remember",
  kiki_task: "schedule",
  kiki_ask_user: "background",
  kiki_outside: "postroom",
  kiki_watch: "background",
};
// Watchlist (assigned once the Mailroom is wired up, one per bot, under agents/<bot>/): things to keep an eye on after a task finishes; when a related new message arrives, the Mailroom calls router.tasks.followUp(task id, message)
let watchList: WatchList | undefined;
// One-line summary per conversation: updated in the background after replying (summary in registry.json); routing and the main chat only look at summaries
// Work: the right column groups by "what the bot is doing". Once the summary is written, the "work grouping" role files the conversation into a work on behalf of the bot's main chat (see work.ts)
const works = new WorkBook((a) => agents.agentDir(a));
const sorter = new WorkSorter({
  book: works,
  thread: (p) => registry.byPath(p),
  history: (p) => agents.history(p),
  complete: (sys, user) => agents.complete(sys, user, roleModel("work") ?? roleModel("summary")),
  skip: (p) => !!registry.byPath(p)?.background, // background task conversations aren't grouped separately; the task hangs under the work of the conversation that started it
});
const summaries = new Summaries({
  registry,
  history: (p) => agents.history(p),
  complete: (sys, user) => agents.complete(sys, user, roleModel("summary")),
  after: (p) => void sorter.run(p),
});
agents.on("busy", ({ path, busy }: { path: string; busy: boolean }) => {
  if (!busy) summaries.schedule(path);
});
// Every conversation carries the "ack the user first" rule (say one line showing you understand before doing the work, see ack.ts);
// the bot's main chat also automatically sees a digest of this bot's threads each turn, so it doesn't have to remember to go look
agents.extensions.push((pi) => {
  pi.on("before_agent_start", (ev, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    const rec = file ? registry.byPath(file) : undefined;
    // Main chat additionally gets: a digest of this bot's threads, and a line with the background task count (Kiki sees all, other bots see their own)
    const all = rec?.agent === DEFAULT_BAO ? undefined : rec?.agent;
    const digest = rec?.name === MAIN_SESSION ? [router.threadDigest(rec.agent), router.taskCount(all), coders.digest(all)].filter(Boolean).join("\n\n") : "";
    return { systemPrompt: [ev.systemPrompt, FIRST_LINE_RULE, AUTONOMY_RULE, digest].filter(Boolean).join("\n\n") };
  });
});
router.isOn = (id) => isOn(dataDir, id);
// Claude Code and Codex you open in the terminal: status reported in by hooks (see coders.ts), grouped under a bot by project folder
const port = Number(process.env.PORT || 4567);
const coders = new Coders({
  dataDir,
  listBaos: () => agents.listAgents().filter((b) => b !== SETUP_BAO), // the Butler manages Kiki itself and doesn't take on your projects
  defaultBao,
  pickBao: async (repo, cwd, prompt) => {
    const baos = agents.listAgents().filter((b) => b !== SETUP_BAO);
    const list = baos.map((b) => `- ${b}: ${agents.describe(b)}`).join("\n");
    const r = await agents.complete(
      "The user is working on a project in the terminal with a coding agent. Below are the user's bots (each handles one area). Pick the bot that should own this project, and output only the bot's name; if none fit, output none.",
      `Project folder: ${cwd}\nFirst request: ${prompt.slice(0, 200)}\n\nBots:\n${list}`,
      roleModel("route"),
    );
    return baos.find((b) => r.trim().startsWith(b));
  },
  summarize: (prompt, result) =>
    agents.complete("Compress the coding agent's final answer for this turn into one sentence of at most 30 words, saying clearly what got done or where it got stuck. Output only that sentence.", `Request: ${prompt.slice(0, 300)}\n\nAnswer: ${result.slice(0, 2000)}`, roleModel("summary")),
});
const coderSetup = new CoderSetup({ dataDir, port });
void coders.drainSpool().catch(() => {}); // pick up what hooks recorded while Kiki was closed
// Mailroom: periodically sends and receives with external agents (see postroom.ts). How received items are handed to Kiki and written back to the conversation is wired up in server.ts
const postroom = new Postroom({
  dataDir,
  intervalMs: Number(process.env.POSTROOM_POLL_SEC || 60) * 1000,
  isOn: () => isOn(dataDir, "postroom"),
});
// Mailroom adapters: mailbox (built into postroom.ts), A2A (connect your own bots), ACP (connect Claude Code / Codex), watch (web / RSS / files)
Object.assign(ADAPTERS, {
  a2a: (cfg, ctx) => new A2AAgent(cfg.name, cfg, ctx),
  acp: (cfg, ctx) => new AcpAgent(cfg.name, cfg, ctx),
  watch: (cfg, ctx) => new WatchAgent(cfg.name, cfg, ctx),
} satisfies typeof ADAPTERS);
// External agents doing dangerous actions: go through the same safety net as their own conversations (backup first, ready to send, budget); the card that needs stopping hangs on the conversation that assigned the work
postroom.approve = async (req) => {
  const rec = req.origin ? registry.byPath(req.origin) : undefined;
  const r = await approvals.gate(req, { agent: rec?.agent ?? DEFAULT_BAO, path: req.origin ?? "", detail: req.detail, command: req.command, cwd: req.cwd });
  return r.ok;
};
// Kiki reads the mail: each new message is first read by a cheap model to decide whether to notify, whether to hand it to a bot, and to maintain watchlist.md along the way
postroom.triage = makeTriage({
  dataDir,
  listBaos: () => agents.listAgents(),
  describe: (b) => agents.describe(b),
  complete: (sys, user) => agents.complete(sys, user, process.env.TRIAGE_MODEL || process.env.SUMMARY_MODEL || undefined),
});
// Notification channel: things you need to know go out from here. For now only the Kiki UI (wired up in server.ts); future Telegram, WeChat plugins hook in here too
const notifier = new Notifier();
// Wire the Mailroom to tasks: tasks assigned to an external agent are handled by the Mailroom; things to keep watching after a task finishes go into the bot's watchlist; related new messages are handed back to that task
router.tasks.executorFor = (name) =>
  postroom.configs().some((c) => c.name === name)
    ? { run: (t, signal) => postroom.run(name, taskPrompt(t), { title: t.title, origin: t.origin, from: t.reportTo ?? t.origin, signal }) }
    : undefined;
watchList = {
  add: (w) => {
    watchForTask(dataDir, { taskId: w.taskId, agent: w.agent, about: w.until ? `${w.about} (watch until ${w.until})` : w.about, match: w.match, session: w.session });
    return `Added to ${w.agent}'s watchlist: ${w.about}`;
  },
  remove: (id, agent) => {
    new Watchlist(dataDir, agent).removeByTask(id);
  },
};
postroom.followTask = async (id, text) => router.tasks.followUp(id, text);
// A task was cancelled, so remove what it was watching from the watchlist too
router.tasks.on("update", (t) => {
  if (t.status === "cancelled" && t.watching) void Promise.resolve(watchList?.remove(t.id, t.agent)).catch(() => {});
});
// Features turned off in settings aren't given to agents (takes effect for newly opened conversations)
agents.toolsFor = () =>
  [
    handoffTool({ listBaos: () => agents.listAgents(), describe: (b) => agents.describe(b), rules: router.rules, onHandoff: (r) => router.handoff(r) }),
    ...kikiTools({ host: router, dataDir, listBaos: () => agents.listAgents() }),
    lookTool((name, q) => agents.look(name, q)), // models that can't see images get another look at the image
    postroomTool(postroom, (p) => {
      const r = p ? registry.byPath(p) : undefined;
      return r && `${r.agent}/${r.name}`;
    }),
    // To-dos, scheduled tasks, wait for something to finish before continuing; when a background task is stuck, stop and ask the user
    ...taskTools({ tasks: router.tasks, listBaos: () => agents.listAgents(), baoOf: (p) => (p ? registry.byPath(p)?.agent : undefined), watch: () => watchList }),
  ].filter((t) => !TOOL_FEATURE[t.name] || isOn(dataDir, TOOL_FEATURE[t.name]));

// One main chat per bot; older conversations all become threads. Done after extensions and tools are wired up, so main chats created at startup carry them too
void router.ensureMains().catch((e) => console.warn("Failed to create main chats: ", (e as Error).message)); // one main chat per bot; older conversations all become threads

const updater = new Updater({
  dataDir,
  port,
  // Only auto-install when no conversation is running, so work isn't interrupted; when not idle, say clearly who's blocking, written to the update log
  whyBusy: () => {
    const s = registry.list().find((s) => agents.isBusy(s.path));
    if (s) return `Conversation "${s.agent}/${s.name}" is still running`;
    const t = router.tasks.list((t) => t.status === "queued" || t.status === "running")[0];
    if (t) return `Background task "${t.title}" isn't done yet (${t.status === "queued" ? "queued" : "running"})`;
    if (approvals.list().length) return "A card is waiting on you"; // restarting now would lose that step
    return undefined;
  },
});
updater.start();

// Daily briefing: Kiki acts as the executor itself, computing the body from the task ledger (must be registered before the server starts, so a briefing that came due while shut down is sent at startup)
router.tasks.registerExecutor(BRIEFING, { run: async () => briefing(router.tasks.list(), new Date(), { approvals: approvals.list().length, coders: coders.briefingLines() }) });

startServer({
  works,
  port,
  dataDir,
  publicDir: join(root, "public"),
  agents,
  registry,
  router,
  updater,
  approvals,
  postroom,
  notifier,
  coders,
  coderSetup,
});
postroom.start();
// Create the "daily briefing" scheduled task on first launch (BRIEFING_TIME changes the time, BRIEFING=0 skips it; once cancelled in the board it won't be recreated)
if (process.env.BRIEFING !== "0") ensureBriefing(router.tasks, { agent: DEFAULT_BAO, at: process.env.BRIEFING_TIME });
