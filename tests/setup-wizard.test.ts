import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSetup } from "../src/setup/wizard.js";

test("setup writes config and env with 600 permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-setup-"));
  const previous = { ...process.env };
  try {
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "secret-value";
    process.env.ATME_ME_OPEN_ID = "ou_me";
    process.env.ATME_APPROVER_OPEN_IDS = "ou_me";
    process.env.ATME_FILTER_BASE_URL = "https://example/v1";
    process.env.ATME_FILTER_MODEL = "cheap";
    process.env.ATME_FILTER_API_KEY = "key-value";
    process.env.ATME_PROJECT_WORKTREE = dir;

    const configPath = join(dir, "config.json");
    const envPath = join(dir, ".env");
    await runSetup({ configPath, envPath, nonInteractive: true });

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.platforms.feishu.appId, "cli_test");
    assert.equal(config.platforms.feishu.me.openId, "ou_me");
    assert.equal(config.filter.enabled, true);
    assert.equal(config.project.worktree, dir);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(envPath)).mode & 0o777, 0o600);

    const env = await readFile(envPath, "utf8");
    assert.match(env, /FEISHU_APP_SECRET=secret-value/);
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-interactive setup fails without required env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-setup-"));
  const previous = { ...process.env };
  try {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.ATME_ME_OPEN_ID;
    await assert.rejects(
      runSetup({
        configPath: join(dir, "config.json"),
        envPath: join(dir, ".env"),
        nonInteractive: true,
      }),
      /缺少环境变量/,
    );
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
