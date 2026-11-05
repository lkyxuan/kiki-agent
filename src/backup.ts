// Back up first, then act: deletes and force pushes no longer ask you first — instead a copy is saved automatically before the action, and it can be undone with one click afterward.
//
//   - rm deleting files: whatever is about to be deleted is first copied into <data folder>/trash/backups/<id>/, and undo copies it back (an existing file of the same name in place is not overwritten).
//   - git losing changes (reset --hard, clean, checkout --, stash drop, deleting branches…): first record HEAD, all branches and tags,
//     uncommitted changes (git stash create), the stash list and untracked files, all hung under refs/kiki-backup/<id>/ so they can't be garbage-collected.
//     Undo = return to how things looked just before that step.
//   - Force push: first fetch a copy of all remote branches into local refs/kiki-backup/<id>/; undo pushes the changed branches back to their original state.
//   - Can't tell what will be deleted, too large, disk wiping, or anything else that can't be backed up: don't do it, hand the reason back to the model so it can try another approach (it won't come ask you).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, globSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type Undo =
  | { kind: "files"; items: { from: string; backup: string }[] }
  | {
      kind: "git";
      repo: string;
      id: string;
      head: string;
      branch?: string;
      wip?: string;
      refs: [string, string][]; // [sha, refs/heads/x]
      stashes: string[];
      untracked?: { dir: string; files: string[] };
    }
  | { kind: "push"; repo: string; remote: string; refs: [string, string, string][] }; // [branch name, remote sha before the push (empty if none), sha pushed this time (empty if branch deleted)]

export type BackupResult = { undo: Undo; note: string } | { error: string };

/** Back up at most this much at a time (bytes): anything larger is not done, and the model is told to try another approach */
export const MAX_BACKUP = 1 << 30;

const IRREVERSIBLE = new Set(["dd.device-write", "disk.erase"]);

export function newBackupId(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
}

/** Back up this command according to its cc-safety-net rule id. */
export function backupFor(dataDir: string, ruleId: string, command: string, cwd: string, id = newBackupId()): BackupResult {
  const trash = join(dataDir, "trash");
  if (IRREVERSIBLE.has(ruleId)) return { error: "Actions like writing to a disk device or wiping a disk can't be backed up and can't be taken back, so Kiki won't do them. Try an approach that doesn't touch the whole disk." };
  const parsed = parseShell(command);
  try {
    if (ruleId.startsWith("git.push")) {
      if (!parsed) return { error: "This force push command is too complex to back up the remote first. Split it into a simple git push and try again." };
      return pushBackup(parsed, cwd, id);
    }
    if (ruleId.startsWith("git.")) {
      // If the command can't be understood (e.g. git -C "$X"), don't guess which repo: guessing wrong backs up a different repo
      if (!parsed) return { error: "This git command is too complex to tell which repo it acts on, so it can't be backed up first. Split it into simple commands with hard-coded paths and run again." };
      const repo = gitRoot(workDir(parsed, cwd));
      if (!repo) return { error: "Couldn't find the repo this git command acts on, so it can't be backed up first. cd into the repo and run it again." };
      return gitSnapshot(dataDir, repo, id, /\bclean\b[^;&|]*-[a-zA-Z]*x/i.test(command));
    }
    if (ruleId.startsWith("rm.")) {
      const targets = parsed ? rmTargets(parsed, cwd) : undefined;
      if (!targets?.length) return { error: `Couldn't tell which files will be deleted, so it can't be backed up first. Use explicit paths, or mv them into ${trash}/ first.` };
      return fileBackup(dataDir, targets, id);
    }
  } catch (e) {
    return { error: `Backing up first didn't succeed (${String((e as Error).message ?? e).split("\n")[0].slice(0, 160)}), so this step was not done. Try another approach, or mv into ${trash}/ first.` };
  }
  // find -delete, rsync --delete, xargs rm, complex commands that can't be understood…
  return { error: `This command deletes things, but Kiki can't tell exactly which, so it can't be backed up first and was not done. List the files to delete first, then rm them with explicit paths, or mv them into ${trash}/.` };
}

// ---------- undo ----------

