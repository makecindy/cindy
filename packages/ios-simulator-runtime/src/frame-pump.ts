import type {
  IOSSimulatorH264Frame,
  IOSSimulatorJpegFrame,
  IOSSimulatorJpegStreamDriver,
  IOSSimulatorNativeSidecarDriver,
  IOSSimulatorNativeStreamProfile,
  IOSSimulatorStreamStats,
} from "./driver.js";
import { IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES } from "./native-sidecar/protocol.js";

export type IOSSimulatorFrameStreamState =
  | "idle"
  | "connecting"
  | "streaming"
  | "reconnecting"
  | "paused"
  | "disconnected";

interface IOSSimulatorLatestFrameBase {
  instanceId: string;
  generation: number;
  sequence: number;
  receivedAt: string;
  bytes: Uint8Array;
}

export interface IOSSimulatorLatestJpegFrame extends IOSSimulatorLatestFrameBase {
  encoding: "jpeg";
}

export interface IOSSimulatorLatestH264Frame
  extends
    IOSSimulatorLatestFrameBase,
    Pick<
      IOSSimulatorH264Frame,
      | "format"
      | "width"
      | "height"
      | "orientation"
      | "scale"
      | "colorSpace"
      | "timestampMicros"
      | "keyFrame"
    > {
  encoding: "h264";
}

export type IOSSimulatorLatestFrame =
  IOSSimulatorLatestJpegFrame | IOSSimulatorLatestH264Frame;

export interface IOSSimulatorFramePumpSnapshot {
  instanceId: string;
  generation: number;
  state: IOSSimulatorFrameStreamState;
  reconnectAttempt: number;
  latestFrame: IOSSimulatorLatestFrame | null;
}

interface FramePumpEntry {
  generation: number;
  driver: IOSSimulatorJpegStreamDriver;
  controller: AbortController | null;
  task: Promise<void> | null;
  state: IOSSimulatorFrameStreamState;
  reconnectAttempt: number;
  sequence: number;
  latestFrame: IOSSimulatorLatestFrame | null;
  desiredVisible: boolean;
}

export interface IOSSimulatorFramePumpOptions {
  maxFrameBytes?: number;
  maxReconnectAttempts?: number;
  reconnectDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_JPEG_FRAME_BYTES = 16 * 1024 * 1024;

/** Main-owned latest-frame pump. Frames remain in memory and visibility stops ingestion. */
export class IOSSimulatorFramePump {
  readonly #entries = new Map<string, FramePumpEntry>();
  readonly #maxFrameBytes: number;
  readonly #maxReconnectAttempts: number;
  readonly #reconnectDelaysMs: number[];
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: IOSSimulatorFramePumpOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_JPEG_FRAME_BYTES;
    this.#maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [250, 1_000, 2_000];
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  setVisible(input: {
    instanceId: string;
    generation: number;
    driver: IOSSimulatorJpegStreamDriver;
    visible: boolean;
  }): IOSSimulatorFramePumpSnapshot {
    let entry = this.#entries.get(input.instanceId);
    if (
      !entry ||
      entry.generation !== input.generation ||
      entry.driver !== input.driver
    ) {
      entry?.controller?.abort();
      entry = {
        generation: input.generation,
        driver: input.driver,
        controller: null,
        task: null,
        state: "idle",
        reconnectAttempt: 0,
        sequence: 0,
        latestFrame: null,
        desiredVisible: input.visible,
      };
      this.#entries.set(input.instanceId, entry);
    }
    entry.desiredVisible = input.visible;
    if (!input.visible) {
      entry.controller?.abort();
      entry.controller = null;
      entry.state = "paused";
      return this.snapshot(input.instanceId)!;
    }
    if (!entry.task) {
      entry.controller = new AbortController();
      entry.state = "connecting";
      entry.task = this.#run(
        input.instanceId,
        entry,
        entry.controller.signal,
      ).finally(() => {
        if (this.#entries.get(input.instanceId) === entry) {
          entry.task = null;
          entry.controller = null;
          if (entry.desiredVisible && entry.state !== "disconnected") {
            this.setVisible({ ...input, visible: true });
          }
        }
      });
    }
    return this.snapshot(input.instanceId)!;
  }

