import type {
  IOSSimulatorBgraFrame,
  IOSSimulatorDriverCapabilities,
  IOSSimulatorH264Frame,
  IOSSimulatorLiveTouchPoint,
  IOSSimulatorNativeFrame,
  IOSSimulatorNativeSidecarAvailability,
  IOSSimulatorNativeSidecarDriver,
  IOSSimulatorNativeStreamProfile,
  IOSSimulatorPoint,
  IOSSimulatorStreamStats,
  IOSSimulatorTouchPoint,
} from "../driver.js";
import {
  IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
  IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION,
} from "./protocol.js";

const MAX_TOUCH_POINTS = 4_096;
const MAX_GESTURE_DURATION_MS = 60_000;
const MAX_STREAM_FPS = 60;
const MAX_STREAM_SCALING_PERCENT = 100;
const MAX_CORRECTNESS_STREAM_FPS = 15;
const MAX_H264_CORRECTNESS_STREAM_FPS = 30;
const MAX_CORRECTNESS_STREAM_FRAMES = 900;
const TOUCH_EDGES = new Set(["none", "left", "top", "bottom", "right"]);
const MAX_GESTURE_ID_LENGTH = 128;

export type IOSSimulatorNativeSidecarAdapterErrorCode =
  "INVALID_ARGUMENT" | "UNSUPPORTED_CAPABILITY" | "PROTOCOL_ERROR";

export class IOSSimulatorNativeSidecarAdapterError extends Error {
  constructor(
    readonly code: IOSSimulatorNativeSidecarAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IOSSimulatorNativeSidecarAdapterError";
  }
}

export interface IOSSimulatorNativeSidecarCommand {
  version: number;
  op: string;
  simulatorUdid: string;
  generation: number;
  params?: Record<string, unknown>;
}

export interface IOSSimulatorNativeSidecarTransport {
  request(
    command: IOSSimulatorNativeSidecarCommand,
    signal?: AbortSignal,
  ): Promise<unknown>;
  streamFrames(
    command: IOSSimulatorNativeSidecarCommand,
    options: {
      signal?: AbortSignal;
      maxFrames?: number;
      maxFrameBytes?: number;
      acknowledgeFrames?: boolean;
      awaitStreamEndAfterMaxFrames?: boolean;
      requireContiguousSequence?: boolean;
      onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
    },
  ): Promise<IOSSimulatorStreamStats>;
}

export interface IOSSimulatorNativeSidecarAdapterOptions {
  simulatorUdid: string;
  generation: number;
  capabilities: Readonly<IOSSimulatorDriverCapabilities>;
  channel: IOSSimulatorNativeSidecarTransport;
}

