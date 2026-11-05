// The pi layer: open a conversation, continue a conversation, send a line into a conversation and get the answer.
// Each agent is a folder at DATA_DIR/agents/<name>/, and the AGENTS.md inside it is its description;
// DATA_DIR/AGENTS.md (About me) is in the parent directory, and pi reads it in automatically.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type AgentSession,
  type ExtensionFactory,
  type ToolDefinition,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type Live, type Step, describeTool, stepsFromMessages } from "./activity.js";
import { baoFile, createBao } from "./bao.js";
import { explainError } from "./errors.js";
import { existsSync as fileExists, readFileSync as readText, writeFileSync as writeText } from "node:fs";
import { pickedIds, readPrefs } from "./modelprefs.js";
import { imageNames, imageNote, readImage, uploadsDir } from "./images.js";
import { type OpenSpec, type ToolMeta, Worker, type WorkerHooks } from "./workerhost.js";

/** One entry in the model menu */
export interface ModelChoice {
  spec: string; // provider/model
  name: string;
  image: boolean; // whether it can see images
  provider: string;
  providerName?: string;
}

/**
 * pi's model table says it can see images, but Kiki treats it as a text-only provider.
 * Sending images through DeepSeek's official API errors out; treating it as text-only means that when you switch back to DeepSeek,
 * images from earlier in the conversation get replaced by pi with a line saying "there's an image here", so the conversation doesn't break.
 */
const TEXT_ONLY = new Set(["deepseek"]);
/** Providers kept out of the model menu: openai-codex is the old entry point, superseded by openai's ChatGPT login. */
const MENU_SKIP = new Set(["openai-codex"]);

export interface ChatLine {
  role: "user" | "assistant";
  text: string;
  steps?: Step[]; // tools used before this answer (shown collapsed on the web page)
}

/**
 * Events: delta {path, text} streamed text; busy {path, busy} starts/stops working;
 * activity {path, live} this turn's progress (thinking / which tool is being called / steps taken), live null means done.
 * The web page uses these to refresh in real time.
 */
export class Agents extends EventEmitter {
  private runtime: Promise<ModelRuntime>;
  /** Kiki's own pi config directory (settings, keys, models, extensions, skills), completely separate from a user-installed pi (~/.pi). */
  readonly engineDir: string;
  /** Extra tools Kiki provides to agents in conversations (e.g. handoff), injected by main.ts. */
  toolsFor?: (agent: string) => ToolDefinition[];
  /** Kiki's own pi extensions (e.g. approvals), injected by main.ts. */
  extensions: ExtensionFactory[] = [];
  /** A bot's extra skill folders (Kiki's built-in bot skills, the bot's own skills/), injected by main.ts. Passed via SDK arguments, bypassing pi's "project trust" */
  skillPaths?: (agent: string) => string[];
  private live = new Map<string, AgentSession>(); // path -> open conversations
  private queues = new Map<string, Promise<unknown>>(); // path -> queue, one line at a time per conversation
  private inflight = new Map<string, number>(); // path -> number of sends not yet answered (including the one being answered)
  private runs = new Map<string, Live>(); // path -> progress of the turn currently working
  private gone = new Set<string>(); // deleted / cleared conversations: messages queued behind them no longer run
  private labelCache?: Record<string, string>;
  /** Each background task gets its own subprocess: when set, spawnTask / sendTask run in a subprocess (injected by main.ts). */
  isolation?: {
    script: string;
    approve: WorkerHooks["approve"];
    execArgv?: string[];
  };
  private remote = new Map<string, Worker>(); // path -> subprocess currently running this conversation

