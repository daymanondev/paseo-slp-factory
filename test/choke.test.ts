import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeFilePath, judgeShellCommand, refuseGitArgv, shellTokens, writableRootsFor } from "../src/choke.ts";
import { GIT_ARGV_CASES, SHELL_CASES, shellRoots } from "./choke-cases.ts";

/**
 * The choke policy against ticket 01's exact-token contract: the shared case
 * tables (GIT_ARGV_CASES, SHELL_CASES) plus the tokenizer and the write/edit
 * rider. The git table is ALSO run against the plain-JS shim mirror in
 * test/git-shim.test.ts — one table, two implementations, no drift.
 */

test("refuseGitArgv matches every case in the shared table (refused forms and benign neighbors)", () => {
  for (const { argv, rule, note } of GIT_ARGV_CASES) {
    const refusal = refuseGitArgv(argv);
    if (rule === null) {
      assert.equal(refusal, undefined, `"git ${argv.join(" ")}" must pass through${note === undefined ? "" : ` (${note})`}`);
    } else {
      assert.ok(refusal !== undefined, `"git ${argv.join(" ")}" must be refused${note === undefined ? "" : ` (${note})`}`);
      assert.equal(refusal.rule, rule, `"git ${argv.join(" ")}" refusal rule`);
      assert.ok(refusal.reason.length > 10, "each refusal carries a one-line reason saying what it destroys");
    }
  }
});

test("judgeShellCommand matches every case in the shared table (S1, S2, and the benign corpus)", () => {
  const roots = shellRoots();
  for (const { command, rule, note } of SHELL_CASES) {
    const decision = judgeShellCommand(command, roots);
    if (rule === null) {
      assert.equal(decision.behavior, "allow", `"${command}" must be allowed${note === undefined ? "" : ` (${note})`}`);
    } else {
      assert.ok(decision.behavior === "deny", `"${command}" must be denied${note === undefined ? "" : ` (${note})`}`);
      assert.equal(decision.rule, rule, `"${command}" deny rule`);
    }
  }
});

test("S1 names the underlying git rule inside its reason — the deny line teaches, not just blocks", () => {
  const decision = judgeShellCommand("/usr/bin/git push --force origin main", shellRoots());
  assert.equal(decision.behavior, "deny");
  assert.match(decision.reason, /git:force-push/);
});

test("the tokenizer exposes quoted and glued words as plain tokens", () => {
  assert.deepEqual(shellTokens("bash -c 'git push --force'"), ["bash", "-c", "git", "push", "--force"]);
  assert.deepEqual(shellTokens("echo \"done\" >>out.txt"), ["echo", "done", ">>out.txt"]);
  assert.deepEqual(shellTokens("$(git reset --hard); make"), ["git", "reset", "--hard", "make"]);
  assert.deepEqual(shellTokens("it's fine"), ["it's", "fine"], "an apostrophe inside a word is not quoting");
});

test("relative destinations resolve against the workspace and stay allowed; ~ expands to the injected home", () => {
  const roots = shellRoots();
  assert.equal(judgeShellCommand("echo x > report.txt", roots).behavior, "allow");
  assert.equal(judgeShellCommand("echo x > ~/notes.txt", roots).behavior, "deny");
  assert.equal(judgeShellCommand("echo x > /home/notes.txt", roots).behavior, "deny", "~ and its expansion judge the same");
});

test("the write/edit rider denies file asks outside the writable set and allows everything inside it", () => {
  const roots = shellRoots();
  assert.equal(judgeFilePath("/ws/proj/src/x.ts", roots).behavior, "allow");
  assert.equal(judgeFilePath("src/x.ts", roots).behavior, "allow");
  assert.equal(judgeFilePath("/tmp/dump.txt", roots).behavior, "allow");
  assert.equal(judgeFilePath("/state/anything", roots).behavior, "allow");
  assert.equal(judgeFilePath("~/.ssh/authorized_keys", roots).behavior, "deny");
  assert.equal(judgeFilePath("/home/.bashrc", roots).behavior, "deny");
  assert.equal(judgeFilePath("/etc/hosts", roots).behavior, "deny");
  const deny = judgeFilePath("~/.paseo/config.json", roots);
  assert.equal(deny.behavior, "deny");
  assert.equal(deny.rule, "policy:file-write-outside-writable");
});

test("writableRootsFor carries TMPDIR when the plugin process has one", () => {
  const roots = writableRootsFor("/ws", "/state", "/home", { TMPDIR: "/var/folders/zz/T/" });
  assert.deepEqual(roots.tmp, ["/tmp", "/dev/null", "/var/folders/zz/T"], "trailing slash normalized");
  assert.deepEqual(writableRootsFor("/ws/", "/state", "/home", {}).workspace, "/ws", "workspace trailing slash normalized");
});
