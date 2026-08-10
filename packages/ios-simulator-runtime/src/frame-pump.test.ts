import { describe, expect, it, vi } from "vitest";

import type {
  IOSSimulatorH264Frame,
  IOSSimulatorJpegStreamDriver,
  IOSSimulatorNativeSidecarDriver,
} from "./driver.js";
import {
  IOSSimulatorFramePump,
  IOSSimulatorH264FramePump,
} from "./frame-pump.js";
import { IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES } from "./native-sidecar/protocol.js";

function driverWithStreams(streams: Array<"frame" | "eof">) {
  return {
    kind: "wda" as const,
    streamFrames: vi.fn(async ({ signal, onFrame }) => {
      const behavior = streams.shift() ?? "eof";
      if (behavior === "frame") {
        await onFrame({ bytes: new Uint8Array([1, 2, 3]), receivedAt: "now" });
      }
      return {
        frameCount: behavior === "frame" ? 1 : 0,
        byteCount: behavior === "frame" ? 3 : 0,
        startedAt: "now",
        firstFrameAt: behavior === "frame" ? "now" : null,
        endedAt: "now",
        endReason: signal?.aborted ? "aborted" : "eof",
      };
    }),
  } as unknown as IOSSimulatorJpegStreamDriver;
}

describe("IOSSimulatorFramePump", () => {
  it("keeps only the latest in-memory frame and retains it while paused", async () => {
    const driver = driverWithStreams(["frame", "eof", "eof"]);
    const pump = new IOSSimulatorFramePump({
      maxReconnectAttempts: 1,
      reconnectDelaysMs: [0],
    });
    pump.setVisible({
      instanceId: "instance-a",
      generation: 2,
      driver,
      visible: true,
    });
    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.latestFrame?.sequence).toBe(1),
    );

    const beforePause = pump.snapshot("instance-a")!;
    pump.setVisible({
      instanceId: "instance-a",
      generation: 2,
      driver,
      visible: false,
    });
    const paused = pump.snapshot("instance-a")!;
    expect(paused.state).toBe("paused");
    expect(paused.latestFrame).toEqual(beforePause.latestFrame);
    expect(paused.latestFrame?.bytes).not.toBe(beforePause.latestFrame?.bytes);
  });

  it("bounds reconnects after unexpected eof", async () => {
    const driver = driverWithStreams(["eof", "eof", "eof"]);
    const pump = new IOSSimulatorFramePump({
      maxReconnectAttempts: 2,
      reconnectDelaysMs: [0],
    });
    pump.setVisible({
      instanceId: "instance-a",
      generation: 1,
      driver,
      visible: true,
    });
    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.state).toBe("disconnected"),
    );
    expect(driver.streamFrames).toHaveBeenCalledTimes(3);
  });

  it("drops the retained JPEG frame after the stream becomes disconnected", async () => {
    const driver = driverWithStreams(["frame", "eof"]);
    const pump = new IOSSimulatorFramePump({
      maxReconnectAttempts: 0,
      reconnectDelaysMs: [0],
    });
    pump.setVisible({
      instanceId: "instance-a",
      generation: 1,
      driver,
      visible: true,
    });

    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.state).toBe("disconnected"),
    );
    expect(pump.snapshot("instance-a")?.latestFrame).toBeNull();
  });

  it("drops retained bytes when an instance is cleared", () => {
    const pump = new IOSSimulatorFramePump();
    const driver = driverWithStreams([]);
    pump.setVisible({
      instanceId: "instance-a",
      generation: 1,
      driver,
      visible: false,
    });
    pump.clear("instance-a");
    expect(pump.snapshot("instance-a")).toBeNull();
  });
});

function h264Frame(sequence: number): IOSSimulatorH264Frame {
  return {
    encoding: "h264",
    sequence,
    format: "annex-b",
    bytes: new Uint8Array([0, 0, 0, 1, sequence === 0 ? 0x65 : 0x41]),
    receivedAt: `frame-${sequence}`,
    width: 1206,
    height: 2622,
    orientation: "PORTRAIT",
    scale: 3,
    colorSpace: "srgb",
    timestampMicros: sequence * 200_000,
    keyFrame: sequence === 0,
  };
}

function nativeDriverWithStreams(streams: Array<"frame" | "eof">) {
  const driver = {
    kind: "native-sidecar" as const,
    capabilities: {
      accessibility: false,
      sessions: false,
      jpegStream: false,
      h264Stream: true,
      bgraStream: false,
      discreteInput: false,
      continuousInput: false,
      multiTouch: false,
    },
    configureNativeStream: vi.fn(async (profile) => profile),
    streamNativeFrames: vi.fn(async ({ signal, onFrame }) => {
      const behavior = streams.shift() ?? "eof";
      if (behavior === "frame") await onFrame(h264Frame(0));
      return {
        frameCount: behavior === "frame" ? 1 : 0,
        byteCount: behavior === "frame" ? 6 : 0,
        startedAt: "now",
        firstFrameAt: behavior === "frame" ? "now" : null,
        endedAt: "now",
        endReason: signal?.aborted ? ("aborted" as const) : ("eof" as const),
      };
    }),
  };
  return driver as unknown as IOSSimulatorNativeSidecarDriver & typeof driver;
}

