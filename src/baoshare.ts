// Exporting and importing bots: pack a bot into a .bao file to send to someone, or install someone else's bot from a file / GitHub link.
//
// A .bao file is just JSON: { kiki: "bao", format: 1, name, look: {emoji}, files: { "AGENTS.md": "…", "skills/x/SKILL.md": "…" } }
// It only carries the "recipe": instruction files (AGENTS.md and any other .md you wrote in the bot folder) and skills (under skills/, in Claude / Agent Skills format).
// It does not carry: conversation history (sessions/), notes (notes/), work (work/), watchlist, tasks, API keys; files that look like they contain keys are also left out.
//
// Import happens in two steps: first "take a look" (preview) lists what it will do—which skills it uses, whether it runs scripts, who it contacts, whether there's anything suspicious.
// Only after you've looked and clicked "Install" does it actually write into agents/<name>/. This is the only prompt during import; once installed it runs under full-auto rules and won't ask again.
// Compatible with other formats: CLAUDE.md alone works (treated as AGENTS.md); a folder with just a SKILL.md (a Claude skill) gets wrapped into a bot with that skill;
// skills under .claude/skills, .agents/skills, .pi/skills are all moved under skills/.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join, relative, sep } from "node:path";
import { BAO_FILE, SKILLS_DIR, baoDir, readDuty } from "./bao.js";
import { baoEmoji, baoLook, validName } from "./settings.js";
import { VERSION } from "./update.js";

export const BAO_EXT = ".bao";

const MAX_FILES = 200;
const MAX_FILE = 256 * 1024; // single file
const MAX_TOTAL = 2 * 1024 * 1024; // whole bot
/** These in the bot folder are not exported: either your private business or managed by the program itself */
const PRIVATE_MD = new Set(["watchlist.md"]);

export interface BaoBundle {
  kiki: "bao";
  format: 1;
  name: string;
  exportedAt?: string;
  kikiVersion?: string;
  look?: { emoji?: string };
  files: Record<string, string>;
}

// ---------- API keys and suspicious content ----------

const SECRET_RES: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, "looks like an API key (sk-…)"],
  [/\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, "looks like a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "looks like a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "looks like an AWS key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "looks like a Google key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, "looks like a Telegram bot token"],
  [/(api[_-]?key|secret|token|password|密码|密钥)\s*[:=：]\s*["']?[A-Za-z0-9_\-+/=.]{16,}/i, "contains a key / password"],
];

/** Whether the text contains anything that looks like a key, and if so what it is */
export function secretIn(text: string): string | undefined {
  for (const [re, what] of SECRET_RES) if (re.test(text)) return what;
  return undefined;
}

// ---------- Paths ----------

/** Paths inside the bundle must be clean: relative, no .., no hidden directories, not too long */
export function safePath(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 200 || p.includes("\\") || p.includes("\0")) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false;
  return p.split("/").every((s) => s && s !== "." && s !== ".." && !s.startsWith("."));
}

/** Whether this path can go into a bot: instruction .md (top level) or files under skills/ */
function allowed(p: string): boolean {
  if (!safePath(p)) return false;
  const parts = p.split("/");
  if (parts.length === 1) return p.toLowerCase().endsWith(".md") && !PRIVATE_MD.has(p);
  return parts[0] === SKILLS_DIR && parts.length >= 3;
}

const isText = (b: Buffer) => !b.includes(0) && Buffer.from(b.toString("utf8"), "utf8").equals(b);

// ---------- Export ----------

export interface ExportResult {
  bundle: BaoBundle;
  /** What wasn't included: path + reason (whole categories like conversation history just get one line) */
  skipped: { path: string; why: string }[];
}

