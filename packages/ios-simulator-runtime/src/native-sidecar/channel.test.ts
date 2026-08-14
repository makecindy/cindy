import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { IOSSimulatorNativeSidecarManagedProcess } from "./channel.js";
import {
  IOSSimulatorNativeSidecarChannel,
  IOSSimulatorNativeSidecarChannelError,
  type IOSSimulatorNativeSidecarChannelOptions,
  type IOSSimulatorNativeSidecarProcessLauncher,
} from "./channel.js";
import {
  decodeIOSSimulatorNativeSidecarJson,
  encodeIOSSimulatorNativeSidecarJson,
  encodeIOSSimulatorNativeSidecarStreamFrame,
  IOSSimulatorNativeSidecarFrameDecoder,
  IOSSimulatorNativeSidecarProtocolError,
} from "./protocol.js";

class FakeSidecarProcess
  extends EventEmitter
  implements IOSSimulatorNativeSidecarManagedProcess
{
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Uint8Array[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(new Uint8Array(chunk));
      callback();
    },
  });
  readonly pid = 123;
  emitExitOnKill = true;
  readonly killSignals: NodeJS.Signals[] = [];
  readonly exited: Promise<void>;
  #resolveExited!: () => void;

  constructor() {
    super();
    this.exited = new Promise<void>((resolve) => {
      this.#resolveExited = resolve;
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killSignals.push(signal);
    if (this.emitExitOnKill) {
      this.stdout.end();
      this.stderr.end();
      this.exit(null, signal);
    }
    return true;
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.#resolveExited();
    this.emit("close", code, signal);
  }
}

function harness(
  overrides: Partial<IOSSimulatorNativeSidecarChannelOptions> = {},
) {
  const processes: FakeSidecarProcess[] = [];
  const launcher: IOSSimulatorNativeSidecarProcessLauncher = {
    launch: vi.fn(() => {
      const process = new FakeSidecarProcess();
      processes.push(process);
      return process;
    }),
  };
  const channel = new IOSSimulatorNativeSidecarChannel({
    launcher,
    requestTimeoutMs: 100,
    maxCrashes: 2,
    restartBaseDelayMs: 1,
    sleep: async () => undefined,
    now: () => new Date("2026-07-23T00:00:00.000Z"),
    ...overrides,
  });
  return { channel, launcher, processes };
}

function command(op: string, params?: Record<string, unknown>) {
  return {
    version: 1,
    op,
    simulatorUdid: "UDID-1",
    generation: 4,
    ...(params ? { params } : {}),
  };
}

function reply(id: string, result: unknown): Uint8Array {
  return encodeIOSSimulatorNativeSidecarJson({ id, ok: true, result });
}

function writtenRequest(bytes: Uint8Array): Record<string, unknown> {
  const decoder = new IOSSimulatorNativeSidecarFrameDecoder();
  const frames = decoder.push(bytes);
  decoder.finish();
  expect(frames).toHaveLength(1);
  return decodeIOSSimulatorNativeSidecarJson(frames[0]!);
}

function streamFrame(sequence: number): Uint8Array {
  return encodeIOSSimulatorNativeSidecarStreamFrame(
    {
      streamId: "stream-1",
      simulatorUdid: "UDID-1",
      generation: 4,
      sequence,
      encoding: "h264",
      h264Format: "annex-b",
      width: 393,
      height: 852,
      orientation: "PORTRAIT",
      scale: 3,
      colorSpace: "srgb",
      timestampMicros: sequence,
      keyFrame: sequence === 1,
    },
    new Uint8Array([0, 0, 0, 1, sequence === 1 ? 0x65 : 0x41, 0x88]),
  );
}

function streamEnd(reason: "max-frames" | "aborted" | "eof" | "error" = "eof") {
  return encodeIOSSimulatorNativeSidecarJson(
    {
      streamId: "stream-1",
      simulatorUdid: "UDID-1",
      generation: 4,
      reason,
    },
    4,
  );
}

describe("IOSSimulatorNativeSidecarChannel", () => {
  it("multiplexes replies and stream events even when one stdout chunk contains all of them", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const frames: unknown[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      onFrame: async (frame) => {
        frames.push(frame);
      },
    });
    const process = processes[0]!;
    const requestId = "sidecar-1";
    const combined = new Uint8Array(
      reply(requestId, { streamId: "stream-1" }).length +
        streamFrame(1).length +
        streamEnd().length,
    );
    const first = reply(requestId, { streamId: "stream-1" });
    const second = streamFrame(1);
    const third = streamEnd();
    combined.set(first);
    combined.set(second, first.length);
    combined.set(third, first.length + second.length);
    process.stdout.write(combined);

    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 1,
      byteCount: 6,
      endReason: "eof",
      firstFrameAt: "2026-07-23T00:00:00.000Z",
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      encoding: "h264",
      width: 393,
      height: 852,
      keyFrame: true,
    });
    await channel.stop();
  });

  it("times out pending requests without leaving them in the multiplexer", async () => {
    const { channel, processes } = harness({ requestTimeoutMs: 5 });
    await channel.start();
    await expect(
      channel.request(command("availability")),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    processes[0]!.stdout.write(reply("sidecar-1", { ready: true }));
    await Promise.resolve();
    expect(channel.state).toBe("running");
    const next = channel.request(command("availability"));
    processes[0]!.stdout.write(reply("sidecar-2", { ready: true }));
    await expect(next).resolves.toEqual({ ready: true });
    await channel.stop();
  });

  it("ignores one late reply for an aborted request without terminating the sidecar", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const controller = new AbortController();
    const aborted = channel.request(command("tap"), controller.signal);

    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    processes[0]!.stdout.write(reply("sidecar-1", {}));
    await Promise.resolve();

    expect(channel.state).toBe("running");
    expect(channel.crashCount).toBe(0);
    const next = channel.request(command("availability"));
    processes[0]!.stdout.write(reply("sidecar-2", { ready: true }));
    await expect(next).resolves.toEqual({ ready: true });

    // A tombstone consumes exactly one expected late reply. A duplicate keeps
    // the existing fail-closed behavior for unsolicited protocol traffic.
    processes[0]!.stdout.write(reply("sidecar-1", {}));
    await vi.waitFor(() => expect(channel.state).toBe("failed"));
    expect(channel.crashCount).toBe(1);
    await channel.stop();
  });

  it("waits for exit and escalates a stuck sidecar process group", async () => {
    vi.useFakeTimers();
    try {
      const { channel, launcher, processes } = harness({ stopTimeoutMs: 5 });
      await channel.start();
      const process = processes[0]!;
      process.emitExitOnKill = false;

      const stop = channel.stop();
      expect(process.killSignals).toEqual(["SIGTERM"]);
      const restart = channel.start();
      expect(launcher.launch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5);
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      process.exit(null, "SIGKILL");
      await stop;
      await restart;
      expect(launcher.launch).toHaveBeenCalledTimes(2);
      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a process that remains alive after the bounded SIGKILL wait", async () => {
    vi.useFakeTimers();
    try {
      const { channel, launcher, processes } = harness({ stopTimeoutMs: 5 });
      await channel.start();
      const process = processes[0]!;
      process.emitExitOnKill = false;

      const stop = channel.stop();
      const stopped = expect(stop).rejects.toMatchObject({
        code: "TERMINATION_FAILED",
      });
      await vi.advanceTimersByTimeAsync(10);
      await stopped;
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(channel.start()).rejects.toMatchObject({
        code: "TERMINATION_FAILED",
      });
      await expect(channel.restart()).rejects.toMatchObject({
        code: "TERMINATION_FAILED",
      });
      expect(launcher.launch).toHaveBeenCalledTimes(1);

      channel.abortOperationsForExit();
      expect(process.killSignals).toEqual([
        "SIGTERM",
        "SIGKILL",
        "SIGKILL",
      ]);
      process.exit(null, "SIGKILL");
      await process.exited;
      await Promise.resolve();

      await channel.start();
      expect(launcher.launch).toHaveBeenCalledTimes(2);
      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("synchronously kills both active and already-stopping processes for Host exit", async () => {
    const activeHarness = harness();
    await activeHarness.channel.start();
    activeHarness.channel.abortOperationsForExit();
    expect(activeHarness.processes[0]!.killSignals).toEqual(["SIGKILL"]);
    expect(activeHarness.channel.state).toBe("stopped");

    vi.useFakeTimers();
    try {
      const stoppingHarness = harness({ stopTimeoutMs: 5 });
      await stoppingHarness.channel.start();
      const process = stoppingHarness.processes[0]!;
      process.emitExitOnKill = false;
      const stop = stoppingHarness.channel.stop();
      expect(process.killSignals).toEqual(["SIGTERM"]);

      stoppingHarness.channel.abortOperationsForExit();
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      process.exit(null, "SIGKILL");
      await stop;
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates the process after consecutive request timeouts", async () => {
    const { channel } = harness({
      requestTimeoutMs: 5,
      maxConsecutiveTimeouts: 2,
    });
    await channel.start();
    const first = channel.request(command("first"));
    const second = channel.request(command("second"));
    await expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(channel.state).toBe("failed");
    expect(channel.crashCount).toBe(1);
  });

  it("fails all pending work and kills the process on framing desync", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const pending = channel.request(command("availability"));
    processes[0]!.stdout.write(new Uint8Array([0, 0, 0, 0, 255]));
    await expect(pending).rejects.toBeInstanceOf(
      IOSSimulatorNativeSidecarChannelError,
    );
    expect(channel.state).toBe("failed");
  });

  it.each([
    ["missing", undefined],
    ["non-boolean", "yes"],
  ])(
    "rejects a pending request when its reply has a %s ok field",
    async (_label, ok) => {
      const { channel, processes } = harness();
      await channel.start();
      const pending = channel.request(command("availability"));
      processes[0]!.stdout.write(
        encodeIOSSimulatorNativeSidecarJson({
          id: "sidecar-1",
          ...(ok === undefined ? {} : { ok }),
          result: { ready: true },
        }),
      );

      await expect(pending).rejects.toMatchObject({
        code: "PROTOCOL_ERROR",
        message: "Reply sidecar-1 has invalid ok field",
      });
      expect(channel.state).toBe("failed");
      expect(channel.lastTermination?.reasonCode).toBe("protocol-error");
    },
  );

  it("waits for a faulted process to close before stop or restart completes", async () => {
    vi.useFakeTimers();
    try {
      const { channel, launcher, processes } = harness({ stopTimeoutMs: 5 });
      await channel.start();
      const process = processes[0]!;
      process.emitExitOnKill = false;
      const pending = channel.request(command("availability"));

      process.stdout.write(new Uint8Array([0, 0, 0, 0, 255]));
      await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
      expect(channel.state).toBe("failed");
      expect(process.killSignals).toEqual(["SIGTERM"]);

      const stop = channel.stop();
      const restart = channel.start();
      expect(launcher.launch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5);
      expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
      let settled = false;
      void Promise.all([stop, restart]).then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      process.exit(null, "SIGKILL");
      await stop;
      await restart;
      expect(launcher.launch).toHaveBeenCalledTimes(2);
      await channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a stream at maxFrames and rejects stale stream identities", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const frames: unknown[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      maxFrames: 1,
      onFrame: (frame) => {
        frames.push(frame);
      },
    });
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(1));
    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 1,
      endReason: "max-frames",
    });
    expect(frames).toHaveLength(1);
    await channel.stop();
  });

  it("waits for the sidecar terminal end before handing off a bounded stream", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const frames: unknown[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      maxFrames: 1,
      acknowledgeFrames: true,
      awaitStreamEndAfterMaxFrames: true,
      onFrame: (frame) => {
        frames.push(frame);
      },
    });
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(0));
    await vi.waitFor(() => expect(process.writes).toHaveLength(2));
    process.stdout.write(reply("sidecar-2", {}));
    expect(frames).toHaveLength(1);

    process.stdout.write(streamEnd("max-frames"));
    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 1,
      endReason: "max-frames",
    });
    await channel.stop();
  });

  it("parks after the crash budget and allows explicit re-arm", async () => {
    const { channel, launcher, processes } = harness({ maxCrashes: 2 });
    await channel.start();
    processes[0]!.exit(1, "SIGKILL");
    expect(channel.state).toBe("failed");
    await channel.restart();
    expect(launcher.launch).toHaveBeenCalledTimes(2);
    processes[1]!.exit(1, "SIGKILL");
    expect(channel.state).toBe("parked");
    await processes[1]!.exited;
    await Promise.resolve();
    expect(() => channel.rearm()).not.toThrow();
    await channel.start();
    expect(launcher.launch).toHaveBeenCalledTimes(3);
    await channel.stop();
  });

  it("retains structured process-exit evidence with a bounded stderr tail", async () => {
    const { channel, processes } = harness();
    await channel.start();
    processes[0]!.stderr.write(
      "VideoToolbox failed at /Users/example/private/SimulatorKit.framework\n",
    );
    processes[0]!.exit(23, null);

    expect(channel.lastTermination).toEqual({
      reasonCode: "process-exit",
      message: "Native sidecar exited (23).",
      exitCode: 23,
      signal: null,
      occurredAt: "2026-07-23T00:00:00.000Z",
      stderrTail:
        "VideoToolbox failed at /Users/example/private/SimulatorKit.framework\n",
    });
  });

  it("adds the final signal when stdout closes before the process exit event", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const process = processes[0]!;
    process.emitExitOnKill = false;
    process.stderr.write("encoder stopped\n");
    process.stdout.end();
    await vi.waitFor(() => expect(channel.state).toBe("failed"));
    process.exit(null, "SIGABRT");

    expect(channel.lastTermination).toMatchObject({
      reasonCode: "stdout-closed",
      exitCode: null,
      signal: "SIGABRT",
      stderrTail: "encoder stopped\n",
    });
  });

  it("waits for a retired process before launching an isolated replacement", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const retired = processes[0]!;
    retired.emitExitOnKill = false;
    const pending = channel.request(command("availability"));
    retired.stdout.write(new Uint8Array([0, 0, 0, 0, 255]));
    await expect(pending).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    const restart = channel.restart();
    await Promise.resolve();
    expect(processes).toHaveLength(1);
    retired.exit(1, "SIGKILL");
    await restart;
    expect(channel.state).toBe("running");
    const replacementRequest = channel.request(command("availability"));
    processes[1]!.stdout.write(
      reply("sidecar-2", { ready: true, message: null }),
    );
    await expect(replacementRequest).resolves.toEqual({
      ready: true,
      message: null,
    });
    await channel.stop();
  });

  it("serializes async frame callbacks and rejects callback failures", async () => {
    const { channel, processes } = harness();
    await channel.start();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sequences: number[] = [];
    const streamPromise = channel.streamFrames(command("startStream"), {
      onFrame: async (frame) => {
        sequences.push(frame.timestampMicros);
        if (frame.timestampMicros === 1) await firstGate;
        if (frame.timestampMicros === 2) throw new Error("consumer failed");
      },
    });
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(1));
    process.stdout.write(streamFrame(2));
    await vi.waitFor(() => expect(sequences).toEqual([1]));
    releaseFirst();
    await expect(streamPromise).rejects.toThrow("consumer failed");
    expect(sequences).toEqual([1, 2]);
    await channel.stop();
  });

  it("acknowledges correctness frames only after each consumer callback completes", async () => {
    const { channel, processes } = harness();
    await channel.start();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sequences: number[] = [];
    const streamPromise = channel.streamFrames(
      command("startH264CorrectnessStream"),
      {
        acknowledgeFrames: true,
        requireContiguousSequence: true,
        onFrame: async (frame) => {
          sequences.push(frame.sequence!);
          if (frame.sequence === 0) await firstGate;
        },
      },
    );
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(0));
    await vi.waitFor(() => expect(sequences).toEqual([0]));
    expect(process.writes).toHaveLength(1);

    releaseFirst();
    await vi.waitFor(() => expect(process.writes).toHaveLength(2));
    expect(writtenRequest(process.writes[1]!)).toMatchObject({
      id: "sidecar-2",
      op: "ackStreamFrame",
      params: { streamId: "stream-1", sequence: 0 },
    });
    process.stdout.write(reply("sidecar-2", {}));
    process.stdout.write(streamFrame(1));
    await vi.waitFor(() => expect(sequences).toEqual([0, 1]));
    await vi.waitFor(() => expect(process.writes).toHaveLength(3));
    expect(writtenRequest(process.writes[2]!)).toMatchObject({
      id: "sidecar-3",
      op: "ackStreamFrame",
      params: { streamId: "stream-1", sequence: 1 },
    });
    process.stdout.write(reply("sidecar-3", {}));
    process.stdout.write(streamEnd("max-frames"));

    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 2,
      endReason: "max-frames",
    });
    await channel.stop();
  });

  it("fails closed when a correctness stream sequence is not contiguous", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const streamPromise = channel.streamFrames(
      command("startBgraCorrectnessStream"),
      {
        acknowledgeFrames: true,
        requireContiguousSequence: true,
        onFrame: () => undefined,
      },
    );
    const process = processes[0]!;
    process.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    process.stdout.write(streamFrame(1));
    await expect(streamPromise).rejects.toBeInstanceOf(
      IOSSimulatorNativeSidecarProtocolError,
    );
    expect(channel.state).toBe("running");
    await channel.stop();
  });

  it("stops a stream when cancellation wins the reply-registration race", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const controller = new AbortController();
    const streamPromise = channel.streamFrames(command("startStream"), {
      signal: controller.signal,
      onFrame: () => undefined,
    });
    processes[0]!.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    controller.abort();
    await expect(streamPromise).resolves.toMatchObject({
      frameCount: 0,
      endReason: "aborted",
    });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(2));
    expect(writtenRequest(processes[0]!.writes[1]!)).toMatchObject({
      op: "stopStream",
      params: { streamId: "stream-1" },
    });
    await channel.stop();
  });

  it("preserves a sanitized producer message on stream errors", async () => {
    const { channel, processes } = harness();
    await channel.start();
    const streamPromise = channel.streamFrames(command("startStream"), {
      onFrame: () => undefined,
    });
    processes[0]!.stdout.write(reply("sidecar-1", { streamId: "stream-1" }));
    processes[0]!.stdout.write(
      encodeIOSSimulatorNativeSidecarJson(
        {
          streamId: "stream-1",
          simulatorUdid: "UDID-1",
          generation: 4,
          reason: "error",
          message: "The hardware H.264 encoder is unavailable.",
        },
        4,
      ),
    );
    await expect(streamPromise).resolves.toMatchObject({
      endReason: "error",
      endMessage: "The hardware H.264 encoder is unavailable.",
    });
    await channel.stop();
  });
});