function requirePoint(
  point: IOSSimulatorPoint,
  name: string,
): IOSSimulatorPoint {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must contain finite coordinates`,
    );
  }
  return { x: point.x, y: point.y };
}

function requireGestureId(gestureId: string): string {
  const normalized = gestureId.trim();
  if (
    !normalized ||
    normalized.length > MAX_GESTURE_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      "gestureId must be a bounded opaque identifier",
    );
  }
  return normalized;
}

function requireLiveTouchPoint(
  point: IOSSimulatorLiveTouchPoint,
  name: string,
): Required<IOSSimulatorLiveTouchPoint> {
  requirePoint(point, name);
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must use normalized coordinates`,
    );
  }
  const edge = point.edge ?? "none";
  if (!TOUCH_EDGES.has(edge)) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name}.edge is invalid`,
    );
  }
  return { x: point.x, y: point.y, edge };
}

function requireDuration(durationMs: number): number {
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_GESTURE_DURATION_MS
  ) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `durationMs must be between 1 and ${MAX_GESTURE_DURATION_MS}`,
    );
  }
  return durationMs;
}

function requireTouchPath(
  points: IOSSimulatorTouchPoint[],
  name: string,
): IOSSimulatorTouchPoint[] {
  if (points.length < 2 || points.length > MAX_TOUCH_POINTS) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must contain between 2 and ${MAX_TOUCH_POINTS} points`,
    );
  }
  if (points[0]?.phase !== "down") {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must start with down`,
    );
  }
  const lastPhase = points.at(-1)?.phase;
  if (lastPhase !== "up" && lastPhase !== "cancel") {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must end with up or cancel`,
    );
  }
  let totalDurationMs = 0;
  let edge: IOSSimulatorTouchPoint["edge"];
  return points.map((point, index) => {
    requirePoint(point, `${name}[${index}]`);
    if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name}[${index}] must use normalized coordinates`,
      );
    }
    if (index > 0 && index < points.length - 1 && point.phase !== "move") {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name}[${index}] must be move`,
      );
    }
    const dtMs = point.dtMs ?? (index === 0 ? 0 : 16);
    if (
      !Number.isSafeInteger(dtMs) ||
      dtMs < 0 ||
      dtMs > MAX_GESTURE_DURATION_MS
    ) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name}[${index}].dtMs is invalid`,
      );
    }
    if (index === 0 && dtMs !== 0) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name}[0].dtMs must be zero`,
      );
    }
    if (point.phase === "move" && dtMs < 4) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name}[${index}].dtMs must be at least 4`,
      );
    }
    totalDurationMs += dtMs;
    if (totalDurationMs > MAX_GESTURE_DURATION_MS) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name} exceeds the maximum gesture duration`,
      );
    }
    const pointEdge = point.edge ?? "none";
    if (!TOUCH_EDGES.has(pointEdge)) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name}[${index}].edge is invalid`,
      );
    }
    edge ??= pointEdge;
    if (pointEdge !== edge) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `${name} must keep one edge for the full gesture`,
      );
    }
    return { ...point, dtMs, edge: pointEdge };
  });
}

function requireSynchronizedTouchPaths(
  first: IOSSimulatorTouchPoint[],
  second: IOSSimulatorTouchPoint[],
): {
  first: IOSSimulatorTouchPoint[];
  second: IOSSimulatorTouchPoint[];
} {
  const normalizedFirst = requireTouchPath(first, "first");
  const normalizedSecond = requireTouchPath(second, "second");
  if (normalizedFirst.length !== normalizedSecond.length) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      "Multi-touch paths must contain the same number of samples",
    );
  }
  for (let index = 0; index < normalizedFirst.length; index += 1) {
    const firstPoint = normalizedFirst[index]!;
    const secondPoint = normalizedSecond[index]!;
    if (
      firstPoint.phase !== secondPoint.phase ||
      (firstPoint.dtMs ?? 0) !== (secondPoint.dtMs ?? 0)
    ) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        `Multi-touch sample ${index} must have matching phase and timing`,
      );
    }
    if (firstPoint.edge !== "none" || secondPoint.edge !== "none") {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        "Multi-touch paths do not support system-edge routing",
      );
    }
  }
  return { first: normalizedFirst, second: normalizedSecond };
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must be a positive integer`,
    );
  }
  return value;
}

function requireIntegerRange(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new IOSSimulatorNativeSidecarAdapterError(
      "INVALID_ARGUMENT",
      `${name} must be between ${min} and ${max}`,
    );
  }
  return value;
}

/**
 * Per-instance native acceleration adapter. It never owns Session policy,
 * simulator lifecycle or media persistence; every command is bound to one
 * exact UDID and generation before it reaches the sidecar channel.
 */
export class IOSSimulatorNativeSidecarAdapter implements IOSSimulatorNativeSidecarDriver {
  readonly kind = "native-sidecar" as const;
  readonly simulatorUdid: string;
  readonly generation: number;
  readonly capabilities: Readonly<IOSSimulatorDriverCapabilities>;
  readonly #channel: IOSSimulatorNativeSidecarTransport;
  #profile: IOSSimulatorNativeStreamProfile | null = null;