/** Pack a bot into a bundle. Only reads files, changes nothing. */
export function exportBao(dataDir: string, name: string): ExportResult {
  const dir = baoDir(dataDir, name);
  if (!existsSync(dir)) throw new Error(`No bot "${name}"`);
  const files: Record<string, string> = {};
  const skipped: ExportResult["skipped"] = [];
  let total = 0;
  const add = (abs: string, rel: string) => {
    const st = statSync(abs);
    if (st.size > MAX_FILE) return skipped.push({ path: rel, why: "too large" });
    const buf = readFileSync(abs);
    if (!isText(buf)) return skipped.push({ path: rel, why: "not a text file" });
    const text = buf.toString("utf8");
    const s = secretIn(text);
    if (s) return skipped.push({ path: rel, why: `contains ${s}, left out` });
    if (Object.keys(files).length >= MAX_FILES || total + st.size > MAX_TOTAL) return skipped.push({ path: rel, why: "bot is too large, the rest was left out" });
    total += st.size;
    files[rel] = text;
  };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && allowed(e.name)) add(join(dir, e.name), e.name);
    else if (e.isFile() && PRIVATE_MD.has(e.name)) skipped.push({ path: e.name, why: "the watchlist is your private business, left out" });
  }
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      const rel = relative(dir, abs).split(sep).join("/");
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && allowed(rel)) add(abs, rel);
    }
  };
  if (existsSync(join(dir, SKILLS_DIR))) walk(join(dir, SKILLS_DIR));
  const PRIVATE_DIRS: Record<string, string> = { sessions: "conversation history is not included", notes: "notes are your private business, left out", tasks: "tasks are not included", work: "the work you're doing is not included" };
  for (const [d, why] of Object.entries(PRIVATE_DIRS)) if (existsSync(join(dir, d))) skipped.push({ path: `${d}/`, why });
  if (!files[BAO_FILE]) throw new Error(`Bot "${name}" has no ${BAO_FILE}, can't export`);
  const emoji = baoLook(dataDir, name).emoji;
  return {
    bundle: { kiki: "bao", format: 1, name, exportedAt: new Date().toISOString(), kikiVersion: VERSION, ...(emoji ? { look: { emoji } } : {}), files },
    skipped,
  };
}

// ---------- Read a bundle (file or folder) ----------

/** Turn folder form (from GitHub) into a bundle: compatible with CLAUDE.md, a single Claude skill, skills under .claude/.agents/.pi */
export function fromFolder(raw: Record<string, string>, fallbackName: string): BaoBundle {
  const files: Record<string, string> = {};
  const put = (p: string, t: string) => {
    if (!(p in files)) files[p] = t;
  };
  // The whole folder is one skill
  if (typeof raw["SKILL.md"] === "string") {
    const fm = frontmatter(raw["SKILL.md"]);
    const skill = slug(fm.name || fallbackName);
    for (const [p, t] of Object.entries(raw)) put(`${SKILLS_DIR}/${skill}/${p}`, t);
    const name = cleanName(fm.name || fallbackName);
    put(BAO_FILE, `# ${name}\n\n## What I'm responsible for\n${(fm.description || `Get things done with the "${skill}" skill`).replace(/\s+/g, " ").trim()}\n\n## How I work\n- First check what the "${skill}" skill says, and follow it.\n- Keep answers short, conclusion first.\n`);
    return { kiki: "bao", format: 1, name, files };
  }
  for (const [p, t] of Object.entries(raw)) {
    const m = p.match(/^\.(claude|agents|pi)\/skills\/(.+)$/);
    if (m) put(`${SKILLS_DIR}/${m[2]}`, t);
    else if (p === "CLAUDE.md" && raw[BAO_FILE] === undefined) put(BAO_FILE, t);
    else put(p, t);
  }
  return { kiki: "bao", format: 1, name: cleanName(fallbackName), files };
}

