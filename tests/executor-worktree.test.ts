import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitExecutor } from "../src/core/executor.js";

const run = promisify(execFile);

async function repo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await run("git", ["init", "-q"], { cwd: path });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: path });
  await run("git", ["config", "user.name", "test"], { cwd: path });
  await writeFile(join(path, "README.md"), "# test\n");
  await run("git", ["add", "README.md"], { cwd: path });
  await run("git", ["commit", "-qm", "init"], { cwd: path });
}

test("prepares sibling project worktrees under one task workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-executor-"));
  try {
    const engine = join(dir, "asd-engine");
    const transform = join(dir, "asd-transform");
    await repo(engine);
    await repo(transform);
    const executor = new GitExecutor({
      worktreeRoot: join(dir, "global"),
      timeoutMs: 10_000,
    });
    const root = join(dir, "task", "repos");
    const engineTree = await executor.prepare(
      {
        id: "asd-engine",
        path: engine,
        defaultBranch: "HEAD",
        testCommand: [],
        lintCommand: [],
        allowPush: false,
        allowMerge: false,
      },
      "task-1",
      { root, name: "asd-engine" },
    );
    const transformTree = await executor.prepare(
      {
        id: "asd-transform",
        path: transform,
        defaultBranch: "HEAD",
        testCommand: [],
        lintCommand: [],
        allowPush: false,
        allowMerge: false,
      },
      "task-1",
      { root, name: "asd-transform" },
    );

    assert.equal(engineTree.path, join(root, "asd-engine"));
    assert.equal(transformTree.path, join(root, "asd-transform"));
    assert.equal((await stat(engineTree.path)).isDirectory(), true);
    assert.equal((await stat(transformTree.path)).isDirectory(), true);

    const passed = await executor.runConfiguredCommands(
      {
        id: "asd-engine",
        path: engine,
        defaultBranch: "HEAD",
        testCommand: [["node", "-e", "process.exit(0)"]],
        lintCommand: [],
        allowPush: false,
        allowMerge: false,
      },
      engineTree,
    );
    assert.equal(passed.passed, true);
    const failed = await executor.runConfiguredCommands(
      {
        id: "asd-engine",
        path: engine,
        defaultBranch: "HEAD",
        testCommand: [["node", "-e", "process.exit(1)"]],
        lintCommand: [],
        allowPush: false,
        allowMerge: false,
      },
      engineTree,
    );
    assert.equal(failed.passed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
