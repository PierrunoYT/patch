// Installed-application acceptance for the ordering in aider/coders/base_coder.py
// at 5dc9490bb35f9729ef2c95d00a19ccd30c26339c. Patch intentionally preserves
// working files on undo and requires embedding approval for suggested commands.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const { ConcreteApplicationService, FakeProvider } = await import(
  pathToFileURL(process.argv[2]).href
);
const root = await mkdtemp(join(tmpdir(), "patch-installed-lifecycle-"));
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const read = (path) => readFile(join(root, path), "utf8");
const edit = (path, before, after) =>
  `${path}\n\`\`\`txt\n<<<<<<< SEARCH\n${before}\n=======\n${after}\n>>>>>>> REPLACE\n\`\`\`\n`;
let service;
try {
  git("init", "--quiet");
  git("config", "user.name", "Patch Test");
  git("config", "user.email", "patch@test.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  await writeFile(join(root, "left.txt"), "left base\n");
  await writeFile(join(root, "right.txt"), "right base\n");
  await writeFile(join(root, "unrelated.txt"), "unrelated base\n");
  await writeFile(
    join(root, "lint.cjs"),
    `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const left = fs.readFileSync('left.txt', 'utf8');
    assert.equal(execFileSync('git', ['show', 'HEAD:left.txt'], {encoding:'utf8'}), left);
    if (left === 'left interim\\n') {
      assert.equal(fs.readFileSync('right.txt', 'utf8'), 'right interim\\n');
      fs.writeFileSync('right.txt', 'right lint fix\\n');
      console.error('left must become final');
      process.exit(7);
    }
    assert.equal(left, 'left final\\n');
    assert.equal(fs.readFileSync('right.txt', 'utf8'), 'right final\\n');
  `,
  );
  await writeFile(
    join(root, "test.cjs"),
    `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    assert.equal(fs.readFileSync('.git/command-ran', 'utf8'), 'approved');
    assert.equal(fs.readFileSync('right.txt', 'utf8'), 'right final\\n');
  `,
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  await writeFile(join(root, "left.txt"), "left dirty\n");
  await writeFile(join(root, "unrelated.txt"), "unrelated staged\n");
  git("add", "unrelated.txt");
  await writeFile(join(root, "unrelated.txt"), "unrelated unstaged\n");
  const unrelatedIndex = git("diff", "--cached", "--", "unrelated.txt");
  const unrelatedWorktree = git("diff", "--", "unrelated.txt");
  const shell = `node -e "require('fs').writeFileSync('.git/command-ran','approved')"`;
  const provider = new FakeProvider(
    [
      "left.txt\n```txt\n<<<<<<< SEARCH\nmalformed",
      edit("left.txt", "not present", "wrong"),
      edit("left.txt", "left dirty", "left interim") +
        edit("right.txt", "right base", "right interim"),
      edit("left.txt", "left interim", "left final") +
        edit("right.txt", "right lint fix", "right final") +
        `\`\`\`sh\n${shell}\n\`\`\``,
    ].map((text) => ({
      actions: [
        { type: "text-delta", text: text.slice(0, 17) },
        { type: "text-delta", text: text.slice(17) },
        { type: "usage", inputTokens: 31, outputTokens: 13, cost: 0.01 },
        { type: "finish", reason: "stop" },
      ],
    })),
  );
  service = await ConcreteApplicationService.create({
    cwd: root,
    home: root,
    environment: {},
    argv: [
      "--model",
      "4o",
      "--file",
      "left.txt",
      "--file",
      "right.txt",
      "--lint-cmd",
      "node lint.cjs",
      "--test-cmd",
      "node test.cjs",
    ],
    dependencies: {
      provider,
      approveCommand: (command) => {
        assert.equal(command.trim(), shell);
        assert.equal(git("show", "HEAD:left.txt"), "left final\n");
        assert.equal(git("show", "HEAD:right.txt"), "right final\n");
        return true;
      },
    },
  });
  const session = await service.createSession({
    principal: "test",
    sessionId: "installed",
  });
  const events = [];
  const options = {
    signal: new globalThis.AbortController().signal,
    emit: (event) => {
      events.push(event.type);
    },
  };
  const result = await session.submit("make asymmetric changes", options);
  assert.deepEqual(result.changedPaths, ["left.txt", "right.txt"]);
  assert.equal(result.commit, git("rev-parse", "HEAD").trim());
  assert.equal(result.commands[0].status, "completed");
  assert.equal(await read("left.txt"), "left final\n");
  assert.equal(await read("right.txt"), "right final\n");
  assert.equal(git("show", "HEAD~3:left.txt"), "left dirty\n");
  assert.equal(
    git("log", "-5", "--format=%s"),
    "Apply Patch edits\nApply lint changes\nApply Patch edits\nCheckpoint before Patch edits\nbase\n",
  );
  assert.equal(git("diff", "--cached", "--", "unrelated.txt"), unrelatedIndex);
  assert.equal(git("diff", "--", "unrelated.txt"), unrelatedWorktree);
  const state = await session.snapshot();
  assert.equal(state.phase, "waiting");
  assert.equal(state.reflectionCount, 3);
  assert.equal(state.totalCost, 0.04);
  assert.equal(state.messages.length, 8);
  assert.deepEqual(state.pendingEdits, []);
  assert(
    provider.requests[3].messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("right lint fix\n```"),
    ),
  );
  assert.deepEqual(
    events.filter((type) =>
      [
        "edit-preview",
        "lint-start",
        "lint-complete",
        "command-preview",
        "test-start",
        "test-complete",
      ].includes(type),
    ),
    [
      "edit-preview",
      "lint-start",
      "lint-complete",
      "edit-preview",
      "lint-start",
      "lint-complete",
      "command-preview",
      "test-start",
      "test-complete",
    ],
  );
  const parent = git("rev-parse", "HEAD^").trim();
  await session.submit("/undo", options);
  assert.equal(git("rev-parse", "HEAD").trim(), parent);
  assert.equal(git("show", ":left.txt"), "left interim\n");
  assert.equal(git("show", ":right.txt"), "right lint fix\n");
  assert.equal(await read("left.txt"), "left final\n");
  assert.equal(await read("right.txt"), "right final\n");
  assert.equal(git("diff", "--cached", "--", "unrelated.txt"), unrelatedIndex);
  assert.equal(git("diff", "--", "unrelated.txt"), unrelatedWorktree);
  assert.equal((await session.snapshot()).lastPatchCommit, null);
  process.stdout.write("installed-lifecycle-ok\n");
} finally {
  await service?.close();
  await rm(root, { recursive: true, force: true });
}