  snapshot(instanceId: string): IOSSimulatorFramePumpSnapshot | null {
    const entry = this.#entries.get(instanceId);
    if (!entry) return null;
    return {
      instanceId,
      generation: entry.generation,
      state: entry.state,
      reconnectAttempt: entry.reconnectAttempt,
      latestFrame: entry.latestFrame
        ? { ...entry.latestFrame, bytes: entry.latestFrame.bytes.slice() }
        : null,
    };
  }

  clear(instanceId: string): void {
    const entry = this.#entries.get(instanceId);
    entry?.controller?.abort();
    this.#entries.delete(instanceId);
  }

  async #run(
    instanceId: string,
    entry: FramePumpEntry,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let stats: IOSSimulatorStreamStats | null = null;
      try {
        stats = await entry.driver.streamFrames({
          signal,
          maxFrameBytes: this.#maxFrameBytes,
          onFrame: (frame) => this.#acceptFrame(instanceId, entry, frame),
        });
      } catch {
        if (signal.aborted) break;
      }
      if (signal.aborted || stats?.endReason === "aborted") break;
      entry.reconnectAttempt += 1;
      if (entry.reconnectAttempt > this.#maxReconnectAttempts) {
        entry.state = "disconnected";
        entry.latestFrame = null;
        return;
      }
      entry.state = "reconnecting";
      const delay =
        this.#reconnectDelaysMs[
          Math.min(
            entry.reconnectAttempt - 1,
            this.#reconnectDelaysMs.length - 1,
          )
        ] ?? 0;
      if (delay > 0) await this.#sleep(delay);
    }
    if (this.#entries.get(instanceId) === entry && entry.state !== "paused") {
      entry.state = "paused";
    }
  }

  #acceptFrame(
    instanceId: string,
    entry: FramePumpEntry,
    frame: IOSSimulatorJpegFrame,
  ): void {
    if (
      this.#entries.get(instanceId) !== entry ||
      entry.controller?.signal.aborted
    )
      return;
    entry.sequence += 1;
    entry.reconnectAttempt = 0;
    entry.state = "streaming";
    entry.latestFrame = {
      instanceId,
      generation: entry.generation,
      sequence: entry.sequence,
      encoding: "jpeg",
      receivedAt: frame.receivedAt,
      bytes: frame.bytes.slice(),
    };
  }
}

interface H264FramePumpEntry {
  generation: number;
  driver: IOSSimulatorNativeSidecarDriver;
  profile: IOSSimulatorNativeStreamProfile;
  controller: AbortController | null;
  task: Promise<void> | null;
  state: IOSSimulatorFrameStreamState;
  reconnectAttempt: number;
  sequence: number;
  latestFrame: IOSSimulatorLatestH264Frame | null;
  desiredVisible: boolean;
}

export interface IOSSimulatorH264FramePumpOptions {
  maxFrameBytes?: number;
  maxReconnectAttempts?: number;
  reconnectDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called for each accepted frame before the retained snapshot is exposed. */
  onFrame?: (frame: IOSSimulatorLatestH264Frame) => void;
}

/**
 * Main-owned H.264 pump. It only accepts a capability-selected native driver,
 * retains one access unit, and never persists transient encoded bytes.
 */
export class IOSSimulatorH264FramePump {
  readonly #entries = new Map<string, H264FramePumpEntry>();
  readonly #maxFrameBytes: number;
  readonly #maxReconnectAttempts: number;
  readonly #reconnectDelaysMs: number[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onFrame: ((frame: IOSSimulatorLatestH264Frame) => void) | null;

  constructor(options: IOSSimulatorH264FramePumpOptions = {}) {
    this.#maxFrameBytes =
      options.maxFrameBytes ??
      IOS_SIMULATOR_NATIVE_SIDECAR_MAX_FRAME_PAYLOAD_BYTES;
    this.#maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
    this.#reconnectDelaysMs = options.reconnectDelaysMs ?? [250, 1_000, 2_000];
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#onFrame = options.onFrame ?? null;
  }