/** Read the text of a .bao file, error out if it's wrong */
export function parseBundle(text: string): BaoBundle {
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    throw new Error("This isn't a .bao file (couldn't read it)");
  }
  if (!b || b.kiki !== "bao" || typeof b.files !== "object" || !b.files) throw new Error("This isn't a .bao file");
  if (b.format !== 1) throw new Error("This .bao file was exported by a newer version of Kiki, please upgrade Kiki first");
  for (const v of Object.values(b.files)) if (typeof v !== "string") throw new Error("The .bao file contains broken content");
  return { kiki: "bao", format: 1, name: cleanName(String(b.name ?? "")), look: { emoji: baoEmoji(b.look?.emoji) || undefined }, files: b.files };
}

const cleanName = (s: string) => s.replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 12) || "New bot";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9\p{L}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "skill";

/** Read the YAML at the top of SKILL.md (only one level of key: value, good enough) */
export function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].replace(/^["']|["']$/g, "").replace(/^[>|]-?$/, "");
    } else if (key && /^\s+\S/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
  }
  return out;
}

// ---------- Take a look: what it will do ----------

export interface Preview {
  name: string; // suggested name (duplicates automatically get a number)
  originalName: string;
  emoji?: string;
  duty: string;
  files: { path: string; size: number }[];
  skills: { name: string; description: string; files: number; scripts: string[]; tools?: string }[];
  scripts: string[]; // script files that will be executed
  contacts: { domains: string[]; emails: string[]; channels: string[] };
  abilities: string[]; // what it does: go online, send messages, pay, delete files…
  warnings: { level: "red" | "yellow"; text: string }[];
  dropped: { path: string; why: string }[]; // in the bundle but won't be installed
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php|ps1|applescript|scpt|command)$/i;