  constructor(
    private dataDir: string,
    private modelSpec: string, // "provider/model", e.g. deepseek/deepseek-flash; can be changed in the model menu
  ) {
    super();
    this.engineDir = join(dataDir, "engine");
    mkdirSync(this.engineDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = this.engineDir; // fallback: anywhere inside pi that looks up the default directory lands here
    this.runtime = ModelRuntime.create({
      authPath: join(this.engineDir, "auth.json"),
      modelsPath: join(this.engineDir, "models.json"),
    });
  }

  agentDir(agent: string) {
    return join(this.dataDir, "agents", agent);
  }

  listAgents(): string[] {
    const root = join(this.dataDir, "agents");
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
  }

  /** Create a new bot (when auto-routing finds no suitable bot). */
  createBao(name: string, duty: string) {
    createBao(this.dataDir, name, duty);
  }

  exists(agent: string) {
    return existsSync(this.agentDir(agent));
  }

  private async model(spec = this.modelSpec) {
    const [provider, ...rest] = spec.split("/");
    const m = (await this.runtime).getModel(provider, rest.join("/"));
    if (!m) throw new Error(`Model not found: ${spec}`);
    return TEXT_ONLY.has(m.provider) ? { ...m, input: m.input.filter((x) => x !== "image") } : m;
  }

  /** Vision model (.env's VISION_MODEL): when the current model can't see images, have it read the image into text first. If unset, pick one that can see images automatically. */
  visionSpec = process.env.VISION_MODEL || "";

  /** The model actually used for vision right now; undefined if none can see images (e.g. not logged in to ChatGPT yet). */
  async visionChoice(list?: ModelChoice[]): Promise<ModelChoice | undefined> {
    const seeing = (list ?? (await this.modelChoices())).filter((c) => c.image);
    return seeing.find((c) => c.spec === this.visionSpec) ?? seeing.find((c) => c.provider === "openai") ?? seeing[0];
  }

  /** Whether the current model can see images directly */
  async canSee(): Promise<boolean> {
    try {
      return (await this.model()).input.includes("image");
    } catch {
      return false;
    }
  }

  /** Have the vision model look at an image and answer question. */
  async look(name: string, question: string): Promise<string> {
    const img = readImage(this.dataDir, name);
    if (!img) throw new Error(`No such image: ${name}`);
    const v = await this.visionChoice();
    if (!v) throw new Error("No vision model available right now: log in with a ChatGPT subscription in the model menu next to the input box");
    const rt = await this.runtime;
    const msg: any = await rt.completeSimple(await this.model(v.spec), {
      messages: [{ role: "user", content: [{ type: "text", text: question }, img], timestamp: Date.now() } as any],
    });
    if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "Vision model error");
    return (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  }

  /** Read an image into a full text description (stored at uploads/<name>.txt, each image read only once). */
  private async describeImage(name: string): Promise<{ text: string; by: string }> {
    const cache = join(uploadsDir(this.dataDir), `${name}.txt`);
    const v = await this.visionChoice();
    if (fileExists(cache)) return { text: readText(cache, "utf8"), by: v?.name ?? "vision model" };
    if (!v) return { text: "(couldn't read it: no vision model available right now, please log in with a ChatGPT subscription in the model menu)", by: "Kiki" };
    try {
      const text = await this.look(
        name,
        "Write down everything visible in this image completely and in detail, in English. Include all text (copy it verbatim), code, UI, data and tables, objects, people, layout, colors and any other notable details. Only write what you see, don't guess.",
      );
      writeText(cache, text);
      return { text, by: v.name };
    } catch (e) {
      return { text: `(couldn't read it: ${(e as Error).message})`, by: v.name };
    }
  }

  /** pi's model runtime (used for ChatGPT login). */
  modelRuntime(): Promise<ModelRuntime> {
    return this.runtime;
  }

  /** The model in use right now */
  get currentModel() {
    return this.modelSpec;
  }

  /** Model menu: models already usable (have a key or are logged in), plus the one in use. */
  async modelChoices(): Promise<ModelChoice[]> {
    const rt = await this.runtime;
    const codex = new Set(rt.getModels("openai-codex").map((m) => m.id)); // the ones a ChatGPT subscription can use
    const list: ModelChoice[] = [];
    // Models from every provider already configured (key filled in or logged in)
    let avail: readonly any[] = [];
    try {
      avail = await rt.getAvailable();
    } catch {}
    // Providers turned off in settings aren't listed; each provider lists only its checked models (see modelprefs.ts)
    const prefs = readPrefs(this.dataDir);
    const usable = avail.filter(
      (m) => !MENU_SKIP.has(m.provider) && !(m.provider === "openai" && rt.isUsingOAuth("openai") && !codex.has(m.id)), // a ChatGPT subscription lists only the Codex ones
    );
    const byProvider = new Map<string, string[]>();
    for (const m of usable) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m.id]);
    const picked = new Map([...byProvider].map(([p, ids]) => [p, pickedIds(prefs, p, ids)]));
    for (const m of usable) {
      if (prefs.off.includes(m.provider)) continue;
      if (!picked.get(m.provider)!.has(m.id)) continue;
      list.push(this.choice(m));
    }
    const name = (id: string) => (rt.getProvider(id) as any)?.name ?? id;
    for (const c of list) c.providerName = name(c.provider);
    if (!list.some((c) => c.spec === this.modelSpec)) {
      try {
        list.unshift(this.choice(await this.model()));
      } catch {}
    }
    return list;
  }

  /** For the settings page: all models a provider offers, marking which are checked into the menu. */
  async providerModels(provider: string): Promise<(ModelChoice & { checked: boolean })[]> {
    const rt = await this.runtime;
    const codex = new Set(rt.getModels("openai-codex").map((m) => m.id));
    const ms = rt.getModels(provider).filter((m) => !(provider === "openai" && rt.isUsingOAuth("openai") && !codex.has(m.id)));
    const picked = pickedIds(readPrefs(this.dataDir), provider, ms.map((m) => m.id));
    return ms.map((m) => ({ ...this.choice(m), checked: picked.has(m.id) }));
  }

  private choice(m: any): ModelChoice {
    return {
      spec: `${m.provider}/${m.id}`,
      name: m.name ?? m.id,
      image: !TEXT_ONLY.has(m.provider) && m.input.includes("image"),
      provider: m.provider,
    };
  }

  /** Switch models: all conversations from now on (including already-open ones) use it. Errors if not logged in / no key. */
  async useModel(spec: string) {
    const m = await this.model(spec);
    const rt = await this.runtime;
    if (!(await rt.checkAuth(m.provider))) throw new Error(`${m.provider} is not logged in or has no API key`);
    this.modelSpec = spec;
    for (const s of this.live.values()) await s.setModel(m as any);
  }

  private async open(agent: string, sm: SessionManager): Promise<AgentSession> {
    const cwd = this.agentDir(agent);
    const settingsManager = SettingsManager.create(cwd, this.engineDir);
    // Sessions embedded via the SDK don't include MCP by default, so add it yourself (same as the pi CLI):
    // MCP reads engine/mcp.json (that's what the settings page's "MCP servers" edits); codemode and tool_search are normally off,
    // and the MCP extension only turns them on when a server is set to codemode / deferred mode.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.engineDir,
      settingsManager,
      additionalSkillPaths: (this.skillPaths?.(agent) ?? []).filter((p) => existsSync(p)),
      extensionFactories: [...this.extensions, createCodemodeExtension(), createToolSearchExtension(), createMcpExtension()],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.engineDir,
      resourceLoader,
      settingsManager,
      sessionManager: sm,
      model: await this.model(),
      thinkingLevel: "off",
      modelRuntime: await this.runtime,
      customTools: this.toolsFor?.(agent) ?? [],
    });
    // Emit session_start: the MCP extension connects to servers then (in the background, without blocking the conversation)
    await session.bindExtensions({});
    return session;
  }

  /** English names for Kiki's own tools (kiki_peek → peek at other conversations), shown in progress. */
  private labels(): Record<string, string> {
    return (this.labelCache ??= Object.fromEntries((this.toolsFor?.("") ?? []).map((t) => [t.name, t.label])));
  }

  /** This turn's progress for a conversation currently working; undefined if not working. */
  progress(path: string): Live | undefined {
    return this.remote.get(path)?.live ?? this.runs.get(path);
  }

  private watch(path: string, s: AgentSession) {
    const show = (status?: string) => {
      const run = this.runs.get(path);
      if (!run) return;
      if (status !== undefined) {
        if (status === run.status) return; // unchanged, no need to push
        run.status = status;
      }
      this.emit("activity", { path, live: run });
    };
    s.subscribe((ev: any) => {
      switch (ev.type) {
        case "agent_start":
          // Automatic retries emit agent_start again: keep using the previous progress, don't clear the steps already taken
          if (!this.runs.has(path)) this.runs.set(path, { since: Date.now(), status: "Thinking…", steps: [] });
          this.emit("busy", { path, busy: true });
          show();
          break;
        case "agent_end":
          if (ev.willRetry) break; // about to retry, don't say it's done yet
          this.runs.delete(path);
          this.emit("activity", { path, live: null });
          this.emit("busy", { path, busy: false });
          break;
        case "turn_start":
          show("Thinking…");
          break;
        case "message_update": {
          const t = ev.assistantMessageEvent?.type;
          if (t === "text_delta") this.emit("delta", { path, text: ev.assistantMessageEvent.delta });
          else if (t === "text_start") show("Answering…");
          else if (t === "thinking_start") show("Thinking…");
          else if (t === "toolcall_start") show("Preparing the next step…");
          break;
        }
        case "tool_execution_start": {
const run = this.runs.get(path);
          if (!run || ev.parentToolCallId) break; // tools called from within a tool aren't listed separately
          const d = describeTool(ev.toolName, ev.args, this.labels());
          run.steps.push({ id: ev.toolCallId, ...d, status: "running" });
          if (run.steps.length > 50) run.steps.splice(0, run.steps.length - 50); // keep only the last 50 steps
          show(`${d.title}…`);
          break;
        }
        case "tool_execution_end": {
          const run = this.runs.get(path);
          const step = run?.steps.find((x) => x.id === ev.toolCallId);
          if (!run || !step) break;
          step.status = ev.isError ? "error" : "done";
          step.ms = ev.durationMs;
          const still = run.steps.find((x) => x.status === "running");
          run.status = still ? `${still.title}…` : "Thinking…";
          show();
          break;
        }
        case "auto_retry_start":
          show(`The model didn't respond, retrying in ${Math.max(1, Math.round(ev.delayMs / 1000))} seconds (attempt ${ev.attempt}/${ev.maxAttempts})…`);
          break;
        case "compaction_start":
          show("The conversation is too long, tidying up the earlier content…");
          break;
        case "compaction_end":
          show("Thinking…");
          break;
      }
    });
  }

  /** Create a new named conversation and return its JSONL path (the file is only actually written once there's a first reply). */
  async create(agent: string, name: string): Promise<string> {
    const sessionsDir = join(this.agentDir(agent), "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const session = await this.open(agent, SessionManager.create(this.agentDir(agent), sessionsDir));
    session.setSessionName(name);
    const path = session.sessionFile;
    if (!path) throw new Error("pi did not provide a conversation file path");
    this.live.set(path, session);
    this.watch(path, session);
    return path;
  }

  /** Fork a new conversation from an existing one (carrying all of the original's context), used when continuing work in the background. */
  async fork(agent: string, fromPath: string, name: string): Promise<string> {
    const dir = this.agentDir(agent);
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    await this.queues.get(fromPath)?.catch(() => {}); // wait for the original conversation to finish its current turn, so we don't fork mid-way
    const session = await this.open(agent, SessionManager.forkFrom(fromPath, dir, sessionsDir));
    session.setSessionName(name);
    const path = session.sessionFile;
    if (!path) throw new Error("pi did not provide a conversation file path");
    this.live.set(path, session);
    this.watch(path, session);
    return path;
  }

  private async get(agent: string, path: string): Promise<AgentSession> {
    if (this.gone.has(path)) throw new Error("This conversation has been deleted");
    if (this.remote.has(path)) throw new Error("This conversation is running in a background subprocess"); // only one process may write to a given file
    let s = this.live.get(path);
    if (!s) {
      s = await this.open(agent, SessionManager.open(path));
      this.live.set(path, s);
      this.watch(path, s);
    }
    return s;
  }

  /** Send a message to the given conversation, wait for it to finish, and return the text of the last reply. Messages in the same conversation are queued in order. */
  send(agent: string, path: string, text: string, opts: { onStart?: () => void } = {}): Promise<string> {
    const prev = this.queues.get(path) ?? Promise.resolve();
    this.inflight.set(path, (this.inflight.get(path) ?? 0) + 1);
    const run: Promise<string> = prev.catch(() => {}).then(async () => {
      opts.onStart?.(); // it's this message's turn (everything queued ahead of it is done)
      const w = this.remote.get(path);
      if (w) return this.viaWorker(path, run, () => w.send(text));
      const s = await this.get(agent, path);
      // Replace image markers in the message with the images themselves. When the current model can't see images (e.g. DeepSeek),
      // first have a vision model read the images into text and append it; the original images are still saved into the conversation, so they'll be visible if you switch to a vision-capable model later
      const names = imageNames(text);
      const images = names.map((n) => readImage(this.dataDir, n)).filter((x) => !!x);
      let msg = text;
      if (images.length && !(await this.canSee())) {
        this.emit("activity", { path, live: { since: Date.now(), status: "Looking at the images first…", steps: [] } });
        const read = await Promise.all(names.map(async (n) => ({ name: n, ...(await this.describeImage(n)) })));
        msg += imageNote(read, read[0]?.by ?? "vision model");
      }
      await s.prompt(msg, images.length ? { images } : undefined).catch((e) => {
        throw new Error(explainError((e as Error).message));
      });
      return lastReply(s);
    });
    this.queues.set(path, run);
    const done = () => {
      const n = (this.inflight.get(path) ?? 1) - 1;
      if (n > 0) this.inflight.set(path, n);
      else this.inflight.delete(path);
    };
    run.then(done, done);
    return run;
  }

  /** Whether this conversation has work in hand (currently answering or still has queued messages): new messages must queue. */
  occupied(path: string) {
    return (this.inflight.get(path) ?? 0) > 0 || this.isBusy(path);
  }

  /** Tell the web page that a conversation has a complete reply (messages not sent via the web page don't get an end signal there, so this wraps it up). */
  announce(path: string, text: string) {
    this.emit("message", { path, role: "assistant", text });
  }

  /** Append a message to the end of a conversation (shown, and visible to the model on the next reply) without triggering a reply. Used for background task reports. */
  note(agent: string, path: string, text: string): Promise<void> {
    const w = this.remote.get(path);
    if (w) return w.note(text);
    const prev = this.queues.get(path) ?? Promise.resolve();
    const run: Promise<void> = prev.catch(() => {}).then(async () => {
      // While queued, this conversation may have been handed off to a subprocess (sendTask is starting it): forward to the subprocess, don't open another copy in the main process
      const w = this.remote.get(path);
      if (w) return this.viaWorker(path, run, () => w.note(text));
      const s = await this.get(agent, path);
      await s.sendCustomMessage({ customType: "kiki-task", content: text, display: true }, { triggerTurn: false });
      this.emit("message", { path, role: "assistant", text });
    });
    this.queues.set(path, run);
    return run;
  }

  /** Close a conversation: stop its work, free memory, and move the JSONL into data folder/trash/<bot>/ (not truly deleted, can be recovered if needed). */
  async discard(agent: string, path: string, name: string) {
    this.gone.add(path); // mark first: queued messages will error out before getting the session, and won't reopen it
    await this.remote.get(path)?.kill();
    const s = this.live.get(path);
    if (s) {
      await s.abort().catch(() => {});
      s.dispose();
    }
    this.live.delete(path);
    this.queues.delete(path);
    if (this.runs.delete(path)) this.emit("activity", { path, live: null });
    if (!existsSync(path)) return; // a conversation that never got a reply, so the file was never written
    const dir = join(this.dataDir, "trash", agent);
    mkdirSync(dir, { recursive: true });
    const safe = name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    // Include the original filename (which contains the unique id pi gave it), so deleting two conversations with the same name in the same second won't overwrite each other
    renameSync(path, join(dir, `${trashStamp()}-${safe}-${basename(path)}`));
  }

  /** Insert a message into a running conversation (pi's steer: it's seen once the current step finishes); if not running, send it as a normal message. Used for modifying tasks. */
  async steer(agent: string, path: string, text: string): Promise<void> {
    const w = this.remote.get(path);
    if (w) return w.steer(text);
    const s = this.live.get(path);
    if (s?.isStreaming) {
      await s.steer(text);
      return;
    }
    await this.send(agent, path, text);
  }

  /** Stop a running conversation (used when a background task times out). */
  async abort(path: string) {
    const w = this.remote.get(path);
    if (w) return w.kill(); // running in a subprocess: stop = kill the subprocess
    await this.live.get(path)?.abort();
  }

  // ---------- background task subprocesses ----------

  private hooks(): WorkerHooks {
    const tools = (agent: string) => this.toolsFor?.(agent) ?? [];
    return {
      tools: (agent): ToolMeta[] =>
        tools(agent).map((t) => ({
          name: t.name,
          label: t.label,
          description: t.description,
          parameters: t.parameters,
          promptSnippet: t.promptSnippet,
          promptGuidelines: t.promptGuidelines,
        })),
      runTool: async (agent, name, params, path, cwd, toolCallId) => {
        const t = tools(agent).find((x) => x.name === name);
        if (!t) throw new Error(`No such tool ${name}`);
        // Kiki's tools only take this conversation's path from ctx
        const ctx = { cwd, sessionManager: { getSessionFile: () => path } };
        return t.execute(toolCallId, params as any, undefined, undefined, ctx as any);
      },
      approve: (req, signal) => this.isolation!.approve(req, signal),
    };
  }

  private async startWorker(agent: string, open: OpenSpec): Promise<Worker> {
    const iso = this.isolation!;
    const w = new Worker(iso.script, { dataDir: this.dataDir, model: this.modelSpec, agent, open }, this.hooks(), iso.execArgv);
    w.on("event", (name: string, data: unknown) => this.emit(name, data));
    const path = await w.ready;
    if (w.alive) {
      this.remote.set(path, w);
      w.once("exit", () => {
        if (this.remote.get(path) === w) this.remote.delete(path);
      });
    }
    return w;
  }

  /** The subprocess finished this message: if nothing else is queued, let it exit (start a new one next time it's needed). */
  private async viaWorker<T>(path: string, run: Promise<unknown>, work: () => Promise<T>): Promise<T> {
    const w = this.remote.get(path)!;
    try {
      return await work();
    } finally {
      if (this.queues.get(path) === run) {
        this.remote.delete(path);
        await w.close();
      }
    }
  }

  /** Open a background task conversation (fork from `from` if given). If isolation is set, open it in a subprocess and keep the subprocess around waiting for sendTask. */
  async spawnTask(agent: string, name: string, from?: string): Promise<string> {
    if (!this.isolation) return from ? this.fork(agent, from, name) : this.create(agent, name);
    if (from) await this.queues.get(from)?.catch(() => {}); // wait for the original conversation to finish its current turn, so we don't fork mid-way
    const w = await this.startWorker(agent, from ? { fork: { from, name } } : { create: name });
    return w.path!;
  }

  /** Send a message to a background task conversation (assign task, answer, rework). If isolation is set, run it in a subprocess and close the subprocess when done. */
  sendTask(agent: string, path: string, text: string): Promise<string> {
    if (!this.isolation) return this.send(agent, path, text);
    const prev = this.queues.get(path) ?? Promise.resolve();
    const run: Promise<string> = prev.catch(() => {}).then(async () => {
      if (this.gone.has(path)) throw new Error("This conversation has been deleted");
      if (!this.remote.has(path)) {
        // If this conversation is open in the main process (e.g. the user opened and chatted in it), release it first; only one process may write to a given file
        this.live.get(path)?.dispose();
        this.live.delete(path);
        await this.startWorker(agent, { path });
      }
      return this.viaWorker(path, run, () => this.remote.get(path)!.send(text));
    });
    this.queues.set(path, run);
    return run;
  }

  /** Whether this conversation is running in a subprocess */
  isRemote(path: string) {
    return this.remote.has(path);
  }

  /** Close all subprocesses (when Kiki exits) */
  async closeWorkers() {
    await Promise.all([...this.remote.values()].map((w) => w.kill()));
  }

  /** Ask the model a single question (not part of any conversation), used for routing. */
  async complete(system: string, user: string, spec?: string): Promise<string> {
    const rt = await this.runtime;
    const msg: any = await rt.completeSimple(await this.model(spec), {
      systemPrompt: system,
      messages: [{ role: "user", content: user, timestamp: Date.now() }],
    });
    if (msg.stopReason === "error") throw new Error(explainError(msg.errorMessage ?? "Model error"));
    return (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  }

  /** What this bot does: take the paragraph under "What I'm responsible for" in AGENTS.md, or the title if there isn't one. */
  describe(agent: string): string {
    const f = baoFile(this.dataDir, agent);
    if (!existsSync(f)) return "";
    const md = readFileSync(f, "utf8");
    const duty = md.match(/##\s*What I'm responsible for\s*\n+([^\n#][^\n]*)/);
    if (duty) return duty[1].trim();
    return (md.match(/^#\s*(.+)$/m)?.[1] ?? "").trim();
  }

  isBusy(path: string) {
    const w = this.remote.get(path);
    if (w) return w.busy;
    return this.live.get(path)?.isStreaming ?? false;
  }

  /** The last n things the user said in this conversation, each truncated to 60 characters (used for routing). */
  recent(path: string, n: number): string[] {
    return this.history(path)
      .filter((l) => l.role === "user")
      .slice(-n)
      .map((l) => l.text.replace(/\s+/g, " ").slice(0, 60));
  }

  /** The chat log of a conversation (text only, no tool calls). */
  history(path: string): ChatLine[] {
    const live = this.live.get(path);
    let msgs: any[];
    if (live) msgs = live.messages as any[];
    else if (existsSync(path))
      msgs = readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "message" || e.type === "custom_message")
        .map((e) => (e.type === "message" ? e.message : { role: "custom", content: e.content }));
    else return [];
    const steps = stepsFromMessages(msgs, this.labels());
    const out: ChatLine[] = [];
    for (const m of msgs) {
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "custom") continue;
      const role: ChatLine["role"] = m.role === "user" ? "user" : "assistant"; // background task reports are shown as assistant messages
      const text =
        typeof m.content === "string"
          ? m.content
          : (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (text.trim()) out.push({ role, text: text.trim(), ...(steps.has(m) ? { steps: steps.get(m) } : {}) });
      else if (m.role === "assistant" && m.stopReason === "error") out.push({ role: "assistant", text: `Something went wrong: ${m.errorMessage ?? "unknown error"}` });
    }
    return out;
  }
}

function lastReply(s: AgentSession): string {
  const msgs = s.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    if (m.stopReason === "error") return `Something went wrong: ${explainError(m.errorMessage ?? "unknown error")}`;
    const text = (m.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "(no text reply)";
}

/** Trash filename prefix, e.g. 20261102-103015 */
function trashStamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