  setVisible(input: {
    instanceId: string;
    generation: number;
    driver: IOSSimulatorNativeSidecarDriver;
    profile: IOSSimulatorNativeStreamProfile;
    visible: boolean;
  }): IOSSimulatorFramePumpSnapshot {
    let entry = this.#entries.get(input.instanceId);
    let predecessor: Promise<void> | null = null;
    if (
      !entry ||
      entry.generation !== input.generation ||
      entry.driver !== input.driver ||
      entry.profile.encoding !== input.profile.encoding ||
      entry.profile.framesPerSecond !== input.profile.framesPerSecond ||
      entry.profile.scalingPercent !== input.profile.scalingPercent ||
      entry.profile.orientation !== input.profile.orientation
    ) {
      const inheritedSequence =
        entry?.generation === input.generation ? entry.sequence : 0;
      predecessor = entry?.task ?? null;
      entry?.controller?.abort();
      entry = {
        generation: input.generation,
        driver: input.driver,
        profile: { ...input.profile },
        controller: null,
        task: null,
        state: "idle",
        reconnectAttempt: 0,
        sequence: inheritedSequence,
        latestFrame: null,
        desiredVisible: input.visible,
      };
      this.#entries.set(input.instanceId, entry);
    }
    entry.desiredVisible = input.visible;
    if (!input.visible) {
      entry.controller?.abort();
      entry.controller = null;
      entry.state = "paused";
      return this.snapshot(input.instanceId)!;
    }
    if (!entry.task) {
      entry.controller = new AbortController();
      entry.state = "connecting";
      const run = () =>
        this.#run(input.instanceId, entry!, entry!.controller!.signal);
      entry.task = (
        predecessor ? predecessor.catch(() => undefined).then(run) : run()
      ).finally(() => {
        if (this.#entries.get(input.instanceId) === entry) {
          entry!.task = null;
          entry!.controller = null;
          if (entry!.desiredVisible && entry!.state !== "disconnected") {
            this.setVisible({ ...input, visible: true });
          }
        }
      });
    }
    return this.snapshot(input.instanceId)!;
  }

  snapshot(instanceId: string): IOSSimulatorFramePumpSnapshot | null {
    const entry = this.#entries.get(instanceId);
    if (!entry) return null;
    return {
      instanceId,
      generation: entry.generation,
      state: entry.state,
      reconnectAttempt: entry.reconnectAttempt,
      latestFrame: entry.latestFrame
        ? { ...entry.latestFrame, bytes: entry.latestFrame.bytes.slice() }
        : null,
    };
  }

  clear(instanceId: string): void {
    const entry = this.#entries.get(instanceId);
    entry?.controller?.abort();
    this.#entries.delete(instanceId);
  }

  async #run(
    instanceId: string,
    entry: H264FramePumpEntry,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      let stats: IOSSimulatorStreamStats | null = null;
      try {
        await entry.driver.configureNativeStream(entry.profile, signal);
        stats = await entry.driver.streamNativeFrames({
          signal,
          maxFrameBytes: this.#maxFrameBytes,
          onFrame: (frame) => {
            if (frame.encoding !== "h264") {
              throw new Error("Native H.264 stream returned a non-H.264 frame");
            }
            this.#acceptFrame(instanceId, entry, frame);
          },
        });
      } catch {
        if (signal.aborted) break;
      }
      if (signal.aborted || stats?.endReason === "aborted") break;
      entry.reconnectAttempt += 1;
      if (entry.reconnectAttempt > this.#maxReconnectAttempts) {
        entry.state = "disconnected";
        entry.latestFrame = null;
        return;
      }
      entry.state = "reconnecting";
      const delay =
        this.#reconnectDelaysMs[
          Math.min(
            entry.reconnectAttempt - 1,
            this.#reconnectDelaysMs.length - 1,
          )
        ] ?? 0;
      if (delay > 0) await this.#sleep(delay);
    }
    if (this.#entries.get(instanceId) === entry && entry.state !== "paused") {
      entry.state = "paused";
    }
  }

  #acceptFrame(
    instanceId: string,
    entry: H264FramePumpEntry,
    frame: IOSSimulatorH264Frame,
  ): void {
    if (
      this.#entries.get(instanceId) !== entry ||
      entry.controller?.signal.aborted
    ) {
      return;
    }
    entry.sequence += 1;
    entry.reconnectAttempt = 0;
    entry.state = "streaming";
    entry.latestFrame = {
      instanceId,
      generation: entry.generation,
      sequence: entry.sequence,
      encoding: "h264",
      receivedAt: frame.receivedAt,
      bytes: frame.bytes.slice(),
      format: frame.format,
      width: frame.width,
      height: frame.height,
      orientation: frame.orientation,
      scale: frame.scale,
      colorSpace: frame.colorSpace,
      timestampMicros: frame.timestampMicros,
      keyFrame: frame.keyFrame,
    };
    this.#onFrame?.(entry.latestFrame);
  }
}
