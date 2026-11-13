import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeMetroLog,
  logcheckExitCode,
  metroLogEnv,
  prepareMetroLog,
  removeMetroLog,
} from "../../scripts/lib/sim-logcheck.mjs";
import knownWarnings from "../../scripts/sim-logcheck-known-warnings.json";

const BUNDLED = "iOS Bundled 128ms apps/mobile/index.js (5611 modules)";

describe("mobile:sim:logcheck analysis", () => {
  it("ignores errors from code replaced by a later bundle", () => {
    const result = analyzeMetroLog(
      [" ERROR  SyntaxError: old", BUNDLED, " LOG  ok"].join("\n"),
    );
    expect(result.errors).toEqual([]);
    expect(logcheckExitCode(result)).toBe(0);
  });

  // Regression 2026-11-02: a remote-desktop TypeError sat unnoticed in the Metro log.
  it("fails on an error after the latest bundle and reports its log line", () => {
    const result = analyzeMetroLog(
      [
        BUNDLED,
        " ERROR  [TypeError: Cannot read property 'left' of undefined]",
      ].join("\n"),
    );
    expect(result.errors).toMatchObject([
      {
        line: 2,
        message: "[TypeError: Cannot read property 'left' of undefined]",
      },
    ]);
    expect(logcheckExitCode(result)).toBe(1);
  });

  it("does not let a lazily bundled module reset the checked range", () => {
    const result = analyzeMetroLog(
      [
        BUNDLED,
        " ERROR  boom",
        "iOS Bundled 11ms apps/mobile/src/session/incomingShareCleanup.ts (1 module)",
      ].join("\n"),
    );
    expect(logcheckExitCode(result)).toBe(1);
  });

  it("fails when the latest bundle failed, even with no successful bundle", () => {
    const result = analyzeMetroLog(
      `${BUNDLED}\niOS Bundling failed 80ms apps/mobile/index.js`,
    );
    expect(logcheckExitCode(result)).toBe(1);
    expect(
      logcheckExitCode(
        analyzeMetroLog("iOS Bundling failed 80ms apps/mobile/index.js"),
      ),
    ).toBe(1);
  });

  it("cannot pass before anything was bundled", () => {
    expect(
      logcheckExitCode(
        analyzeMetroLog("# sim-start port=8081\nStarting Metro Bundler"),
      ),
    ).toBe(2);
  });

  it("reads colored terminal output with carriage-return progress updates", () => {
    const result = analyzeMetroLog(
      `\x1b[2K\x1b[1G iOS Bundling 45%\r\x1b[32m${BUNDLED}\x1b[39m\n\x1b[31m ERROR \x1b[39m boom\n`,
    );
    expect(result.bundled).toBe(true);
    expect(result.errors).toMatchObject([{ message: "boom" }]);
  });

  it("passes with new warnings listed, grouping repeats that differ only by numbers", () => {
    const result = analyzeMetroLog(
      [BUNDLED, " WARN  slow request 120ms", " WARN  slow request 450ms"].join(
        "\n",
      ),
    );
    expect(result.newWarnings).toMatchObject([
      { message: "slow request 120ms", count: 2, line: 2 },
    ]);
    expect(logcheckExitCode(result)).toBe(0);
  });

  it("matches the warnings seen in real Metro logs against the known list", () => {
    const result = analyzeMetroLog(
      [
        BUNDLED,
        " WARN  Sending `onAnimatedValueUpdate` with no listeners registered.",
        ' WARN  Attempted to import the module "/repo/node_modules/@noble/hashes/crypto.js" which is not listed in the "exports" of "/repo/node_modules/@noble/hashes"',
        " WARN  Require cycle: ../../packages/model-providers/src/modelMetadataLayers.ts -> ../../packages/model-providers/src/modelGeneration.ts -> ../../packages/model-providers/src/modelMetadataLayers.ts",
      ].join("\n"),
      knownWarnings,
    );
    expect(result.newWarnings).toEqual([]);
    expect(result.knownWarningCount).toBe(3);
  });

  // Review #8560: device-link warnings (including relay auth failures) and other missing listeners stay visible.
  it("still reports device-link warnings and unlisted missing listeners as new warnings", () => {
    const result = analyzeMetroLog(
      [
        BUNDLED,
        " WARN  [device-link] relay connection error Unexpected server response: 401",
        " WARN  Sending `onPushNotificationReceived` with no listeners registered.",
      ].join("\n"),
      knownWarnings,
    );
    expect(result.newWarnings).toHaveLength(2);
    expect(result.knownWarningCount).toBe(0);
  });
});