describe("IOSSimulatorH264FramePump", () => {
  it("configures a capability-selected native stream and owns one copied access unit", async () => {
    const driver = nativeDriverWithStreams([]);
    driver.streamNativeFrames.mockImplementationOnce(
      async ({ signal, onFrame }) => {
        await onFrame(h264Frame(0));
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          frameCount: 1,
          byteCount: 6,
          startedAt: "now",
          firstFrameAt: "now",
          endedAt: "now",
          endReason: "aborted",
        };
      },
    );
    const pump = new IOSSimulatorH264FramePump({
      maxReconnectAttempts: 0,
      reconnectDelaysMs: [0],
    });
    pump.setVisible({
      instanceId: "instance-a",
      generation: 2,
      driver,
      profile: {
        encoding: "h264",
        framesPerSecond: 10,
        scalingPercent: 70,
      },
      visible: true,
    });
    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.latestFrame?.encoding).toBe("h264"),
    );

    expect(driver.configureNativeStream).toHaveBeenCalledWith(
      {
        encoding: "h264",
        framesPerSecond: 10,
        scalingPercent: 70,
      },
      expect.any(AbortSignal),
    );
    expect(driver.streamNativeFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        maxFrameBytes: IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
      }),
    );
    const first = pump.snapshot("instance-a")!;
    expect(first.latestFrame).toMatchObject({
      encoding: "h264",
      generation: 2,
      sequence: 1,
      width: 1206,
      height: 2622,
      keyFrame: true,
    });
    expect(pump.snapshot("instance-a")?.latestFrame?.bytes).not.toBe(
      first.latestFrame?.bytes,
    );
    pump.clear("instance-a");
  });

  it("notifies the host immediately for each accepted H.264 access unit", async () => {
    const driver = nativeDriverWithStreams(["frame"]);
    const pushed: unknown[] = [];
    const pump = new IOSSimulatorH264FramePump({
      maxReconnectAttempts: 0,
      reconnectDelaysMs: [0],
      onFrame: (frame) => pushed.push(frame),
    });
    pump.setVisible({
      instanceId: "instance-push",
      generation: 4,
      driver,
      profile: {
        encoding: "h264",
        framesPerSecond: 20,
        scalingPercent: 100,
      },
      visible: true,
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]).toMatchObject({
      instanceId: "instance-push",
      generation: 4,
      sequence: 1,
      encoding: "h264",
    });
  });

  it("pauses without clearing the last frame and aborts on clear", async () => {
    const driver = nativeDriverWithStreams([]);
    driver.streamNativeFrames.mockImplementationOnce(
      async ({ signal, onFrame }) => {
        await onFrame(h264Frame(0));
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          frameCount: 1,
          byteCount: 6,
          startedAt: "now",
          firstFrameAt: "now",
          endedAt: "now",
          endReason: "aborted",
        };
      },
    );
    const pump = new IOSSimulatorH264FramePump();
    const input = {
      instanceId: "instance-a",
      generation: 1,
      driver,
      profile: {
        encoding: "h264" as const,
        framesPerSecond: 5,
        scalingPercent: 50,
      },
    };
    pump.setVisible({ ...input, visible: true });
    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.latestFrame).not.toBeNull(),
    );
    const paused = pump.setVisible({ ...input, visible: false });
    expect(paused.state).toBe("paused");
    expect(paused.latestFrame?.encoding).toBe("h264");
    pump.clear("instance-a");
    expect(pump.snapshot("instance-a")).toBeNull();
  });

  it("drops the retained H.264 frame after the stream becomes disconnected", async () => {
    const driver = nativeDriverWithStreams(["frame", "eof"]);
    const pump = new IOSSimulatorH264FramePump({
      maxReconnectAttempts: 0,
      reconnectDelaysMs: [0],
    });
    pump.setVisible({
      instanceId: "instance-a",
      generation: 1,
      driver,
      profile: {
        encoding: "h264",
        framesPerSecond: 5,
        scalingPercent: 50,
      },
      visible: true,
    });

    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.state).toBe("disconnected"),
    );
    expect(pump.snapshot("instance-a")?.latestFrame).toBeNull();
  });

  it("keeps host sequence monotonic when the stream profile changes", async () => {
    const driver = nativeDriverWithStreams([]);
    let streamCall = 0;
    driver.streamNativeFrames.mockImplementation(
      async ({ signal, onFrame }) => {
        await onFrame(h264Frame(streamCall++));
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          frameCount: 1,
          byteCount: 6,
          startedAt: "now",
          firstFrameAt: "now",
          endedAt: "now",
          endReason: "aborted",
        };
      },
    );
    const pump = new IOSSimulatorH264FramePump();
    const base = {
      instanceId: "instance-a",
      generation: 1,
      driver,
    };
    pump.setVisible({
      ...base,
      profile: {
        encoding: "h264",
        framesPerSecond: 5,
        scalingPercent: 50,
      },
      visible: true,
    });
    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.latestFrame?.sequence).toBe(1),
    );

    pump.setVisible({
      ...base,
      profile: {
        encoding: "h264",
        framesPerSecond: 10,
        scalingPercent: 70,
      },
      visible: true,
    });
    await vi.waitFor(() =>
      expect(pump.snapshot("instance-a")?.latestFrame?.sequence).toBe(2),
    );

    expect(driver.configureNativeStream).toHaveBeenNthCalledWith(
      2,
      {
        encoding: "h264",
        framesPerSecond: 10,
        scalingPercent: 70,
      },
      expect.any(AbortSignal),
    );
    pump.clear("instance-a");
  });
});
