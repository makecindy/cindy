import { describe, expect, it, vi } from "vitest";

import type {
  IOSSimulatorBgraFrame,
  IOSSimulatorDriverCapabilities,
  IOSSimulatorH264Frame,
  IOSSimulatorStreamStats,
} from "../driver.js";
import {
  IOSSimulatorNativeSidecarAdapter,
  IOSSimulatorNativeSidecarAdapterError,
  type IOSSimulatorNativeSidecarTransport,
  type IOSSimulatorNativeSidecarCommand,
} from "./adapter.js";

const NATIVE_CAPABILITIES: Readonly<IOSSimulatorDriverCapabilities> =
  Object.freeze({
    accessibility: false,
    sessions: false,
    jpegStream: false,
    h264Stream: true,
    bgraStream: true,
    discreteInput: true,
    continuousInput: true,
    multiTouch: true,
  });

function stats(): IOSSimulatorStreamStats {
  return {
    frameCount: 0,
    byteCount: 0,
    startedAt: "now",
    firstFrameAt: null,
    endedAt: "now",
    endReason: "aborted",
  };
}

function capturedFrame(): IOSSimulatorBgraFrame {
  return {
    encoding: "bgra",
    bytes: new Uint8Array([10, 20, 30, 255]),
    receivedAt: "2026-07-24T00:00:00.000Z",
    width: 1,
    height: 1,
    bytesPerRow: 4,
    orientation: "PORTRAIT",
    scale: 1,
    colorSpace: "unknown",
    timestampMicros: 1,
  };
}

function h264Frame(): IOSSimulatorH264Frame {
  return {
    encoding: "h264",
    sequence: 0,
    format: "annex-b",
    bytes: new Uint8Array([
      0, 0, 0, 1, 0x67, 0x64, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 0, 1, 0x65, 0x88,
    ]),
    receivedAt: "2026-07-24T00:00:00.000Z",
    width: 1,
    height: 1,
    orientation: "PORTRAIT",
    scale: 1,
    colorSpace: "unknown",
    timestampMicros: 1,
    keyFrame: true,
  };
}

function harness(capabilities = NATIVE_CAPABILITIES) {
  const commands: IOSSimulatorNativeSidecarCommand[] = [];
  const channel: IOSSimulatorNativeSidecarTransport = {
    request: vi.fn(async (command) => {
      commands.push(command);
      return { ready: true, message: "ready" };
    }),
    streamFrames: vi.fn(async (command) => {
      commands.push(command);
      return stats();
    }),
  };
  return {
    commands,
    channel,
    adapter: new IOSSimulatorNativeSidecarAdapter({
      simulatorUdid: "  UDID-1  ",
      generation: 7,
      capabilities,
      channel,
    }),
  };
}