  constructor(options: IOSSimulatorNativeSidecarAdapterOptions) {
    const simulatorUdid = options.simulatorUdid.trim();
    if (!simulatorUdid) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        "simulatorUdid is required",
      );
    }
    requirePositiveInteger(options.generation, "generation");
    this.simulatorUdid = simulatorUdid;
    this.generation = options.generation;
    this.capabilities = Object.freeze({
      ...options.capabilities,
      accessibility: false,
      sessions: false,
      jpegStream: false,
    });
    this.#channel = options.channel;
  }

  async availability(
    signal?: AbortSignal,
  ): Promise<IOSSimulatorNativeSidecarAvailability> {
    const result = await this.#request("availability", undefined, signal);
    if (
      !result ||
      typeof result !== "object" ||
      !("ready" in result) ||
      typeof (result as { ready?: unknown }).ready !== "boolean"
    ) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "PROTOCOL_ERROR",
        "Native sidecar availability reply is invalid",
      );
    }
    const reply = result as { ready: boolean; message?: unknown };
    return {
      ready: reply.ready,
      message: typeof reply.message === "string" ? reply.message : null,
      capabilities: this.capabilities,
    };
  }

  async captureNativeFrame(
    options: {
      signal?: AbortSignal;
      maxFrameBytes?: number;
    } = {},
  ): Promise<IOSSimulatorBgraFrame> {
    const maxFrameBytes =
      options.maxFrameBytes === undefined
        ? undefined
        : requirePositiveInteger(options.maxFrameBytes, "maxFrameBytes");
    let captured: IOSSimulatorBgraFrame | null = null;
    const stats = await this.#channel.streamFrames(
      this.#command("captureFrame", {
        ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
      }),
      {
        signal: options.signal,
        maxFrames: 1,
        maxFrameBytes,
        onFrame(frame) {
          if (captured) {
            throw new IOSSimulatorNativeSidecarAdapterError(
              "PROTOCOL_ERROR",
              "Native sidecar emitted more than one capture frame",
            );
          }
          if (frame.encoding !== "bgra") {
            throw new IOSSimulatorNativeSidecarAdapterError(
              "PROTOCOL_ERROR",
              "Native sidecar capture must return a BGRA frame",
            );
          }
          captured = frame;
        },
      },
    );
    if (stats.frameCount !== 1 || captured === null) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "PROTOCOL_ERROR",
        "Native sidecar capture did not return exactly one frame",
      );
    }
    return captured;
  }

  streamNativeBgraCorrectnessFrames(options: {
    framesPerSecond: number;
    maxFrames: number;
    maxFrameBytes?: number;
    signal?: AbortSignal;
    onFrame(frame: IOSSimulatorBgraFrame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats> {
    const framesPerSecond = requireIntegerRange(
      options.framesPerSecond,
      "framesPerSecond",
      1,
      MAX_CORRECTNESS_STREAM_FPS,
    );
    const maxFrames = requireIntegerRange(
      options.maxFrames,
      "maxFrames",
      1,
      MAX_CORRECTNESS_STREAM_FRAMES,
    );
    const maxFrameBytes =
      options.maxFrameBytes === undefined
        ? IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES
        : requireIntegerRange(
            options.maxFrameBytes,
            "maxFrameBytes",
            1,
            IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
          );
    return this.#channel.streamFrames(
      this.#command("startBgraCorrectnessStream", {
        framesPerSecond,
        maxFrames,
        maxFrameBytes,
      }),
      {
        signal: options.signal,
        maxFrames,
        maxFrameBytes,
        acknowledgeFrames: true,
        awaitStreamEndAfterMaxFrames: true,
        requireContiguousSequence: true,
        async onFrame(frame) {
          if (frame.encoding !== "bgra") {
            throw new IOSSimulatorNativeSidecarAdapterError(
              "PROTOCOL_ERROR",
              "Native correctness stream must return BGRA frames",
            );
          }
          await options.onFrame(frame);
        },
      },
    );
  }

  streamNativeH264CorrectnessFrames(options: {
    framesPerSecond: number;
    maxFrames: number;
    maxFrameBytes?: number;
    signal?: AbortSignal;
    onFrame(frame: IOSSimulatorH264Frame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats> {
    const framesPerSecond = requireIntegerRange(
      options.framesPerSecond,
      "framesPerSecond",
      1,
      MAX_H264_CORRECTNESS_STREAM_FPS,
    );
    const maxFrames = requireIntegerRange(
      options.maxFrames,
      "maxFrames",
      1,
      MAX_CORRECTNESS_STREAM_FRAMES,
    );
    const maxFrameBytes =
      options.maxFrameBytes === undefined
        ? IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES
        : requireIntegerRange(
            options.maxFrameBytes,
            "maxFrameBytes",
            1,
            IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES,
          );
    return this.#channel.streamFrames(
      this.#command("startH264CorrectnessStream", {
        framesPerSecond,
        maxFrames,
        maxFrameBytes,
      }),
      {
        signal: options.signal,
        maxFrames,
        maxFrameBytes,
        acknowledgeFrames: true,
        awaitStreamEndAfterMaxFrames: true,
        requireContiguousSequence: true,
        async onFrame(frame) {
          if (frame.encoding !== "h264") {
            throw new IOSSimulatorNativeSidecarAdapterError(
              "PROTOCOL_ERROR",
              "Native H.264 correctness stream must return H.264 frames",
            );
          }
          await options.onFrame(frame);
        },
      },
    );
  }

  async configureNativeStream(
    profile: IOSSimulatorNativeStreamProfile,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorNativeStreamProfile> {
    if (
      (profile.encoding === "h264" && !this.capabilities.h264Stream) ||
      (profile.encoding === "bgra" && !this.capabilities.bgraStream)
    ) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "UNSUPPORTED_CAPABILITY",
        `Native sidecar does not support ${profile.encoding} streaming`,
      );
    }
    const normalized = {
      encoding: profile.encoding,
      framesPerSecond: requireIntegerRange(
        profile.framesPerSecond,
        "framesPerSecond",
        1,
        MAX_STREAM_FPS,
      ),
      scalingPercent: requireIntegerRange(
        profile.scalingPercent,
        "scalingPercent",
        1,
        MAX_STREAM_SCALING_PERCENT,
      ),
      orientation:
        profile.orientation === "PORTRAIT" ||
        profile.orientation === "LANDSCAPE"
          ? profile.orientation
          : profile.orientation === undefined
            ? "PORTRAIT"
            : (() => {
                throw new IOSSimulatorNativeSidecarAdapterError(
                  "INVALID_ARGUMENT",
                  "orientation must be PORTRAIT or LANDSCAPE",
                );
              })(),
    } satisfies IOSSimulatorNativeStreamProfile;
    await this.#request("configureStream", normalized, signal);
    this.#profile = normalized;
    return { ...normalized };
  }

  streamNativeFrames(options: {
    signal?: AbortSignal;
    maxFrames?: number;
    maxFrameBytes?: number;
    onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats> {
    if (!this.#profile) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "INVALID_ARGUMENT",
        "Native stream must be configured before it starts",
      );
    }
    const maxFrames =
      options.maxFrames === undefined
        ? undefined
        : requirePositiveInteger(options.maxFrames, "maxFrames");
    const maxFrameBytes =
      options.maxFrameBytes === undefined
        ? undefined
        : requirePositiveInteger(options.maxFrameBytes, "maxFrameBytes");
    return this.#channel.streamFrames(
      this.#command("startStream", {
        profile: { ...this.#profile },
        ...(maxFrames === undefined ? {} : { maxFrames }),
        ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
      }),
      {
        ...options,
        maxFrames,
        maxFrameBytes,
        acknowledgeFrames: true,
        awaitStreamEndAfterMaxFrames: true,
        requireContiguousSequence: true,
      },
    );
  }

  async tap(point: IOSSimulatorPoint, signal?: AbortSignal): Promise<void> {
    this.#requireDiscreteInput();
    await this.#request("tap", { point: requirePoint(point, "point") }, signal);
  }

  async swipe(
    start: IOSSimulatorPoint,
    end: IOSSimulatorPoint,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireDiscreteInput();
    await this.#request(
      "swipe",
      {
        start: requirePoint(start, "start"),
        end: requirePoint(end, "end"),
        durationMs: requireDuration(durationMs),
      },
      signal,
    );
  }

  async touchPath(
    points: IOSSimulatorTouchPoint[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireContinuousInput();
    const stats = await this.#channel.streamFrames(
      this.#command("touchPath", {
        points: requireTouchPath(points, "points"),
      }),
      {
        signal,
        onFrame() {
          throw new IOSSimulatorNativeSidecarAdapterError(
            "PROTOCOL_ERROR",
            "Native HID gesture emitted an unexpected frame",
          );
        },
      },
    );
    if (stats.endReason === "error") {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "PROTOCOL_ERROR",
        stats.endMessage ?? "Native HID gesture failed",
      );
    }
  }

  async touch2Path(
    first: IOSSimulatorTouchPoint[],
    second: IOSSimulatorTouchPoint[],
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireContinuousInput();
    if (!this.capabilities.multiTouch) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "UNSUPPORTED_CAPABILITY",
        "Native sidecar does not support multi-touch input",
      );
    }
    const paths = requireSynchronizedTouchPaths(first, second);
    const stats = await this.#channel.streamFrames(
      this.#command("touch2Path", paths),
      {
        signal,
        onFrame() {
          throw new IOSSimulatorNativeSidecarAdapterError(
            "PROTOCOL_ERROR",
            "Native multi-touch gesture emitted an unexpected frame",
          );
        },
      },
    );
    if (stats.endReason === "error") {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "PROTOCOL_ERROR",
        stats.endMessage ?? "Native multi-touch gesture failed",
      );
    }
  }

  async beginTouch(
    gestureId: string,
    point: IOSSimulatorLiveTouchPoint,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireContinuousInput();
    await this.#request(
      "beginTouch",
      {
        gestureId: requireGestureId(gestureId),
        point: requireLiveTouchPoint(point, "point"),
      },
      signal,
    );
  }

  async moveTouch(
    gestureId: string,
    point: IOSSimulatorLiveTouchPoint,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireContinuousInput();
    await this.#request(
      "moveTouch",
      {
        gestureId: requireGestureId(gestureId),
        point: requireLiveTouchPoint(point, "point"),
      },
      signal,
    );
  }

  async endTouch(
    gestureId: string,
    point: IOSSimulatorLiveTouchPoint,
    cancelled = false,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#requireContinuousInput();
    await this.#request(
      "endTouch",
      {
        gestureId: requireGestureId(gestureId),
        point: requireLiveTouchPoint(point, "point"),
        cancelled,
      },
      signal,
    );
  }

  async detach(signal?: AbortSignal): Promise<void> {
    await this.#request("detach", undefined, signal);
    this.#profile = null;
  }

  #command(
    op: string,
    params?: Record<string, unknown>,
  ): IOSSimulatorNativeSidecarCommand {
    return {
      version: IOS_SIMULATOR_NATIVE_SIDECAR_PROTOCOL_VERSION,
      op,
      simulatorUdid: this.simulatorUdid,
      generation: this.generation,
      ...(params ? { params } : {}),
    };
  }

  #request(
    op: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.#channel.request(this.#command(op, params), signal);
  }

  #requireDiscreteInput(): void {
    if (!this.capabilities.discreteInput) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "UNSUPPORTED_CAPABILITY",
        "Native sidecar does not support discrete input",
      );
    }
  }

  #requireContinuousInput(): void {
    if (!this.capabilities.continuousInput) {
      throw new IOSSimulatorNativeSidecarAdapterError(
        "UNSUPPORTED_CAPABILITY",
        "Native sidecar does not support continuous input",
      );
    }
  }
}