const ABILITY_RES: [RegExp, string][] = [
  [/\b(curl|wget|fetch\(|axios|requests\.(get|post)|https?:\/\/)/i, "go online"],
  [/(发消息|发邮件|发送|回复邮件|send[_ ]?(message|email|mail)|smtp|telegram|微信|whatsapp|slack|discord|twitter|推特|\bx\.com)/i, "send messages for you"],
  [/(付款|支付|转账|下单|购买|充值|\bpay(ment)?\b|stripe|checkout|purchase|wallet|钱包)/i, "spend money / pay"],
  [/(\brm\s+-[a-z]*r|删除|delete|unlink|drop\s+table|trash)/i, "delete things"],
  [/(~\/|\/Users\/|\$HOME|钥匙串|keychain|\.ssh|\.env\b)/i, "read/write files on your Mac outside the bot folder"],
  [/(osascript|applescript|launchctl|crontab|sudo\b)/i, "change system settings / startup tasks"],
  [/(日历|calendar|提醒事项|reminders|通讯录|contacts)/i, "read/write calendar / contacts"],
];

const RED_RES: [RegExp, string][] = [
  [/(ignore (all |any )?(previous|prior|above) (instructions|prompts)|忽略(之前|前面|以上)(的)?(所有)?(指令|规则|说明))/i, "contains phrases like \"ignore previous instructions\", common in malicious skills"],
  [/(不要|别|勿)(告诉|通知|让)(用户|你的主人|主人)|without (telling|notifying|asking) the user|do not (tell|inform|notify) the user/i, "tells Kiki to do things behind your back"],
  [/(curl|wget)[^\n|]*\|\s*(ba|z)?sh\b/i, "downloads a script from the internet and runs it directly"],
  [/base64\s+(-d|--decode)|eval\s*\(\s*(atob|Buffer\.from)/i, "has code that's decoded then executed, can't tell what it really does"],
  [/(上传|发送|发给|upload|send|post|curl)[^\n]{0,60}(\.ssh\/|\.env\b|auth\.json|钥匙串|keychain|id_rsa)/i, "sends key files from your Mac out"],
];

const IGNORED_DOMAINS = /(^|\.)(example\.(com|org)|localhost|w3\.org|schema\.org|agentskills\.io)$/i;

/** List what this bundle will do once installed. Only reads text, executes nothing. */
export function previewBundle(b: BaoBundle, existing: string[]): Preview {
  const files: Preview["files"] = [];
  const dropped: Preview["dropped"] = [];
  const keep: Record<string, string> = {};
  let total = 0;
  for (const [p, t] of Object.entries(b.files)) {
    const size = Buffer.byteLength(t, "utf8");
    if (!allowed(p)) {
      dropped.push({ path: p, why: safePath(p) ? "not an instruction or skill file" : "unsafe path" });
      continue;
    }
    if (size > MAX_FILE) dropped.push({ path: p, why: "too large" });
    else if (secretIn(t)) dropped.push({ path: p, why: `contains ${secretIn(t)}` });
    else if (files.length >= MAX_FILES || total + size > MAX_TOTAL) dropped.push({ path: p, why: "bot is too large, the rest won't be installed" });
    else {
      keep[p] = t;
      files.push({ path: p, size });
      total += size;
    }
  }
  const all = Object.entries(keep);
  const text = all.map(([, t]) => t).join("\n");
  const scripts = all.map(([p]) => p).filter((p) => SCRIPT_EXT.test(p));

  // Skills
  const skills: Preview["skills"] = [];
  for (const [p, t] of all) {
    const m = p.match(new RegExp(`^${SKILLS_DIR}/(.+)/SKILL\\.md$`));
    if (!m) continue;
    const fm = frontmatter(t);
    const base = `${SKILLS_DIR}/${m[1]}/`;
    const own = all.filter(([q]) => q.startsWith(base));
    skills.push({
      name: fm.name || m[1].split("/").pop()!,
      description: (fm.description || "").slice(0, 300),
      files: own.length,
      scripts: own.map(([q]) => q.slice(base.length)).filter((q) => SCRIPT_EXT.test(q)),
      ...(fm["allowed-tools"] ? { tools: fm["allowed-tools"] } : {}),
    });
  }

  // Who it contacts
  const domains = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const d = m[1].toLowerCase().replace(/^www\./, "");
    if (!IGNORED_DOMAINS.test(d)) domains.add(d);
  }
  const emails = new Set<string>();
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) if (!IGNORED_DOMAINS.test(m[0].split("@")[1])) emails.add(m[0].toLowerCase());
  const channels = new Set<string>();
  for (const [re, label] of [
    [/微信|wechat/i, "WeChat"],
    [/telegram/i, "Telegram"],
    [/slack/i, "Slack"],
    [/discord/i, "Discord"],
    [/whatsapp/i, "WhatsApp"],
    [/email|e-?mail|smtp|gmail/i, "Email"],
    [/twitter|\bx\.com/i, "X / Twitter"],
    [/\bsms\b|imessage/i, "SMS / iMessage"],
  ] as [RegExp, string][])
    if (re.test(text)) channels.add(label);

  const abilities = ABILITY_RES.filter(([re]) => re.test(text)).map(([, a]) => a);
  if (scripts.length) abilities.unshift("Run scripts");

  const warnings: Preview["warnings"] = [];
  for (const [re, w] of RED_RES) if (re.test(text)) warnings.push({ level: "red", text: w });
  if (scripts.length) warnings.push({ level: "yellow", text: `Includes ${scripts.length} script(s); Kiki will run them on your computer when it uses these skills` });
  if (abilities.includes("Spend money / pay")) warnings.push({ level: "yellow", text: "Mentions payments; once installed it will pay automatically according to your budget settings" });
  if (!keep[BAO_FILE]) warnings.push({ level: "yellow", text: `No ${BAO_FILE}; a minimal one will be written for it` });
  if (dropped.length) warnings.push({ level: "yellow", text: `${dropped.length} file(s) won't be installed (see below)` });

  const originalName = b.name || "New bot";
  let name = originalName;
  for (let i = 2; existing.includes(name); i++) name = `${originalName.slice(0, 10)}${i}`;
  return {
    name,
    originalName,
    emoji: b.look?.emoji,
    duty: readDuty(keep[BAO_FILE] ?? ""),
    files,
    skills,
    scripts,
    contacts: { domains: [...domains].sort().slice(0, 30), emails: [...emails].sort().slice(0, 30), channels: [...channels] },
    abilities,
    warnings,
    dropped,
  };
}

