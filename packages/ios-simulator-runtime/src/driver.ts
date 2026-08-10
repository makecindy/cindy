/** Host-neutral simulator contracts. Concrete drivers remain implementation details. */

export type IOSSimulatorDriverKind = "wda" | "native-sidecar" | "composite";

/**
 * Capability flags are intentionally explicit so the host can choose one
 * adapter per operation without inferring support from method presence.
 */
export interface IOSSimulatorDriverCapabilities {
  accessibility: boolean;
  sessions: boolean;
  jpegStream: boolean;
  h264Stream: boolean;
  bgraStream: boolean;
  discreteInput: boolean;
  continuousInput: boolean;
  multiTouch: boolean;
}

export const IOS_SIMULATOR_WDA_CAPABILITIES: Readonly<IOSSimulatorDriverCapabilities> =
  Object.freeze({
    accessibility: true,
    sessions: true,
    jpegStream: true,
    h264Stream: false,
    bgraStream: false,
    discreteInput: true,
    continuousInput: false,
    multiTouch: false,
  });

export interface IOSSimulatorDriverAdapter {
  readonly kind: IOSSimulatorDriverKind;
  readonly capabilities: Readonly<IOSSimulatorDriverCapabilities>;
}

export type IOSSimulatorOrientation = "PORTRAIT" | "LANDSCAPE";
export type IOSSimulatorFrameColorSpace = "srgb" | "display-p3" | "unknown";

export interface IOSSimulatorDriverHealth {
  ready: boolean;
  message: string | null;
  osName: string | null;
  osVersion: string | null;
  sdkVersion: string | null;
  deviceIp: string | null;
}

export interface IOSSimulatorDriverSession {
  id: string;
  capabilities: Record<string, unknown>;
  createdAt: string;
}

export interface IOSSimulatorAccessibilitySnapshot {
  capturedAt: string;
  /** Driver-native tree. A later screen-map layer owns normalization and token reduction. */
  tree: unknown;
}

export interface IOSSimulatorStreamProfile {
  framesPerSecond: number;
  jpegQuality: number;
  scalingPercent: number;
}

export interface IOSSimulatorJpegFrame {
  /** Optional during the WDA compatibility period; omitted frames are JPEG. */
  encoding?: "jpeg";
  bytes: Uint8Array;
  receivedAt: string;
}

export interface IOSSimulatorH264Frame {
  encoding: "h264";
  /** Native sidecar sequence when the frame came from a framed stream. */
  sequence?: number;
  /** Encoded access-unit framing used by the native sidecar. */
  format: "annex-b" | "length-prefixed";
  bytes: Uint8Array;
  receivedAt: string;
  width: number;
  height: number;
  orientation: IOSSimulatorOrientation;
  scale: number;
  colorSpace: IOSSimulatorFrameColorSpace;
  timestampMicros: number;
  keyFrame: boolean;
}

export interface IOSSimulatorBgraFrame {
  encoding: "bgra";
  /** Native sidecar sequence when the frame came from a framed stream. */
  sequence?: number;
  bytes: Uint8Array;
  receivedAt: string;
  width: number;
  height: number;
  bytesPerRow: number;
  orientation: IOSSimulatorOrientation;
  scale: number;
  colorSpace: IOSSimulatorFrameColorSpace;
  timestampMicros: number;
}

export type IOSSimulatorFrame =
  IOSSimulatorJpegFrame | IOSSimulatorH264Frame | IOSSimulatorBgraFrame;

export type IOSSimulatorNativeFrame =
  IOSSimulatorH264Frame | IOSSimulatorBgraFrame;

export interface IOSSimulatorNativeStreamProfile {
  encoding: "h264" | "bgra";
  framesPerSecond: number;
  scalingPercent: number;
  orientation?: IOSSimulatorOrientation;
}

export type IOSSimulatorTouchEdge =
  "none" | "left" | "top" | "bottom" | "right";

export interface IOSSimulatorTouchPoint extends IOSSimulatorPoint {
  phase: "down" | "move" | "up" | "cancel";
  dtMs?: number;
  /**
   * Native HID coordinates are normalized device coordinates. Edge is carried
   * on every sample so a cancelled/released path keeps the same system-gesture
   * routing as its initial touch-down.
   */
  edge?: IOSSimulatorTouchEdge;
}

export interface IOSSimulatorLiveTouchPoint extends IOSSimulatorPoint {
  edge?: IOSSimulatorTouchEdge;
}

export interface IOSSimulatorNativeSidecarAvailability {
  ready: boolean;
  message: string | null;
  capabilities: Readonly<IOSSimulatorDriverCapabilities>;
}

