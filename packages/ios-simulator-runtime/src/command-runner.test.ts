import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("createNodeIOSSimulatorCommandRunner", () => {
  it("keeps draining a successful process after the output buffer fills", async () => {
    const result = await createNodeIOSSimulatorCommandRunner().run(
      process.execPath,
      [
        "-e",
        [
          "process.stdout.write('x'.repeat(4096));",
          "setTimeout(() => {",
          "  process.stdout.write('BUILD_FINISHED');",
          "}, 20);",
        ].join("\n"),
      ],
      { timeoutMs: 5_000, maxBufferBytes: 128 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toContain("BUILD_FINISHED");
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(128);
  });

  it.runIf(process.platform !== "win32")(
    "escalates a timed-out process group and settles even when SIGTERM is ignored",
    async () => {
      const startedAt = Date.now();
      const result = await createNodeIOSSimulatorCommandRunner().run(
        process.execPath,
        [
          "-e",
          [
            "process.on('SIGTERM', () => undefined);",
            "setInterval(() => undefined, 1000);",
          ].join("\n"),
        ],
        { timeoutMs: 100 },
      );

      expect(result.exitCode).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the escalation alive when the leader exits before its descendant",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "cindy-command-timeout-descendant-"),
      );
      tempRoots.push(root);
      const markerPath = path.join(root, "late-descendant.txt");
      const result = await createNodeIOSSimulatorCommandRunner().run(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            `spawn(process.execPath, ['-e', ${JSON.stringify(
              [
                "process.on('SIGTERM', () => undefined);",
                `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'late'), 1500);`,
                "setInterval(() => undefined, 1000);",
              ].join("\n"),
            )}], { stdio: 'ignore' });`,
            "process.on('SIGTERM', () => process.exit(0));",
            "setInterval(() => undefined, 1000);",
          ].join("\n"),
        ],
        { timeoutMs: 100 },
      );

      expect(result.exitCode).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "kills the detached process group when a build is aborted",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "cindy-command-abort-"),
      );
      tempRoots.push(root);
      const markerPath = path.join(root, "late-child.txt");
      const controller = new AbortController();
      const resultPromise = createNodeIOSSimulatorCommandRunner().run(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            `spawn(process.execPath, ['-e', ${JSON.stringify(
              `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'late'), 500)`,
            )}], { stdio: 'ignore' });`,
            "setInterval(() => undefined, 1000);",
          ].join("\n"),
        ],
        { timeoutMs: 5_000, signal: controller.signal },
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      await expect(resultPromise).resolves.toMatchObject({ exitCode: null });
      await new Promise((resolve) => setTimeout(resolve, 650));
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
