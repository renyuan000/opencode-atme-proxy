import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/core/config.js";

const base = {
  version: 1,
  platforms: {
    feishu: {
      appId: "cli_test",
      me: { openId: "ou_me" },
      approvers: [{ openId: "ou_me" }],
      groups: [{ chatId: "oc_1", enabled: true }],
    },
  },
  filter: { enabled: false },
  repos: [],
};

test("loads config and resolves env secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(base), "utf8");
    const env = { FEISHU_APP_SECRET: "secret-value", HOME: dir } as NodeJS.ProcessEnv;
    const loaded = await loadConfig({ path, env });
    assert.equal(loaded.config.platforms.feishu.appId, "cli_test");
    assert.equal(loaded.secrets.appSecret, "secret-value");
    assert.equal(loaded.config.filter.enabled, false);
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("env overrides config values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(
      path,
      JSON.stringify({ ...base, platforms: { feishu: { ...base.platforms.feishu, appId: "cli_file" } } }),
      "utf8",
    );
    const env = {
      FEISHU_APP_ID: "cli_env",
      ATME_ME_OPEN_ID: "ou_env",
      FEISHU_APP_SECRET: "s",
      HOME: dir,
    } as NodeJS.ProcessEnv;
    const loaded = await loadConfig({ path, env });
    assert.equal(loaded.config.platforms.feishu.appId, "cli_env");
    assert.equal(loaded.config.platforms.feishu.me.openId, "ou_env");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing required fields fails with field path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, platforms: { feishu: { appId: "" } } }), "utf8");
    await assert.rejects(loadConfig({ path, env: { HOME: dir } as NodeJS.ProcessEnv }), /feishu\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing app secret fails clearly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(base), "utf8");
    await assert.rejects(
      loadConfig({ path, env: { HOME: dir } as NodeJS.ProcessEnv }),
      /app secret/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tightens overly permissive config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atme-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify(base), "utf8");
    await chmod(path, 0o644);
    await loadConfig({ path, env: { HOME: dir, FEISHU_APP_SECRET: "s" } as NodeJS.ProcessEnv });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