// ---------- Install ----------

/** Install the bundle as a new bot. Writes to a temp folder first, then renames it into place, so it never half-installs. Returns the installed name. */
export function installBundle(dataDir: string, b: BaoBundle, name: string): string {
  if (!validName(name)) throw new Error("Names can only contain letters, numbers, Chinese characters, - and _");
  const dir = baoDir(dataDir, name);
  if (existsSync(dir)) throw new Error(`A bot named "${name}" already exists; pick another name`);
  const p = previewBundle(b, []);
  const tmp = join(dataDir, `.bao-importing-${process.pid}-${Date.now()}`); // outside agents/, so it isn't treated as a bot before it's ready
  mkdirSync(tmp, { recursive: true });
  try {
    for (const f of p.files) {
      const abs = join(tmp, ...f.path.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, b.files[f.path]);
    }
    if (!existsSync(join(tmp, BAO_FILE))) writeFileSync(join(tmp, BAO_FILE), `# ${name}\n\n## What I'm responsible for\nThings related to ${name}\n`);
    const emoji = baoEmoji(b.look?.emoji);
    writeFileSync(join(tmp, "bao.json"), JSON.stringify({ ...(emoji ? { emoji } : {}), importedFrom: b.name, importedAt: new Date().toISOString() }) + "\n");
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return name;
}

// ---------- Fetch from GitHub ----------

/** GitHub link → bundle. Supports: a repo / a folder in a repo (tree link) / a single .bao file (blob or raw link). */
export async function fetchGithub(link: string, fetcher: typeof fetch = fetch): Promise<BaoBundle> {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new Error("Invalid link");
  }
  const get = async (url: string, json = false) => {
    const r = await fetcher(url, { headers: { "user-agent": "Kiki", ...(json ? { accept: "application/vnd.github+json" } : {}) }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(r.status === 404 ? "Not found on GitHub (the repo is private, or the link is wrong)" : r.status === 403 ? "GitHub won't allow fetching right now (too many requests); try again later" : `GitHub returned ${r.status}`);
    return json ? r.json() : r.text();
  };
  if (u.hostname === "raw.githubusercontent.com") {
    if (!u.pathname.endsWith(BAO_EXT)) throw new Error("Raw links only work for .bao files; for folders, paste the github.com link");
    return parseBundle((await get(u.href)) as string);
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") throw new Error("Only github.com links are supported");
  const [owner, repo, kind, ref, ...rest] = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/").map((s) => decodeURIComponent(s));
  if (!owner || !repo) throw new Error("The link must include a repo, e.g. https://github.com/someone/some-repo");
  const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
  if (kind === "blob") {
    if (!rest.join("/").endsWith(BAO_EXT)) throw new Error("This link points to a single file, and only .bao files are supported; to import a folder, paste the folder's link");
    return parseBundle((await get(`https://raw.githubusercontent.com/${owner}/${repo}/${enc(ref)}/${enc(rest.join("/"))}`)) as string);
  }
  const branch = kind === "tree" && ref ? ref : ((await get(`https://api.github.com/repos/${owner}/${repo}`, true)) as any).default_branch;
  const base = kind === "tree" ? rest.join("/") : "";
  const tree = (await get(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, true)) as any;
  const prefix = base ? `${base}/` : "";
  const blobs: { path: string; size: number }[] = (tree.tree ?? []).filter((x: any) => x.type === "blob" && x.path.startsWith(prefix)).map((x: any) => ({ path: x.path.slice(prefix.length), size: x.size ?? 0 }));
  // Folder contains exactly one .bao file: use it
  const baos = blobs.filter((x) => x.path.endsWith(BAO_EXT) && !x.path.includes("/"));
  if (baos.length === 1 && !blobs.some((x) => x.path === BAO_FILE || x.path === "SKILL.md"))
    return parseBundle((await get(`https://raw.githubusercontent.com/${owner}/${repo}/${enc(branch)}/${enc(prefix + baos[0].path)}`)) as string);
  // Only fetch what's needed: top-level .md, things next to SKILL.md, the skills folder
  const isSkill = blobs.some((x) => x.path === "SKILL.md");
  const want = blobs.filter((x) => {
    if (x.size > MAX_FILE) return false;
    if (isSkill) return !x.path.split("/").some((s) => s.startsWith("."));
    return (!x.path.includes("/") && /\.md$/i.test(x.path)) || /^(\.(claude|agents|pi)\/)?skills\//.test(x.path);
  });
  if (!want.length) throw new Error(`This folder has no ${BAO_FILE}, CLAUDE.md, SKILL.md or .bao file, so it doesn't look like a bot`);
  if (want.length > MAX_FILES) throw new Error(`Too many files (${want.length}); a bot can have at most ${MAX_FILES}`);
  const raw: Record<string, string> = {};
  let total = 0;
  for (const f of want) {
    total += f.size;
    if (total > MAX_TOTAL) throw new Error("This bot is too big (over 2MB)");
    raw[f.path] = (await get(`https://raw.githubusercontent.com/${owner}/${repo}/${enc(branch)}/${enc(prefix + f.path)}`)) as string;
  }
  return fromFolder(raw, base ? base.split("/").pop()! : repo);
}

// ---------- API: /api/bao/export, /api/bao/import ----------

export function baoShareApi(opts: { dataDir: string; onInstalled?: (name: string) => void; fetcher?: typeof fetch }) {
  const agentsDir = join(opts.dataDir, "agents");
  const list = () => (existsSync(agentsDir) ? readdirSync(agentsDir).filter((n) => !n.startsWith(".") && statSync(join(agentsDir, n)).isDirectory()) : []);
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    // GET /api/bao/export?name=Work → { file: "Work.bao", text, skipped, count }
    if (url.pathname === "/api/bao/export" && req.method === "GET") {
      const name = url.searchParams.get("name");
      if (!validName(name) || !list().includes(name)) return json({ error: "No such bot" }, 404);
      try {
        const { bundle, skipped } = exportBao(opts.dataDir, name);
        return json({ file: `${name}${BAO_EXT}`, text: JSON.stringify(bundle, null, 2) + "\n", count: Object.keys(bundle.files).length, skipped });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    // POST /api/bao/import { text | url, install?: false|true, name? }
    //   without install: just take a look, return preview; with install:true and name: install it
    if (url.pathname === "/api/bao/import" && req.method === "POST") {
      let body: any;
      try {
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const c of req) {
          chunks.push(c as Buffer);
          n += (c as Buffer).length;
          if (n > MAX_TOTAL * 3) return json({ error: "File is too big" }, 413);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); // concatenate first, then decode, so multi-byte characters aren't split in half
      } catch {
        return json({ error: "Couldn't parse the request" }, 400);
      }
      let bundle: BaoBundle;
      try {
        if (typeof body.text === "string") bundle = parseBundle(body.text);
        else if (typeof body.url === "string") bundle = await fetchGithub(body.url, opts.fetcher);
        else return json({ error: "Provide a .bao file or a GitHub link" }, 400);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      // On preview, hand back the normalized bundle as-is; on install, the web page sends it back: what gets installed is exactly what you looked at,
      // and it won't re-fetch from GitHub after the preview (if it changed in between, you'd install something else)
      if (!body.install) return json({ preview: previewBundle(bundle, list()), text: JSON.stringify(bundle) });
      if (typeof body.text !== "string") return json({ error: "You need to preview it before installing" }, 400);
      try {
        const name = installBundle(opts.dataDir, bundle, String(body.name ?? "").trim());
        opts.onInstalled?.(name);
        return json({ ok: true, name });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    return json({ error: "not found" }, 404);
  };
}
