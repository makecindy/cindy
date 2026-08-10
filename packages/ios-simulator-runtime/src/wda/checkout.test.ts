import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { IOSSimulatorCommandRunner } from "../types.js";
import { inspectWdaCheckout } from "./checkout.js";
import { WDA_SOURCE_PIN } from "./source-pin.js";

const CHECKOUT_PATH = path.resolve("/tmp/wda");

function runnerWithRevision(revision: string): IOSSimulatorCommandRunner {
  return {
    run: vi.fn(async (command, args) => {
      if (command === "/usr/bin/git")
        return { stdout: `${revision}\n`, stderr: "", exitCode: 0 };
      if (command === "/usr/bin/xcodebuild") {
        return {
          stdout: JSON.stringify({
            project: { schemes: ["WebDriverAgentRunner"] },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }),
  };
}

describe("inspectWdaCheckout", () => {
  it("accepts only the pinned revision and required scheme", async () => {
    const runner = runnerWithRevision(WDA_SOURCE_PIN.revision);
    const result = await inspectWdaCheckout(CHECKOUT_PATH, runner);

    expect(result).toMatchObject({
      ready: true,
      revisionMatches: true,
      issue: null,
    });
    expect(runner.run).toHaveBeenNthCalledWith(1, "/usr/bin/git", [
      "-C",
      CHECKOUT_PATH,
      "rev-parse",
      "HEAD",
    ]);
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcodebuild",
      [
        "-project",
        path.join(CHECKOUT_PATH, "WebDriverAgent.xcodeproj"),
        "-list",
        "-json",
      ],
      { timeoutMs: 60_000, maxBufferBytes: 2 * 1024 * 1024 },
    );
  });

  it("fails before Xcode inspection when the revision differs", async () => {
    const runner = runnerWithRevision("deadbeef");
    const result = await inspectWdaCheckout(CHECKOUT_PATH, runner);

    expect(result).toMatchObject({ ready: false, issue: "REVISION_MISMATCH" });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("reports a missing scheme from structured xcodebuild output", async () => {
    const runner: IOSSimulatorCommandRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          stdout: `${WDA_SOURCE_PIN.revision}\n`,
          stderr: "",
          exitCode: 0,
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ project: { schemes: ["OtherScheme"] } }),
          stderr: "",
          exitCode: 0,
        }),
    };
    const result = await inspectWdaCheckout(CHECKOUT_PATH, runner);

    expect(result).toMatchObject({ ready: false, issue: "SCHEME_NOT_FOUND" });
  });
});
