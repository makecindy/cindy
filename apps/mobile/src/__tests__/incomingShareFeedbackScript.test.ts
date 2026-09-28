import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function temporaryDirectory() {
  return dirname(execFileSync.mock.calls[0][1][0]);
}

describe("Swift share feedback test runner", () => {
  it("bounds compilation and execution separately and cleans up after success", async () => {
    await import("../../scripts/test-incoming-share-feedback.mjs");

    const directory = temporaryDirectory();
    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      "swiftc",
      [join(directory, "main.swift"), "-o", join(directory, "test")],
      { stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL" },
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      join(directory, "test"),
      [],
      { stdio: "inherit", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[share-feedback\] PASS compile \(\d+ms\)$/),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[share-feedback\] PASS execute \(\d+ms\)$/),
    );
    expect(existsSync(directory)).toBe(false);
  });

  it.each(["compile", "execute"])(
    "propagates %s failures and cleans up without reporting success",
    async (phase) => {
      const failure = Object.assign(new Error("Swift command failed"), {
        status: 1,
      });
      if (phase === "execute") execFileSync.mockReturnValueOnce(undefined);
      execFileSync.mockImplementationOnce(() => {
        throw failure;
      });

      await expect(
        import("../../scripts/test-incoming-share-feedback.mjs"),
      ).rejects.toBe(failure);
      expect(execFileSync).toHaveBeenCalledTimes(phase === "compile" ? 1 : 2);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^\\[share-feedback\\] FAIL ${phase} \\(\\d+ms, exit 1\\)$`),
        ),
      );
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining(`PASS ${phase}`),
      );
      expect(existsSync(temporaryDirectory())).toBe(false);
    },
  );

  it.each(["compile", "execute"])(
    "reports %s timeouts as failures, not unavailable Swift",
    async (phase) => {
      const timeout = Object.assign(new Error("Swift command timed out"), {
        code: "ETIMEDOUT",
      });
      if (phase === "execute") execFileSync.mockReturnValueOnce(undefined);
      execFileSync.mockImplementationOnce(() => {
        throw timeout;
      });

      await expect(
        import("../../scripts/test-incoming-share-feedback.mjs"),
      ).rejects.toBe(timeout);
      expect(execFileSync).toHaveBeenCalledTimes(phase === "compile" ? 1 : 2);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`^\\[share-feedback\\] FAIL ${phase} \\(\\d+ms, ETIMEDOUT\\)$`),
        ),
      );
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining(`PASS ${phase}`),
      );
      expect(existsSync(temporaryDirectory())).toBe(false);
    },
  );
});