describe("IOSSimulatorNativeSidecarAdapter", () => {
  it("binds every command to one exact UDID, generation and protocol version", async () => {
    const { adapter, commands } = harness();

    await expect(adapter.availability()).resolves.toMatchObject({
      ready: true,
      message: "ready",
    });
    await adapter.configureNativeStream({
      encoding: "h264",
      framesPerSecond: 60,
      scalingPercent: 50,
    });
    await adapter.tap({ x: 10, y: 20 });
    await adapter.touchPath([
      { phase: "down", x: 0.1, y: 0.2 },
      { phase: "move", x: 0.2, y: 0.3, dtMs: 16 },
      { phase: "up", x: 0.3, y: 0.4, dtMs: 16 },
    ]);
    await adapter.beginTouch("viewer-1", { x: 0.1, y: 0.2 });
    await adapter.moveTouch("viewer-1", { x: 0.2, y: 0.3 });
    await adapter.endTouch("viewer-1", { x: 0.3, y: 0.4 });

    expect(commands.map((command) => command.op)).toEqual([
      "availability",
      "configureStream",
      "tap",
      "touchPath",
      "beginTouch",
      "moveTouch",
      "endTouch",
    ]);
    for (const command of commands) {
      expect(command).toMatchObject({
        version: 1,
        simulatorUdid: "UDID-1",
        generation: 7,
      });
    }
  });

  it("validates live touch identity, normalized points, and cancellation", async () => {
    const { adapter, commands, channel } = harness();
    await adapter.beginTouch(" viewer:7 ", { x: 0, y: 0.25, edge: "left" });
    await adapter.moveTouch("viewer:7", { x: 0.2, y: 0.25, edge: "left" });
    await adapter.endTouch("viewer:7", { x: 0.3, y: 0.25, edge: "left" }, true);
    expect(
      commands.slice(-3).map(({ op, params }) => ({ op, params })),
    ).toEqual([
      {
        op: "beginTouch",
        params: {
          gestureId: "viewer:7",
          point: { x: 0, y: 0.25, edge: "left" },
        },
      },
      {
        op: "moveTouch",
        params: {
          gestureId: "viewer:7",
          point: { x: 0.2, y: 0.25, edge: "left" },
        },
      },
      {
        op: "endTouch",
        params: {
          gestureId: "viewer:7",
          point: { x: 0.3, y: 0.25, edge: "left" },
          cancelled: true,
        },
      },
    ]);
    await expect(
      adapter.beginTouch("bad gesture", { x: 0.5, y: 0.5 }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      adapter.moveTouch("viewer:7", { x: 2, y: 0.5 }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(channel.request).toHaveBeenCalledTimes(3);
  });

  it("requires configuration before streaming and forwards bounded options", async () => {
    const { adapter, channel, commands } = harness();
    expect(() => adapter.streamNativeFrames({ onFrame() {} })).toThrow(
      "must be configured",
    );

    await adapter.configureNativeStream({
      encoding: "h264",
      framesPerSecond: 15,
      scalingPercent: 25,
    });
    await adapter.streamNativeFrames({
      maxFrames: 3,
      maxFrameBytes: 1024,
      onFrame() {},
    });

    expect(channel.streamFrames).toHaveBeenCalledTimes(1);
    expect(commands.at(-1)).toMatchObject({
      op: "startStream",
      params: {
        profile: {
          encoding: "h264",
          framesPerSecond: 15,
          scalingPercent: 25,
        },
        maxFrames: 3,
        maxFrameBytes: 1024,
      },
    });
    expect(channel.streamFrames).toHaveBeenCalledWith(
      expect.objectContaining({ op: "startStream" }),
      expect.objectContaining({
        maxFrames: 3,
        maxFrameBytes: 1024,
        acknowledgeFrames: true,
        requireContiguousSequence: true,
      }),
    );
  });

  it("captures one BGRA correctness frame without claiming stream capability", async () => {
    const { adapter, channel, commands } = harness({
      ...NATIVE_CAPABILITIES,
      h264Stream: false,
      bgraStream: false,
    });
    vi.mocked(channel.streamFrames).mockImplementationOnce(
      async (command, options) => {
        commands.push(command);
        await options.onFrame(capturedFrame());
        return {
          ...stats(),
          frameCount: 1,
          byteCount: 4,
          firstFrameAt: "now",
          endReason: "max-frames",
        };
      },
    );

    await expect(
      adapter.captureNativeFrame({ maxFrameBytes: 1024 }),
    ).resolves.toMatchObject({
      encoding: "bgra",
      width: 1,
      height: 1,
      bytesPerRow: 4,
    });
    expect(commands.at(-1)).toMatchObject({
      op: "captureFrame",
      params: { maxFrameBytes: 1024 },
    });
    expect(channel.streamFrames).toHaveBeenCalledWith(
      expect.objectContaining({ op: "captureFrame" }),
      expect.objectContaining({ maxFrames: 1, maxFrameBytes: 1024 }),
    );
  });

  it("runs a bounded acknowledged BGRA correctness stream without enabling product streaming", async () => {
    const { adapter, channel, commands } = harness({
      ...NATIVE_CAPABILITIES,
      h264Stream: false,
      bgraStream: false,
    });
    const frames: IOSSimulatorBgraFrame[] = [];
    vi.mocked(channel.streamFrames).mockImplementationOnce(
      async (command, options) => {
        commands.push(command);
        await options.onFrame({ ...capturedFrame(), sequence: 0 });
        return {
          ...stats(),
          frameCount: 1,
          byteCount: 4,
          firstFrameAt: "now",
          endReason: "max-frames",
        };
      },
    );

    await expect(
      adapter.streamNativeBgraCorrectnessFrames({
        framesPerSecond: 5,
        maxFrames: 1,
        maxFrameBytes: 1024,
        onFrame(frame) {
          frames.push(frame);
        },
      }),
    ).resolves.toMatchObject({
      frameCount: 1,
      endReason: "max-frames",
    });
    expect(frames).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({
      op: "startBgraCorrectnessStream",
      params: {
        framesPerSecond: 5,
        maxFrames: 1,
        maxFrameBytes: 1024,
      },
    });
    expect(channel.streamFrames).toHaveBeenCalledWith(
      expect.objectContaining({ op: "startBgraCorrectnessStream" }),
      expect.objectContaining({
        maxFrames: 1,
        maxFrameBytes: 1024,
        acknowledgeFrames: true,
        requireContiguousSequence: true,
      }),
    );
  });

  it("runs the acknowledged H.264 producer gate without enabling product streaming", async () => {
    const { adapter, channel, commands } = harness({
      ...NATIVE_CAPABILITIES,
      h264Stream: false,
      bgraStream: false,
    });
    const frames: IOSSimulatorH264Frame[] = [];
    vi.mocked(channel.streamFrames).mockImplementationOnce(
      async (command, options) => {
        commands.push(command);
        await options.onFrame(h264Frame());
        return {
          ...stats(),
          frameCount: 1,
          byteCount: h264Frame().bytes.byteLength,
          firstFrameAt: "now",
          endReason: "max-frames",
        };
      },
    );

    await expect(
      adapter.streamNativeH264CorrectnessFrames({
        framesPerSecond: 30,
        maxFrames: 1,
        maxFrameBytes: 1024,
        onFrame(frame) {
          frames.push(frame);
        },
      }),
    ).resolves.toMatchObject({
      frameCount: 1,
      endReason: "max-frames",
    });
    expect(frames).toHaveLength(1);
    expect(commands.at(-1)).toMatchObject({
      op: "startH264CorrectnessStream",
      params: {
        framesPerSecond: 30,
        maxFrames: 1,
        maxFrameBytes: 1024,
      },
    });
    expect(channel.streamFrames).toHaveBeenCalledWith(
      expect.objectContaining({ op: "startH264CorrectnessStream" }),
      expect.objectContaining({
        maxFrames: 1,
        maxFrameBytes: 1024,
        acknowledgeFrames: true,
        requireContiguousSequence: true,
      }),
    );
  });

  it("rejects the wrong frame encoding from the H.264 correctness stream", async () => {
    const { adapter, channel } = harness({
      ...NATIVE_CAPABILITIES,
      h264Stream: false,
    });
    vi.mocked(channel.streamFrames).mockImplementationOnce(
      async (_command, options) => {
        await options.onFrame(capturedFrame());
        return stats();
      },
    );

    await expect(
      adapter.streamNativeH264CorrectnessFrames({
        framesPerSecond: 5,
        maxFrames: 1,
        onFrame() {},
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("fails closed before transport for unsupported capabilities and invalid paths", async () => {
    const { adapter, channel } = harness({
      ...NATIVE_CAPABILITIES,
      h264Stream: false,
      continuousInput: false,
      multiTouch: false,
    });

    await expect(
      adapter.configureNativeStream({
        encoding: "h264",
        framesPerSecond: 30,
        scalingPercent: 50,
      }),
    ).rejects.toBeInstanceOf(IOSSimulatorNativeSidecarAdapterError);
    await expect(
      adapter.touchPath([
        { phase: "down", x: 1, y: 1 },
        { phase: "up", x: 2, y: 2 },
      ]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(
      adapter.swipe({ x: 1, y: 1 }, { x: 2, y: 2 }, 0),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(channel.request).not.toHaveBeenCalled();
  });

  it("does not let a sidecar claim semantic/session/JPEG responsibilities", () => {
    const { adapter } = harness({
      ...NATIVE_CAPABILITIES,
      accessibility: true,
      sessions: true,
      jpegStream: true,
    });
    expect(adapter.capabilities).toMatchObject({
      accessibility: false,
      sessions: false,
      jpegStream: false,
      h264Stream: true,
    });
  });

  it("rejects malformed availability replies and unbounded stream profiles", async () => {
    const { adapter, channel } = harness();
    vi.mocked(channel.request).mockResolvedValueOnce({
      message: "missing ready",
    });
    await expect(adapter.availability()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
    await expect(
      adapter.configureNativeStream({
        encoding: "h264",
        framesPerSecond: 61,
        scalingPercent: 50,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(() =>
      adapter.streamNativeBgraCorrectnessFrames({
        framesPerSecond: 16,
        maxFrames: 1,
        onFrame() {},
      }),
    ).toThrow("framesPerSecond");
    expect(() =>
      adapter.streamNativeBgraCorrectnessFrames({
        framesPerSecond: 5,
        maxFrames: 901,
        onFrame() {},
      }),
    ).toThrow("maxFrames");
    expect(() =>
      adapter.streamNativeH264CorrectnessFrames({
        framesPerSecond: 31,
        maxFrames: 1,
        onFrame() {},
      }),
    ).toThrow("framesPerSecond");
    expect(() =>
      adapter.streamNativeH264CorrectnessFrames({
        framesPerSecond: 5,
        maxFrames: 901,
        onFrame() {},
      }),
    ).toThrow("maxFrames");
  });

  it("rejects a gesture without deterministic down/up boundaries", async () => {
    const { adapter, channel } = harness();
    await expect(
      adapter.touchPath([
        { phase: "move", x: 1, y: 1 },
        { phase: "up", x: 2, y: 2 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      adapter.touchPath([
        { phase: "down", x: 1, y: 1 },
        { phase: "move", x: 2, y: 2 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      adapter.touchPath([
        { phase: "down", x: 1, y: 1 },
        { phase: "down", x: 2, y: 2 },
        { phase: "up", x: 3, y: 3 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(channel.request).not.toHaveBeenCalled();
  });

  it("normalizes bounded edge samples and rejects coordinate or edge drift", async () => {
    const { adapter, commands } = harness();
    await adapter.touchPath([
      { phase: "down", x: 0, y: 0.5, edge: "left" },
      { phase: "move", x: 0.25, y: 0.5, edge: "left" },
      { phase: "up", x: 0.5, y: 0.5, edge: "left" },
    ]);
    expect(commands.at(-1)?.params).toEqual({
      points: [
        {
          phase: "down",
          x: 0,
          y: 0.5,
          dtMs: 0,
          edge: "left",
        },
        {
          phase: "move",
          x: 0.25,
          y: 0.5,
          dtMs: 16,
          edge: "left",
        },
        {
          phase: "up",
          x: 0.5,
          y: 0.5,
          dtMs: 16,
          edge: "left",
        },
      ],
    });
    await expect(
      adapter.touchPath([
        { phase: "down", x: 2, y: 0.5 },
        { phase: "up", x: 0.5, y: 0.5 },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      adapter.touchPath([
        { phase: "down", x: 0, y: 0.5, edge: "left" },
        { phase: "up", x: 0.5, y: 0.5, edge: "none" },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("requires synchronized bounded multi-touch samples", async () => {
    const { adapter, commands } = harness();
    await adapter.touch2Path(
      [
        { phase: "down", x: 0.4, y: 0.5 },
        { phase: "move", x: 0.3, y: 0.5, dtMs: 20 },
        { phase: "up", x: 0.2, y: 0.5, dtMs: 20 },
      ],
      [
        { phase: "down", x: 0.6, y: 0.5 },
        { phase: "move", x: 0.7, y: 0.5, dtMs: 20 },
        { phase: "up", x: 0.8, y: 0.5, dtMs: 20 },
      ],
    );
    expect(commands.at(-1)?.op).toBe("touch2Path");
    await expect(
      adapter.touch2Path(
        [
          { phase: "down", x: 0.4, y: 0.5 },
          { phase: "up", x: 0.3, y: 0.5, dtMs: 20 },
        ],
        [
          { phase: "down", x: 0.6, y: 0.5 },
          { phase: "up", x: 0.7, y: 0.5, dtMs: 30 },
        ],
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
