import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  applyDesktopDevStartupConfig,
  desktopUserDataDirForRegion,
  desktopUserDataDirNameForRegion,
  resolveDesktopDevRegion,
  resolveDesktopDevStartupConfig,
  resolveWorktreeIsolationFromCwd,
  stripDesktopDevRegionArgs,
  worktreeNameFromPath,
} from "../shared/desktop-dev-region.mjs";

test("desktop shared userData follows the region identity", () => {
  assert.equal(desktopUserDataDirNameForRegion(), "CindyGlobal");
  assert.equal(desktopUserDataDirNameForRegion("global"), "CindyGlobal");
  assert.equal(desktopUserDataDirNameForRegion("cn"), "Cindy");
  assert.equal(desktopUserDataDirNameForRegion("dev"), "CindyDev");
  assert.throws(() => desktopUserDataDirNameForRegion("us"), /expected cn, global or dev/);
});

test("desktop userData path follows platform appData rules and selected region", () => {
  assert.equal(
    desktopUserDataDirForRegion("global", "darwin", {}, "/Users/tester"),
    "/Users/tester/Library/Application Support/CindyGlobal",
  );
  assert.equal(
    desktopUserDataDirForRegion("cn", "linux", { XDG_CONFIG_HOME: "/tmp/config" }, "/home/tester"),
    "/tmp/config/Cindy",
  );
  assert.equal(
    desktopUserDataDirForRegion(
      "dev",
      "win32",
      { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
      "C:\\Users\\tester",
    ),
    "C:\\Users\\tester\\AppData\\Roaming\\CindyDev",
  );
});

test("desktop dev region defaults to global and keeps the legacy env fallback", () => {
  assert.equal(resolveDesktopDevRegion([], {}), "global");
  assert.equal(
    resolveDesktopDevRegion([], { CINDY_AUTH_REGION: "cn" }),
    "cn",
  );
});

test("desktop dev region accepts both CLI forms and overrides the legacy env", () => {
  assert.equal(resolveDesktopDevRegion(["--region=global"], {}), "global");
  assert.equal(
    resolveDesktopDevRegion(["--region", "cn"], {
      CINDY_AUTH_REGION: "global",
    }),
    "cn",
  );
});

test("desktop dev region rejects missing, duplicate, and unsupported values", () => {
  assert.throws(
    () => resolveDesktopDevRegion(["--region"], {}),
    /requires a value/,
  );
  assert.throws(
    () => resolveDesktopDevRegion(["--region=us"], {}),
    /expected cn, global or dev/,
  );
  assert.throws(
    () => resolveDesktopDevRegion(["--region=cn", "--region", "global"], {}),
    /may only be specified once/,
  );
});

test("remote dev selects the repository manifest matching the region", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: [],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.global.json",
    },
  );
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=cn"],
      env: {},
      mode: "remote",
    }),
    {
      region: "cn",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.json",
    },
  );
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global"],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/endpoint.global.json",
    },
  );
});

test("local dev applies the explicit region to the child environment", () => {
  const env = { VITE_CINDY_AUTH_REGION: "global" };
  assert.deepEqual(
    applyDesktopDevStartupConfig({
      argv: ["start", "--", "--region=cn"],
      env,
      mode: "local",
    }),
    {
      region: "cn",
      endpointsCdn: false,
      endpointManifestFile: undefined,
    },
  );
  assert.deepEqual(env, {
    CINDY_AUTH_REGION: "cn",
    VITE_CINDY_AUTH_REGION: "cn",
  });
});

test("--endpoints-cdn keeps the selected region and bypasses the default local manifest", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global", "--endpoints-cdn"],
      env: {},
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: true,
      endpointManifestFile: undefined,
    },
  );
});

test("--endpoints-cdn applies the selected region to the child process environment", () => {
  const env = {};
  applyDesktopDevStartupConfig({
    argv: ["--region=global", "--endpoints-cdn"],
    env,
    mode: "remote",
  });
  assert.deepEqual(env, {
    CINDY_AUTH_REGION: "global",
    VITE_CINDY_AUTH_REGION: "global",
    XDT_ENDPOINTS_CDN: "1",
  });
});