describe("Metro log preload", () => {
  const run = (args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "metro-log-tee-"));
    try {
      const logPath = join(dir, "with space.log");
      const script = join(dir, "x.cjs");
      writeFileSync(script, "console.log('out'); console.error('err')");
      const output = execFileSync(process.execPath, [script, ...args], {
        env: { ...process.env, ...metroLogEnv(logPath, "--no-warnings") },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      let log = "";
      try {
        log = readFileSync(logPath, "utf8");
      } catch {
        // 预加载没有生效时不会创建文件。
      }
      return { output, log };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("copies output of `expo start` while keeping the original stdout", () => {
    expect(run(["start", "--port", "8081"])).toEqual({
      output: "out\n",
      log: "out\nerr\n",
    });
  });

  it("leaves pnpm and other processes that inherit NODE_OPTIONS alone", () => {
    expect(run(["exec", "expo", "start"])).toEqual({
      output: "out\n",
      log: "",
    });
  });
});

// 日志丢了一段后留下的是不完整内容,logcheck 读到它可能漏掉后面的 ERROR 而误判通过。
describe("incomplete Metro log", () => {
  const { installTee } = createRequire(import.meta.url)(
    "../../scripts/lib/metro-log-tee.cjs",
  ) as { installTee: (options: Record<string, unknown>) => void };

  it("discards the log when a write fails, and keeps the original output flowing", () => {
    const original = vi.fn((_chunk: string) => true);
    const stream = { write: original };
    const fsImpl = {
      openSync: vi.fn(() => 7),
      writeSync: vi.fn(() => {
        throw new Error("ENOSPC");
      }),
      ftruncateSync: vi.fn(),
      unlinkSync: vi.fn(() => {
        throw new Error("EPERM");
      }),
      closeSync: vi.fn(),
    };
    installTee({ logPath: "/logs/metro.log", streams: [stream], fsImpl });
    stream.write("first");
    stream.write("second");
    // Review #8560: the directory may forbid deleting, so the open file is emptied first.
    expect(fsImpl.ftruncateSync).toHaveBeenCalledExactlyOnceWith(7, 0);
    expect(fsImpl.unlinkSync).toHaveBeenCalledExactlyOnceWith(
      "/logs/metro.log",
    );
    expect(fsImpl.writeSync).toHaveBeenCalledOnce();
    expect(original).toHaveBeenCalledTimes(2);
  });

  // Review #8560: writeSync can return a partial count without throwing when the disk fills.
  it("discards the log when a write is cut short without an error", () => {
    const stream = { write: vi.fn((_chunk: string) => true) };
    const fsImpl = {
      openSync: vi.fn(() => 7),
      writeSync: vi.fn().mockReturnValueOnce(3).mockReturnValueOnce(0),
      ftruncateSync: vi.fn(),
      unlinkSync: vi.fn(),
    };
    installTee({ logPath: "/logs/metro.log", streams: [stream], fsImpl });
    stream.write(" ERROR  boom");
    expect(fsImpl.writeSync).toHaveBeenCalledTimes(2);
    expect(fsImpl.ftruncateSync).toHaveBeenCalledExactlyOnceWith(7, 0);
    expect(fsImpl.unlinkSync).toHaveBeenCalledExactlyOnceWith(
      "/logs/metro.log",
    );
  });

  it("discards a stale log when it cannot be opened for appending", () => {
    const fsImpl = {
      openSync: vi.fn(() => {
        throw new Error("EACCES");
      }),
      truncateSync: vi.fn(),
      unlinkSync: vi.fn(),
    };
    installTee({ logPath: "/logs/metro.log", streams: [], fsImpl });
    expect(fsImpl.truncateSync).toHaveBeenCalledExactlyOnceWith(
      "/logs/metro.log",
      0,
    );
    expect(fsImpl.unlinkSync).toHaveBeenCalledExactlyOnceWith(
      "/logs/metro.log",
    );
  });

  // Review #8560: each launch gets its own private, unpredictable directory under the system temp dir.
  it("creates each log in a fresh private directory outside the worktree and removes it with Metro", () => {
    const first = prepareMetroLog(8081, { source: "s", region: "global" });
    const second = prepareMetroLog(8081, { source: "s", region: "global" });
    try {
      expect(first).not.toBeNull();
      expect(dirname(first!)).not.toBe(dirname(second!));
      expect(relative(tmpdir(), first!).startsWith("..")).toBe(false);
      // POSIX permission bits only; Windows reports synthetic modes and protects temp dirs by ACL.
      if (process.platform !== "win32") {
        expect(statSync(dirname(first!)).mode & 0o777).toBe(0o700);
      }
      expect(readFileSync(first!, "utf8")).not.toContain("Bundled");
    } finally {
      removeMetroLog(first);
      removeMetroLog(second);
    }
    expect(existsSync(dirname(first!))).toBe(false);
    expect(existsSync(dirname(second!))).toBe(false);
  });

  it("never removes a directory it did not create", () => {
    const outside = mkdtempSync(join(tmpdir(), "not-a-metro-log-"));
    try {
      writeFileSync(join(outside, "metro-8081.log"), "keep");
      removeMetroLog(join(outside, "metro-8081.log"));
      expect(existsSync(join(outside, "metro-8081.log"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