/** Undo a backed-up action and return a one-line message for the user. */
export function undo(u: Undo): string {
  if (u.kind === "files") {
    const skipped: string[] = [];
    for (const it of u.items) {
      if (!existsSync(it.backup)) continue;
      if (existsSync(it.from)) {
        skipped.push(it.from);
        continue;
      }
      mkdirSync(dirname(it.from), { recursive: true });
      cpSync(it.backup, it.from, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
    return skipped.length ? `Restored; existing files of the same name were not overwritten: ${skipped.join(", ")}` : "The deleted files have been put back in place";
  }
  if (u.kind === "git") {
    const g = git(u.repo);
    const now = new Map(lines(g(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"])).map((l) => [l.split(" ")[1], l.split(" ")[0]]));
    for (const [sha, ref] of u.refs) if (now.get(ref) !== sha) g(["update-ref", ref, sha]);
    if (u.head) {
      if (u.branch) {
        g(["checkout", "-f", u.branch]);
        g(["reset", "--hard", u.head]);
      } else g(["checkout", "-f", "--detach", u.head]);
    }
    const notes: string[] = [];
    if (u.wip) {
      try {
        g(["stash", "apply", u.wip]);
      } catch {
        notes.push(`uncommitted changes couldn't be restored automatically; they're at ${u.wip.slice(0, 10)} (git stash apply it)`);
      }
    }
    const have = new Set(tryLines(g, ["log", "-g", "--format=%H", "refs/stash"]));
    for (const sha of [...u.stashes].reverse()) if (!have.has(sha)) g(["stash", "store", "-m", "Restored by Kiki undo", sha]);
    if (u.untracked)
      for (const f of u.untracked.files) {
        const to = join(u.repo, f);
        if (!existsSync(to) && existsSync(join(u.untracked.dir, f))) {
          mkdirSync(dirname(to), { recursive: true });
          cpSync(join(u.untracked.dir, f), to, { recursive: true });
        }
      }
    return ["The repo is back to how it was before that step", ...notes].join("; ");
  }
  // Force push: only touch the branches pushed this time; push back only if the remote still looks like it did after this push, and don't overwrite anything others pushed afterward
  const g = git(u.repo);
  const now = new Map(lines(g(["ls-remote", "--heads", u.remote], 60_000)).map((l) => [l.split("\t")[1].replace("refs/heads/", ""), l.split("\t")[0]]));
  const back: string[] = [];
  const moved: string[] = [];
  for (const [branch, before, pushed] of u.refs) {
    const cur = now.get(branch) ?? "";
    if (cur === before) continue;
    if (cur !== pushed) {
      moved.push(branch);
      continue;
    }
    g(["push", `--force-with-lease=refs/heads/${branch}:${pushed}`, u.remote, before ? `${before}:refs/heads/${branch}` : `:refs/heads/${branch}`], 120_000);
    back.push(branch);
  }
  const parts = [back.length ? `Remote branches have been pushed back to their original state: ${back.join(", ")}` : moved.length ? "" : "Remote branches are the same as before the push, nothing to change"];
  if (moved.length) parts.push(`These branches were pushed to by someone else afterward and were not overwritten automatically: ${moved.join(", ")} (the old ones are under local refs/kiki-backup/)`);
  return parts.filter(Boolean).join("; ");
}

// ---------- backup ----------

function fileBackup(dataDir: string, targets: string[], id: string): BackupResult {
  const live = targets.filter((t) => existsSync(t));
  if (!live.length) return { undo: { kind: "files", items: [] }, note: "The files to delete weren't there to begin with" };
  const size = live.reduce((n, t) => n + duBytes(t), 0);
  if (size > MAX_BACKUP) return { error: `What's about to be deleted is too large (about ${Math.round(size / 1e6)} MB) to back up first, so this step was not done. Delete it in batches, or mv it into ${join(dataDir, "trash")}/ first.` };
  const dir = join(dataDir, "trash", "backups", id, "files");
  const items = live.map((from, i) => {
    const backup = join(dir, String(i), basename(from) || "root");
    mkdirSync(dirname(backup), { recursive: true });
    cpSync(from, backup, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    return { from, backup };
  });
  writeFileSync(join(dir, "original-locations.txt"), items.map((x) => `${x.backup}\t${x.from}`).join("\n") + "\n");
  return { undo: { kind: "files", items }, note: `Backed up first to ${dir}` };
}

function gitSnapshot(dataDir: string, repo: string, id: string, ignored: boolean): BackupResult {
  const g = git(repo);
  const head = tryOne(g, ["rev-parse", "HEAD"]);
  const branch = tryOne(g, ["symbolic-ref", "-q", "--short", "HEAD"]) || undefined;
  const wip = tryOne(g, ["stash", "create"]) || undefined;
  const refs = lines(g(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"])).map((l) => l.split(" ") as [string, string]);
  const stashes = tryLines(g, ["log", "-g", "--format=%H", "refs/stash"]);
  // Hung under refs/kiki-backup/<id>/ so these commits won't be garbage-collected by git gc
  const keep = [
    ...(head ? [`create refs/kiki-backup/${id}/head ${head}`] : []),
    ...(wip ? [`create refs/kiki-backup/${id}/wip ${wip}`] : []),
    ...refs.map(([sha], i) => `create refs/kiki-backup/${id}/ref/${i} ${sha}`),
    ...stashes.map((sha, i) => `create refs/kiki-backup/${id}/stash/${i} ${sha}`),
  ];
  if (keep.length) execFileSync("git", ["-C", repo, "update-ref", "--stdin"], { input: keep.join("\n") + "\n", stdio: ["pipe", "ignore", "pipe"] });
  // Copy untracked files (the ones git clean would delete)
  const files = g(["ls-files", "--others", "-z", ...(ignored ? [] : ["--exclude-standard"])]).split("\0").filter(Boolean);
  let untracked: { dir: string; files: string[] } | undefined;
  if (files.length) {
    const size = files.reduce((n, f) => n + duBytes(join(repo, f)), 0);
    if (size > MAX_BACKUP) return { error: `The untracked files in the repo are too large (about ${Math.round(size / 1e6)} MB) to back up first, so this step was not done.` };
    const dir = join(dataDir, "trash", "backups", id, "untracked");
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(repo, f), join(dir, f), { recursive: true, verbatimSymlinks: true });
    }
    untracked = { dir, files };
  }
  return { undo: { kind: "git", repo, id, head, branch, wip, refs: refs.map(([sha, ref]) => [sha, ref]), stashes, untracked }, note: `Saved the repo state first (refs/kiki-backup/${id})` };
}

function pushBackup(segs: string[][], cwd: string, id: string): BackupResult {
  let dir = cwd;
  let push: string[] | undefined;
  for (const seg of segs) {
    if (seg[0] === "cd" && seg[1]) dir = resolvePath(seg[1], dir);
    const w = stripPrefix(seg);
    if (w[0] !== "git") continue;
    const i = w.indexOf("push");
    if (i < 0) continue;
    for (let j = 1; j < i; j++) if (w[j] === "-C" && w[j + 1]) dir = resolvePath(w[j + 1], dir);
    push = w.slice(i + 1);
  }
  const repo = gitRoot(dir);
  if (!repo || !push) return { error: "Couldn't find the repo to push, so the remote can't be backed up first. cd into the repo and push again." };
  const g = git(repo);
  const args = push.filter((a) => !a.startsWith("-"));
  const flags = push.filter((a) => a.startsWith("-"));
  const branchNow = tryOne(g, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const remote = args[0] ?? ((branchNow && tryOne(g, ["config", `branch.${branchNow}.remote`])) || "origin");
  const heads = new Map(lines(g(["ls-remote", "--heads", remote], 60_000)).map((l) => [l.split("\t")[1].replace("refs/heads/", ""), l.split("\t")[0]]));
  const local = new Map(lines(g(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"])).map((l) => l.split(" ") as [string, string]));
  const del = flags.some((f) => f === "--delete" || f === "-d");
  // Which branches this will push and what they'll be pushed to: [branch, sha pushed (empty if deleted)]
  const targets: [string, string][] = [];
  if (flags.includes("--mirror")) {
    for (const b of new Set([...heads.keys(), ...local.keys()])) targets.push([b, local.get(b) ?? ""]);
  } else if (flags.includes("--all") || flags.includes("--branches")) {
    for (const [b, sha] of local) targets.push([b, sha]);
  } else {
    const specs = args.slice(1);
    if (!specs.length) {
      if (!branchNow) return { error: "Not on any branch right now, so it can't tell which branch to push and can't back up first. Write it explicitly as git push <remote> <branch>." };
      specs.push(branchNow);
    }
    for (let spec of specs) {
      spec = spec.replace(/^\+/, "");
      const [src, dst = src] = spec.includes(":") ? spec.split(":") : [spec, spec];
      const name = dst.replace(/^refs\/heads\//, "");
      if (name.startsWith("refs/")) continue; // ignore tags and the like
      if (del || !src) {
        targets.push([name, ""]);
        continue;
      }
      const sha = tryOne(g, ["rev-parse", "--verify", "-q", `${src}^{commit}`]);
      if (!sha) return { error: `Couldn't tell which commit "${src}" to push is, so it can't back up first.` };
      targets.push([name, sha]);
    }
  }
  if (heads.size) g(["fetch", "--no-tags", remote, `+refs/heads/*:refs/kiki-backup/${id}/*`], 120_000);
  return {
    undo: { kind: "push", repo, remote, refs: targets.map(([b, pushed]) => [b, heads.get(b) ?? "", pushed]) },
    note: `Saved the branches of remote ${remote} locally to refs/kiki-backup/${id}/ first`,
  };
}

// ---------- reading commands ----------

/** A very simple shell word splitter: splits on ; && || | and newlines, understands single/double quotes and backslashes. Returns undefined if there's anything dynamic like $, backticks, <( ). */
export function parseShell(cmd: string): string[][] | undefined {
  // First strip redirections (2>&1, >/dev/null, < in.txt); they don't affect which files get deleted
  cmd = cmd.replace(/\d*>&\d+/g, " ").replace(/\d*(>>?|<)\s*[^\s;&|]+/g, " ");
  const segs: string[][] = [[]];
  let word = "";
  let has = false;
  let q: "'" | '"' | undefined;
  const push = () => {
    if (has) segs[segs.length - 1].push(word);
    word = "";
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") {
      if (c === "'") q = undefined;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      word += cmd[++i];
      has = true;
      continue;
    }
    if (c === "$" || c === "`") return undefined;
    if (q === '"') {
      if (c === '"') q = undefined;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
      continue;
    }
    if (c === "(" || c === ")" || c === "<" || c === ">") return undefined;
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      push();
      if (segs[segs.length - 1].length) segs.push([]);
      continue;
    }
    if (c === " " || c === "\t") {
      push();
      continue;
    }
    word += c;
    has = true;
  }
  if (q) return undefined;
  push();
  return segs.filter((s) => s.length);
}

/** Strip prefixes like VAR=x, sudo, command, env */
function stripPrefix(s: string[]): string[] {
  let i = 0;
  while (i < s.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i]) || ["sudo", "command", "builtin", "env", "nice", "nohup", "time"].includes(s[i]))) i++;
  return s.slice(i);
}

function resolvePath(p: string, cwd: string) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** Which directory the command ultimately operates in (follows cd and git -C) */
function workDir(segs: string[][], cwd: string) {
  let dir = cwd;
  for (const s of segs) {
    if (s[0] === "cd" && s[1]) dir = resolvePath(s[1], dir);
    const w = stripPrefix(s);
    if (w[0] === "git") for (let j = 1; j < w.length; j++) if (w[j] === "-C" && w[j + 1]) return resolvePath(w[j + 1], dir);
  }
  return dir;
}

/** Paths that rm will delete (follows cd, expands globs). Returns undefined if it can't tell. */
export function rmTargets(segs: string[][], cwd: string): string[] | undefined {
  let dir = cwd;
  const out: string[] = [];
  for (const s of segs) {
    if (s[0] === "cd" && s[1]) {
      dir = resolvePath(s[1], dir);
      continue;
    }
    const w = stripPrefix(s);
    if (w[0] !== "rm" && !w[0]?.endsWith("/rm")) continue;
    let flags = true;
    for (const a of w.slice(1)) {
      if (flags && a === "--") {
        flags = false;
        continue;
      }
      if (flags && a.startsWith("-") && a !== "-") continue;
      const p = resolvePath(a, dir);
      if (/[*?[]/.test(a)) {
        const hits = globSync(p);
        if (!hits.length) continue;
        out.push(...hits.map((h) => resolve(h)));
      } else out.push(p);
    }
  }
  if (!out.length) return undefined;
  // For nested duplicates (deleting a also deletes a/b), only back up the outer one
  const uniq = [...new Set(out)].sort();
  return uniq.filter((p) => !uniq.some((q) => q !== p && (q === "/" ? p !== "/" : p.startsWith(q + "/"))));
}

// ---------- small helpers ----------

function git(repo: string) {
  return (args: string[], timeout = 30_000) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
}
function tryOne(g: ReturnType<typeof git>, args: string[]) {
  try {
    return g(args);
  } catch {
    return "";
  }
}
function tryLines(g: ReturnType<typeof git>, args: string[]) {
  return lines(tryOne(g, args));
}
const lines = (s: string) => s.split("\n").filter(Boolean);

function gitRoot(dir: string): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function duBytes(p: string): number {
  try {
    return Number(execFileSync("du", ["-sk", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }).split(/\s/)[0]) * 1024 || 0;
  } catch {
    return Infinity; // if it can't be measured, treat it as too big
  }
}