/** Optional continuous/multi-touch input capability supplied by a native adapter. */
export interface IOSSimulatorNativeSidecarDriver extends IOSSimulatorDriverAdapter {
  readonly kind: "native-sidecar";
  readonly simulatorUdid: string;
  readonly generation: number;
  availability(
    signal?: AbortSignal,
  ): Promise<IOSSimulatorNativeSidecarAvailability>;
  /**
   * Read one exact-UDID framebuffer snapshot for native correctness checks.
   * This does not imply or advertise continuous BGRA streaming support.
   */
  captureNativeFrame(options?: {
    signal?: AbortSignal;
    maxFrameBytes?: number;
  }): Promise<IOSSimulatorBgraFrame>;
  /**
   * Bounded, acknowledged BGRA stream used only for native correctness and
   * stability gates. This does not imply or advertise product BGRA support.
   */
  streamNativeBgraCorrectnessFrames(options: {
    framesPerSecond: number;
    maxFrames: number;
    maxFrameBytes?: number;
    signal?: AbortSignal;
    onFrame(frame: IOSSimulatorBgraFrame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats>;
  /**
   * Bounded, acknowledged Annex-B stream used only to validate the native
   * VideoToolbox producer. Product H.264 capability remains separately gated.
   */
  streamNativeH264CorrectnessFrames(options: {
    framesPerSecond: number;
    maxFrames: number;
    maxFrameBytes?: number;
    signal?: AbortSignal;
    onFrame(frame: IOSSimulatorH264Frame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats>;
  configureNativeStream(
    profile: IOSSimulatorNativeStreamProfile,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorNativeStreamProfile>;
  streamNativeFrames(options: {
    signal?: AbortSignal;
    maxFrames?: number;
    maxFrameBytes?: number;
    onFrame(frame: IOSSimulatorNativeFrame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats>;
  tap(point: IOSSimulatorPoint, signal?: AbortSignal): Promise<void>;
  swipe(
    start: IOSSimulatorPoint,
    end: IOSSimulatorPoint,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  touchPath(
    points: IOSSimulatorTouchPoint[],
    signal?: AbortSignal,
  ): Promise<void>;
  touch2Path(
    first: IOSSimulatorTouchPoint[],
    second: IOSSimulatorTouchPoint[],
    signal?: AbortSignal,
  ): Promise<void>;
  beginTouch(
    gestureId: string,
    point: IOSSimulatorLiveTouchPoint,
    signal?: AbortSignal,
  ): Promise<void>;
  moveTouch(
    gestureId: string,
    point: IOSSimulatorLiveTouchPoint,
    signal?: AbortSignal,
  ): Promise<void>;
  endTouch(
    gestureId: string,
    point: IOSSimulatorLiveTouchPoint,
    cancelled?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  detach(signal?: AbortSignal): Promise<void>;
}

export interface IOSSimulatorStreamStats {
  frameCount: number;
  byteCount: number;
  startedAt: string;
  firstFrameAt: string | null;
  endedAt: string;
  endReason: "max-frames" | "aborted" | "eof" | "error";
  /** Sanitized producer detail when a stream terminates with an error. */
  endMessage?: string;
}

export interface IOSSimulatorPoint {
  x: number;
  y: number;
}

export interface IOSSimulatorWindowSize {
  width: number;
  height: number;
}

/** Accessibility and session operations currently provided by WDA. */
export interface IOSSimulatorSemanticDriver extends IOSSimulatorDriverAdapter {
  probe(signal?: AbortSignal): Promise<IOSSimulatorDriverHealth>;
  createSession(signal?: AbortSignal): Promise<IOSSimulatorDriverSession>;
  deleteSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  getAccessibilityTree(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorAccessibilitySnapshot>;
  getWindowSize(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorWindowSize>;
  getOrientation(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorOrientation>;
}

/** Discrete input fallback used when continuous native HID is unavailable. */
export interface IOSSimulatorDiscreteInputDriver extends IOSSimulatorDriverAdapter {
  tap(
    sessionId: string,
    point: IOSSimulatorPoint,
    signal?: AbortSignal,
  ): Promise<void>;
  swipe(
    sessionId: string,
    start: IOSSimulatorPoint,
    end: IOSSimulatorPoint,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  typeText(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void>;
  home(signal?: AbortSignal): Promise<void>;
  lock(sessionId?: string, signal?: AbortSignal): Promise<void>;
  unlock(sessionId?: string, signal?: AbortSignal): Promise<void>;
  setOrientation(
    orientation: IOSSimulatorOrientation,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** JPEG stream source consumed by the current renderer frame pump. */
export interface IOSSimulatorJpegStreamDriver extends IOSSimulatorDriverAdapter {
  configureStream(
    sessionId: string,
    profile: IOSSimulatorStreamProfile,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorStreamProfile>;
  streamFrames(options: {
    signal?: AbortSignal;
    maxFrames?: number;
    maxFrameBytes?: number;
    onFrame(frame: IOSSimulatorJpegFrame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats>;
}

/**
 * Backward-compatible WDA aggregate. Host orchestration should depend on the
 * smaller capability interfaces where possible.
 */
export interface IOSSimulatorAutomationDriver
  extends
    IOSSimulatorSemanticDriver,
    IOSSimulatorDiscreteInputDriver,
    IOSSimulatorJpegStreamDriver {
  readonly kind: "wda";
}
