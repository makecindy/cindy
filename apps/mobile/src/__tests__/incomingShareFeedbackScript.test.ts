import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync }));
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = originalExitCode;
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
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(originalExitCode);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[share-feedback\] PASS compile \(\d+ms\)$/),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[share-feedback\] PASS execute \(\d+ms\)$/),
    );
    expect(existsSync(directory)).toBe(false);
  });

  it("skips only a missing compiler, without a version preflight or execution", async () => {
    execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("swiftc not found"), { code: "ENOENT" });
    });

    await import("../../scripts/test-incoming-share-feedback.mjs");

    expect(process.exitCode).toBe(77);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0][0]).toBe("swiftc");
    expect(execFileSync.mock.calls[0][1][0]).toBe(
      join(temporaryDirectory(), "main.swift"),
    );
    expect(console.error).toHaveBeenCalledWith(
      "[share-feedback] SKIP compile (swiftc not found)",
    );
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("PASS"),
    );
    expect(existsSync(temporaryDirectory())).toBe(false);
  });

  it.each([
    ["compile", "EACCES"],
    ["execute", "ENOENT"],
  ])("does not skip %s with %s", async (phase, code) => {
    const failure = Object.assign(new Error("Swift command failed"), { code });
    if (phase === "execute") execFileSync.mockReturnValueOnce(undefined);
    execFileSync.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      import("../../scripts/test-incoming-share-feedback.mjs"),
    ).rejects.toBe(failure);
    expect(execFileSync).toHaveBeenCalledTimes(phase === "compile" ? 1 : 2);
    expect(process.exitCode).toBe(originalExitCode);
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("SKIP"),
    );
    expect(existsSync(temporaryDirectory())).toBe(false);
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
      expect(process.exitCode).toBe(originalExitCode);
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
      expect(process.exitCode).toBe(originalExitCode);
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
