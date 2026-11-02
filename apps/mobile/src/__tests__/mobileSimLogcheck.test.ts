import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeMetroLog,
  logcheckExitCode,
  metroLogEnv,
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
        " WARN  [device-link] relay connection error WebSocket error",
      ].join("\n"),
      knownWarnings,
    );
    expect(result.newWarnings).toEqual([]);
    expect(result.knownWarningCount).toBe(4);
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
