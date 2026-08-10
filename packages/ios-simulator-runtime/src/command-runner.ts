import { spawn } from "node:child_process";

import type {
  IOSSimulatorCommandResult,
  IOSSimulatorCommandRunner,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}

/** Node adapter for the runtime command seam. Commands are always argv-based. */
export function createNodeIOSSimulatorCommandRunner(): IOSSimulatorCommandRunner {
  return {
    run(command, args, options = {}): Promise<IOSSimulatorCommandResult> {
      if (options.signal?.aborted) {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: null });
      }
      return new Promise((resolve) => {
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env,
          detached: process.platform !== "win32",
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const maxBufferBytes =
          options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const chunks: Array<{ stream: "stdout" | "stderr"; bytes: Buffer }> =
          [];
        let outputBytes = 0;
        let outputTruncated = false;
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          options.signal?.removeEventListener("abort", onAbort);
          if (timedOut || aborted) {
            child.stdout?.removeAllListeners("data");
            child.stderr?.removeAllListeners("data");
            child.stdout?.destroy();
            child.stderr?.destroy();
            child.unref();
          }
          const stdout = chunks
            .filter((chunk) => chunk.stream === "stdout")
            .map((chunk) => chunk.bytes);
          const stderr = chunks
            .filter((chunk) => chunk.stream === "stderr")
            .map((chunk) => chunk.bytes);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
            outputTruncated,
          });
        };
        const onAbort = () => {
          if (settled || aborted) return;
          aborted = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (forceKillTimer) clearTimeout(forceKillTimer);
          killProcessTree(child, "SIGKILL");
          forceKillTimer = setTimeout(() => {
            if (settled) return;
            killProcessTree(child, "SIGKILL");
            // The updater may force-quit after this bounded grace period. Do
            // not wait forever for hostile inherited stdio handles to close.
            finish(null);
          }, TERMINATION_GRACE_MS);
        };
        timer = setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killProcessTree(child);
          forceKillTimer = setTimeout(() => {
            if (settled) return;
            killProcessTree(child, "SIGKILL");
            // Do not depend on a hostile or wedged child emitting `close`.
            finish(null);
          }, TERMINATION_GRACE_MS);
          // Keep the escalation watchdog referenced. The leader and its pipes
          // may close after SIGTERM while a detached descendant remains alive;
          // allowing this timer to unref could exit Main before SIGKILL.
        }, timeoutMs);
        unrefTimer(timer);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
        const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
          if (settled || chunk.byteLength === 0) return;
          if (maxBufferBytes <= 0) {
            outputTruncated = true;
            return;
          }
          chunks.push({ stream, bytes: Buffer.from(chunk) });
          outputBytes += chunk.byteLength;
          while (outputBytes > maxBufferBytes) {
            outputTruncated = true;
            const first = chunks[0];
            if (!first) break;
            const overflow = outputBytes - maxBufferBytes;
            if (first.bytes.byteLength <= overflow) {
              chunks.shift();
              outputBytes -= first.bytes.byteLength;
              continue;
            }
            first.bytes = first.bytes.subarray(overflow);
            outputBytes -= overflow;
          }
        };
        child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.once("error", () => {
          // Once termination starts, a child error must not cancel the process-
          // group escalation watchdog. It remains authoritative until the
          // group is gone or the bounded SIGKILL fallback fires.
          if (timedOut || aborted) return;
          finish(null);
        });
        child.once("close", (code) => {
          // The leader may exit on SIGTERM while a same-group descendant stays
          // alive. Keep the escalation watchdog in that case.
          if ((timedOut || aborted) && isProcessGroupAlive(child)) return;
          finish(timedOut || aborted ? null : code);
        });
      });
    },
  };
}

function isProcessGroupAlive(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid || process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function killProcessTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may have already exited; fall back to the child.
    }
  }
  child.kill(signal);
}
