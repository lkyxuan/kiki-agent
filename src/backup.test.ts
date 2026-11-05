import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActionLog } from "./actions.js";
import { backupFor, parseShell, rmTargets, undo } from "./backup.js";

const tmp = () => mkdtempSync(join(tmpdir(), "kiki-bk-"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "k@k");
  git(dir, "config", "user.name", "k");
  writeFileSync(join(dir, "a.txt"), "v1");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "one");
  return dir;
}

test("parse command: recognizes cd, quotes, globs, redirects; anything with $ is not recognized", () => {
  assert.deepEqual(parseShell(`cd /x && rm -rf "a b" c 2>&1 | tee log`), [["cd", "/x"], ["rm", "-rf", "a b", "c"], ["tee", "log"]]);
  assert.equal(parseShell("rm -rf $HOME"), undefined);
  const d = tmp();
  writeFileSync(join(d, "1.log"), "");
  writeFileSync(join(d, "2.log"), "");
  mkdirSync(join(d, "k"));
  assert.deepEqual(rmTargets(parseShell(`cd ${d} && rm -f *.log k k/inner`)!, "/"), [join(d, "1.log"), join(d, "2.log"), join(d, "k")]);
});

test("rm: copies first, undo puts it back in place (does not overwrite an existing file of the same name)", () => {
  const data = tmp();
  const w = tmp();
  mkdirSync(join(w, "proj"));
  writeFileSync(join(w, "proj", "x.txt"), "keep me");
  const b = backupFor(data, "rm.recursive-force-outside-cwd", `rm -rf ${w}/proj`, "/");
  assert.ok("undo" in b, JSON.stringify(b));
  rmSync(join(w, "proj"), { recursive: true });
  const log = new ActionLog(data);
  const a = log.add({ agent: "dev", path: "/s", category: "delete", categoryName: "Permanent delete", label: "rm", detail: "rm", note: b.note, undo: b.undo });
  assert.match(log.undo(a.id), /put back/);
  assert.equal(readFileSync(join(w, "proj", "x.txt"), "utf8"), "keep me");
  assert.equal(log.list()[0].undone !== undefined, true);
  assert.ok(backupFor(data, "rm.recursive-force-outside-cwd", "rm -rf $X", "/").hasOwnProperty("error"));
  assert.ok("error" in backupFor(data, "disk.erase", "diskutil eraseDisk x", "/"));
  assert.ok("error" in backupFor(data, "find.delete", "find . -delete", "/"));
});

test("git reset --hard / clean: saves the repo state first, undo returns to before (changes, untracked files, stash all come back)", () => {
  const data = tmp();
  const r = repo(join(tmp(), "r"));
  writeFileSync(join(r, "a.txt"), "changed but not committed");
  writeFileSync(join(r, "new.txt"), "untracked");
  writeFileSync(join(r, "s.txt"), "in the stash");
  git(r, "add", "s.txt");
  git(r, "stash", "push", "-q", "--", "s.txt");
  const b = backupFor(data, "git.reset-hard", `cd ${r} && git reset --hard && git clean -fd && git stash clear`, "/");
  assert.ok("undo" in b, JSON.stringify(b));
  git(r, "reset", "-q", "--hard");
  git(r, "clean", "-qfd");
  git(r, "stash", "clear");
  assert.equal(readFileSync(join(r, "a.txt"), "utf8"), "v1");
  assert.equal(existsSync(join(r, "new.txt")), false);
  undo(b.undo);
  assert.equal(readFileSync(join(r, "a.txt"), "utf8"), "changed but not committed");
  assert.equal(readFileSync(join(r, "new.txt"), "utf8"), "untracked");
  assert.equal(git(r, "stash", "list").split("\n").filter(Boolean).length, 1);
});

test("git delete branch: undo brings the branch back", () => {
  const data = tmp();
  const r = repo(join(tmp(), "r"));
  git(r, "branch", "feature");
  const b = backupFor(data, "git.branch-force-delete", "git branch -D feature", r);
  assert.ok("undo" in b);
  git(r, "branch", "-D", "feature");
  undo(b.undo);
  assert.match(git(r, "branch"), /feature/);
});

test("force push: saves the remote branch locally first, undo pushes it back as it was", () => {
  const data = tmp();
  const base = tmp();
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const r = repo(join(base, "r"));
  git(r, "remote", "add", "origin", remote);
  git(r, "push", "-q", "origin", "main");
  const before = git(r, "rev-parse", "HEAD");
  git(r, "commit", "-q", "--amend", "-m", "rewrite history");
  const b = backupFor(data, "git.push-force", "git push --force origin main", r);
  assert.ok("undo" in b, JSON.stringify(b));
  git(r, "push", "-q", "--force", "origin", "main");
  assert.notEqual(git(remote, "rev-parse", "main"), before);
  assert.match(undo(b.undo), /pushed back as it was: main/);
  assert.equal(git(remote, "rev-parse", "main"), before);
  assert.match(undo(b.undo), /nothing to change/);
});

test("force push undo: only touches the branch pushed this time; does not overwrite if someone else pushed since", () => {
  const data = tmp();
  const base = tmp();
  const remote = join(base, "remote.git");
  git(base, "init", "-q", "--bare", "-b", "main", remote);
  const r = repo(join(base, "r"));
  git(r, "remote", "add", "origin", remote);
  git(r, "branch", "other");
  git(r, "push", "-q", "origin", "main", "other");
  const before = git(r, "rev-parse", "HEAD");
  git(r, "commit", "-q", "--amend", "-m", "rewrite history");
  const b = backupFor(data, "git.push-force", "git push -f", r);
  assert.ok("undo" in b, JSON.stringify(b));
  git(r, "push", "-q", "--force", "origin", "main");
  // another branch was pushed afterwards: undo must not touch it
  git(r, "push", "-q", "--force", "origin", "HEAD:other");
  const other = git(remote, "rev-parse", "other");
  assert.match(undo(b.undo), /pushed back as it was: main/);
  assert.equal(git(remote, "rev-parse", "main"), before);
  assert.equal(git(remote, "rev-parse", "other"), other);

  // main was pushed by someone else afterwards: do not overwrite automatically
  const b2 = backupFor(data, "git.push-force", "git push --force origin main", r);
  assert.ok("undo" in b2);
  git(r, "push", "-q", "--force", "origin", "main");
  writeFileSync(join(r, "b.txt"), "x");
  git(r, "add", ".");
  git(r, "commit", "-qm", "someone else pushed again");
  git(r, "push", "-q", "origin", "main");
  const later = git(remote, "rev-parse", "main");
  assert.match(undo(b2.undo), /pushed to by someone else afterward and were not overwritten automatically/);
  assert.equal(git(remote, "rev-parse", "main"), later);
});

test("git command does not reveal which repo it acts on: do not guess, do nothing", () => {
  const r = repo(join(tmp(), "r"));
  const b = backupFor(tmp(), "git.reset-hard", 'git -C "$TARGET" reset --hard', r);
  assert.ok("error" in b);
});