test("direct dev consumes the region flag before launching Electron Forge", () => {
  assert.deepEqual(
    stripDesktopDevRegionArgs([
      "start",
      "--",
      "--region",
      "global",
      "--passive",
    ]),
    ["start", "--", "--passive"],
  );
  assert.deepEqual(stripDesktopDevRegionArgs(["start", "--region=global"]), [
    "start",
  ]);
});

test("an explicit endpoint manifest override remains higher priority than the region default", () => {
  assert.deepEqual(
    resolveDesktopDevStartupConfig({
      argv: ["--region=global"],
      env: { XDT_ENDPOINT_MANIFEST_FILE: "config/custom-endpoint.json" },
      mode: "remote",
    }),
    {
      region: "global",
      endpointsCdn: false,
      endpointManifestFile: "config/custom-endpoint.json",
    },
  );
});

// ── worktree 自动隔离（issue #2635）──────────────────────────────────────────

const worktreeCwd = (...segments) => path.join(".cindy-worktrees", ...segments);

test("worktreeNameFromPath extracts the name from worktree root and nested cwd", () => {
  assert.equal(worktreeNameFromPath(worktreeCwd("epic-thompson")), "epic-thompson");
  assert.equal(
    worktreeNameFromPath(worktreeCwd("epic-thompson", "apps", "desktop")),
    "epic-thompson",
  );
  // 迁移前的旧目录形态同样识别
  assert.equal(
    worktreeNameFromPath(path.join(".xdt-worktrees", "legacy-tree")),
    "legacy-tree",
  );
  // 非 worktree 路径一律 null
  assert.equal(worktreeNameFromPath(path.join("somewhere", "else")), null);
  assert.equal(worktreeNameFromPath("."), null);
});

test("worktree dev launch auto-derives the named isolation sandbox", () => {
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: {},
    }),
    { worktreeName: "epic-thompson" },
  );
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson", "apps", "desktop"),
      argv: ["start", "--"],
      env: {},
    }),
    { worktreeName: "epic-thompson" },
  );
  // 旧目录形态同样命中
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: path.join(".xdt-worktrees", "legacy-tree"),
      argv: [],
      env: {},
    }),
    { worktreeName: "legacy-tree" },
  );
});

test("worktree dev launch honors explicit isolation/sharing intent and never overrides it", () => {
  for (const argv of [
    ["--isolated"],
    ["--isolated=feature-a"],
    ["--passive"],
    ["--preserve-running"],
    ["start", "--", "--isolated=feature-a"],
  ]) {
    assert.equal(
      resolveWorktreeIsolationFromCwd({
        cwd: worktreeCwd("epic-thompson"),
        argv,
        env: {},
      }),
      null,
      `argv ${JSON.stringify(argv)} must suppress auto-isolation`,
    );
  }
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_ISOLATED: "1" },
    }),
    null,
  );
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_USER_DATA_DIR: "C:\\custom\\profile" },
    }),
    null,
  );
  // restart --passive / --preserve-running 只透传 XDT_SCHEDULER_PASSIVE=1（argv 侧
  // 没有 --passive / --preserve-running）——共享意图必须被识别，防止误隔离
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_SCHEDULER_PASSIVE: "1" },
    }),
    null,
  );
  // restart 链路显式表态：参数契约由 restart 自己负责（无参=共库+正常调度），
  // 自动隔离兜底不得静默覆盖（review-pr P1，PR #2640）
  assert.equal(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("epic-thompson"),
      argv: [],
      env: { XDT_RESTART_MANAGED: "1" },
    }),
    null,
  );
});

test("worktree dev launch outside a managed worktree keeps the shared-profile semantics", () => {
  assert.equal(
    resolveWorktreeIsolationFromCwd({ cwd: path.join("base", "repo"), argv: [], env: {} }),
    null,
  );
  assert.equal(
    resolveWorktreeIsolationFromCwd({ cwd: ".", argv: [], env: {} }),
    null,
  );
});

test("worktree dev launch falls back to the default sandbox for invalid names", () => {
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("invalid-name-with-1234567890-1234567890-1234567890-123"),
      argv: [],
      env: {},
    }),
    { worktreeName: null },
  );
  assert.deepEqual(
    resolveWorktreeIsolationFromCwd({
      cwd: worktreeCwd("has space"),
      argv: [],
      env: {},
    }),
    { worktreeName: null },
  );
});
