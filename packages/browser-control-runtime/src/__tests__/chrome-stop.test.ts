import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withCdpSocket } from "../_generated/extension/src/browser/cdp.helpers.js";
import { readChromeVersion } from "../_generated/extension/src/browser/chrome.diagnostics.js";

import {
  stopOpenClawChrome,
  type RunningChrome,
} from "../_generated/extension/src/browser/chrome.js";

vi.mock(
  "../_generated/extension/src/browser/cdp.helpers.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../_generated/extension/src/browser/cdp.helpers.js")
    >()),
    withCdpSocket: vi.fn(),
  }),
);
vi.mock(
  "../_generated/extension/src/browser/chrome.diagnostics.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../_generated/extension/src/browser/chrome.diagnostics.js")
    >()),
    readChromeVersion: vi.fn(),
  }),
);

/**
 * Regression: stop treated ChildProcess.killed (signal sent) as process exit,
 * immediately SIGKILLing Chrome before it could flush login data. Existing
 * launch tests never exercise shutdown. A live fake process after SIGTERM is
 * the minimal input; unit tier uses virtual time, no real process or profile.
 */
function runningChrome(alreadySignalled = false) {
  const proc = {
    killed: alreadySignalled,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal: NodeJS.Signals) => {
      proc.killed = true;
      return true;
    }),
  };
  const release = vi.fn();
  const running: RunningChrome = {
    pid: 123,
    exe: { kind: "chrome", path: "/fake/chrome" },
    userDataDir: "/fake/profile",
    cdpPort: 18800,
    startedAt: 0,
    proc: proc as unknown as ChildProcessWithoutNullStreams,
    releaseCdpProxyBypass: release,
  };
  return { running, proc, release };
}

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "linux" });
  vi.mocked(readChromeVersion).mockReset();
  vi.mocked(withCdpSocket).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("managed Chrome shutdown", () => {
  it.each([false, true])(
    "waits for process exit with an earlier signal=%s",
    async (alreadySignalled) => {
      vi.useFakeTimers();
      const { running, proc, release } = runningChrome(alreadySignalled);
      let settled = false;
      const stopping = stopOpenClawChrome(running, 100).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      expect(release).not.toHaveBeenCalled();
      expect(proc.kill.mock.calls).toEqual(
        alreadySignalled ? [] : [["SIGTERM"]],
      );

      proc.exitCode = 0;
      await vi.advanceTimersByTimeAsync(50);
      await stopping;
      expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("force-stops an unresponsive process only after the grace period", async () => {
    vi.useFakeTimers();
    const { running, proc, release } = runningChrome();
    const stopping = stopOpenClawChrome(running, 100);
    await vi.advanceTimersByTimeAsync(99);
    expect(proc.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(proc.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("recognizes an exit caused by a signal and does not signal again", async () => {
    const { running, proc, release } = runningChrome();
    proc.signalCode = "SIGTERM";
    await stopOpenClawChrome(running, 100);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  // Windows SIGTERM is a force-kill too. Browser.close must precede waiting,
  // and CDP loss must not trigger a signal while Chrome flushes its profile.
  it("closes Windows Chrome through CDP and waits for its actual exit", async () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.useFakeTimers();
    const { running, proc, release } = runningChrome();
    const send = vi.fn().mockResolvedValue({});
    vi.mocked(readChromeVersion).mockResolvedValue({
      webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/browser/fake",
    });
    vi.mocked(withCdpSocket).mockImplementation(async (_url, fn) => fn(send));
    const stopping = stopOpenClawChrome(running, 300);
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls).toEqual([["Browser.close"]]);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    proc.exitCode = 0;
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(proc.kill).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["discovery", "command"])(
    "force-stops Windows Chrome only at the original deadline after CDP %s fails",
    async (failure) => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      vi.useFakeTimers();
      const { running, proc, release } = runningChrome();
      vi.mocked(readChromeVersion).mockImplementation(
        async (_url, timeoutMs) => {
          await new Promise((resolve) => setTimeout(resolve, timeoutMs));
          if (failure === "discovery") throw new Error("CDP unavailable");
          return {
            webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/browser/fake",
          };
        },
      );
      vi.mocked(withCdpSocket).mockRejectedValue(
        new Error("CDP socket closed"),
      );
      const stopping = stopOpenClawChrome(running, 300);
      await vi.advanceTimersByTimeAsync(299);
      expect(proc.kill).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(proc.kill.mock.calls).toEqual([["SIGKILL"]]);
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
