import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const run = promisify(execFile);

it.skipIf(process.platform !== "darwin")(
  "executes the helper's screen-target and delivery-completion regression checks",
  async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "cindy-hid-checks-"),
    );
    const nativeRoot = fileURLToPath(new URL("../../native/", import.meta.url));
    const binary = path.join(directory, "hid-checks");
    try {
      await run(
        "/usr/bin/xcrun",
        [
          "swiftc",
          path.join(nativeRoot, "hid-compatibility.swift"),
          path.join(nativeRoot, "tests/hid-compatibility-checks.swift"),
          "-o",
          binary,
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      const { stdout } = await run(binary, [], { timeout: 5_000 });
      expect(JSON.parse(stdout)).toEqual([
        "legacy target",
        "screen 1 target",
        "non-default screen target",
        "screen identity mismatch",
        "screen ID flag collision",
        "indirect screen 1",
        "indirect screen 2",
        "missing screen",
        "missing binding",
        "disconnected screen",
        "incomplete screen properties",
        "asynchronous completion",
        "delivery error propagation",
        "bounded completion timeout",
        "late and duplicate completion",
        "completed sends keep input available",
        "completed failure does not poison the sequence",
        "timeout rejects queued send before message construction",
        "late completion cannot re-arm timed-out input",
        "fresh helper sequence accepts recovery release",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  70_000,
);
