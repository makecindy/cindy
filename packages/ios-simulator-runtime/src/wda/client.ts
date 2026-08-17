import type {
  IOSSimulatorAccessibilitySnapshot,
  IOSSimulatorAutomationDriver,
  IOSSimulatorDriverHealth,
  IOSSimulatorDriverSession,
  IOSSimulatorOrientation,
  IOSSimulatorPoint,
  IOSSimulatorStreamProfile,
  IOSSimulatorStreamStats,
  IOSSimulatorWindowSize,
} from "../driver.js";
import { IOS_SIMULATOR_WDA_CAPABILITIES } from "../driver.js";
import { WdaError } from "./errors.js";
import { MjpegFrameParser, parseMjpegBoundary } from "./mjpeg-parser.js";

const DEFAULT_CONTROL_URL = "http://127.0.0.1:8100";
const DEFAULT_MJPEG_URL = "http://127.0.0.1:9100";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

type Fetch = typeof globalThis.fetch;

interface WdaEnvelope {
  value?: unknown;
  sessionId?: unknown;
  status?: unknown;
}

export interface WdaClientOptions {
  controlUrl?: string;
  mjpegUrl?: string;
  timeoutMs?: number;
  maxJsonBytes?: number;
  fetch?: Fetch;
}

function requirePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      `${label} must be a positive integer`,
    );
  }
  return resolved;
}

function requireLoopbackUrl(rawUrl: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WdaError("INVALID_CONFIGURATION", `${label} must be a valid URL`);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname.toLowerCase()) ||
    url.username ||
    url.password
  ) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      `${label} must be an unauthenticated loopback HTTP URL`,
    );
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function requireSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(normalized)) {
    throw new WdaError("INVALID_CONFIGURATION", "WDA session id is invalid");
  }
  return normalized;
}

function joinUrl(base: URL, path: string): URL {
  const url = new URL(base);
  const queryIndex = path.indexOf("?");
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : path.slice(queryIndex + 1);
  url.pathname = `${base.pathname}/${pathname.replace(/^\/+/, "")}`.replace(
    /\/{2,}/g,
    "/",
  );
  url.search = query;
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  stopTimeout(): void;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("WDA request timed out")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    stopTimeout() {
      clearTimeout(timer);
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

function requirePoint(
  point: IOSSimulatorPoint,
  label: string,
): IOSSimulatorPoint {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x > 1_000_000 ||
    point.y > 1_000_000
  ) {
    throw new WdaError(
      "INVALID_CONFIGURATION",
      `${label} must contain bounded non-negative coordinates`,
    );
  }
  return { x: point.x, y: point.y };
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new WdaError(
      "RESPONSE_TOO_LARGE",
      "WDA response exceeds the configured limit",
    );
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new WdaError(
          "RESPONSE_TOO_LARGE",
          "WDA response exceeds the configured limit",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function unwrapEnvelope(envelope: WdaEnvelope, statusCode: number): unknown {
  if (isRecord(envelope.value) && typeof envelope.value.error === "string") {
    const message =
      stringOrNull(envelope.value.message) ?? envelope.value.error;
    throw new WdaError(
      "PROTOCOL_ERROR",
      `WDA ${envelope.value.error}: ${message}`,
      statusCode,
    );
  }
  return envelope.value;
}

/** Loopback-only WebDriverAgent adapter implementing Cindy's host-neutral driver contract. */
export class WdaClient implements IOSSimulatorAutomationDriver {
  readonly kind = "wda" as const;
  readonly capabilities = IOS_SIMULATOR_WDA_CAPABILITIES;
  readonly #controlUrl: URL;
  readonly #mjpegUrl: URL;
  readonly #timeoutMs: number;
  readonly #maxJsonBytes: number;
  readonly #fetch: Fetch;

  constructor(options: WdaClientOptions = {}) {
    this.#controlUrl = requireLoopbackUrl(
      options.controlUrl ?? DEFAULT_CONTROL_URL,
      "controlUrl",
    );
    this.#mjpegUrl = requireLoopbackUrl(
      options.mjpegUrl ?? DEFAULT_MJPEG_URL,
      "mjpegUrl",
    );
    this.#timeoutMs = requirePositiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.#maxJsonBytes = requirePositiveInteger(
      options.maxJsonBytes,
      DEFAULT_MAX_JSON_BYTES,
      "maxJsonBytes",
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#fetch) {
      throw new WdaError(
        "INVALID_CONFIGURATION",
        "A fetch implementation is required",
      );
    }
  }

  async #request(
    path: string,
    init: RequestInit = {},
    parentSignal?: AbortSignal,
  ): Promise<WdaEnvelope> {
    const request = createRequestSignal(parentSignal, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(joinUrl(this.#controlUrl, path), {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...init.headers,
        },
        signal: request.signal,
      });
    } catch (error) {
      request.dispose();
      if (error instanceof WdaError) throw error;
      throw new WdaError(
        "UNREACHABLE",
        `Unable to reach WDA: ${errorMessage(error)}`,
      );
    }

    try {
      const bytes = await readBoundedBytes(response, this.#maxJsonBytes);
      let parsed: unknown = {};
      if (bytes.length > 0) {
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new WdaError(
            "PROTOCOL_ERROR",
            "WDA returned invalid JSON",
            response.status,
          );
        }
      }
      if (!isRecord(parsed)) {
        throw new WdaError(
          "PROTOCOL_ERROR",
          "WDA returned a non-object response",
          response.status,
        );
      }
      const envelope = parsed as WdaEnvelope;
      if (!response.ok) {
        try {
          unwrapEnvelope(envelope, response.status);
        } catch (error) {
          if (error instanceof WdaError) throw error;
        }
        throw new WdaError(
          "HTTP_ERROR",
          `WDA returned HTTP ${response.status}`,
          response.status,
        );
      }
      unwrapEnvelope(envelope, response.status);
      return envelope;
    } finally {
      request.dispose();
    }
  }

  async probe(signal?: AbortSignal): Promise<IOSSimulatorDriverHealth> {
    const envelope = await this.#request("/status", {}, signal);
    const value = isRecord(envelope.value) ? envelope.value : {};
    const os = isRecord(value.os) ? value.os : {};
    const build = isRecord(value.build) ? value.build : {};
    const ios = isRecord(value.ios) ? value.ios : {};
    return {
      ready: value.ready === true,
      message: stringOrNull(value.message),
      osName: stringOrNull(os.name),
      osVersion: stringOrNull(os.version),
      sdkVersion:
        stringOrNull(os.sdkVersion) ??
        stringOrNull(build.sdkVersion) ??
        stringOrNull(value.sdkVersion),
      deviceIp: stringOrNull(ios.ip),
    };
  }

  async createSession(
    signal?: AbortSignal,
  ): Promise<IOSSimulatorDriverSession> {
    const envelope = await this.#request(
      "/session",
      {
        method: "POST",
        body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
      },
      signal,
    );
    const value = isRecord(envelope.value) ? envelope.value : {};
    const sessionId =
      stringOrNull(value.sessionId) ?? stringOrNull(envelope.sessionId);
    if (!sessionId)
      throw new WdaError("PROTOCOL_ERROR", "WDA did not return a session id");
    const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
    return { id: sessionId, capabilities, createdAt: new Date().toISOString() };
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.#request(
      `/session/${requireSessionId(sessionId)}`,
      { method: "DELETE" },
      signal,
    );
  }

  async getAccessibilityTree(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorAccessibilitySnapshot> {
    const prefix = sessionId ? `/session/${requireSessionId(sessionId)}` : "";
    const envelope = await this.#request(
      `${prefix}/source?format=json`,
      {},
      signal,
    );
    return { capturedAt: new Date().toISOString(), tree: envelope.value };
  }

  async configureStream(
    sessionId: string,
    profile: IOSSimulatorStreamProfile,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorStreamProfile> {
    const framesPerSecond = requirePositiveInteger(
      profile.framesPerSecond,
      0,
      "framesPerSecond",
    );
    const jpegQuality = requirePositiveInteger(
      profile.jpegQuality,
      0,
      "jpegQuality",
    );
    const scalingPercent = requirePositiveInteger(
      profile.scalingPercent,
      0,
      "scalingPercent",
    );
    if (framesPerSecond > 60 || jpegQuality > 100 || scalingPercent > 100) {
      throw new WdaError(
        "INVALID_CONFIGURATION",
        "Stream profile values exceed WDA limits",
      );
    }
    await this.#request(
      `/session/${requireSessionId(sessionId)}/appium/settings`,
      {
        method: "POST",
        body: JSON.stringify({
          settings: {
            mjpegServerFramerate: framesPerSecond,
            mjpegServerScreenshotQuality: jpegQuality,
            mjpegScalingFactor: scalingPercent,
          },
        }),
      },
      signal,
    );
    return { framesPerSecond, jpegQuality, scalingPercent };
  }

  async #performActions(
    sessionId: string,
    actions: unknown[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request(
      `/session/${requireSessionId(sessionId)}/actions`,
      {
        method: "POST",
        body: JSON.stringify({
          actions: [
            {
              type: "pointer",
              id: "finger",
              parameters: { pointerType: "touch" },
              actions,
            },
          ],
        }),
      },
      signal,
    );
  }

  async tap(
    sessionId: string,
    point: IOSSimulatorPoint,
    signal?: AbortSignal,
  ): Promise<void> {
    const target = requirePoint(point, "point");
    await this.#performActions(
      sessionId,
      [
        {
          type: "pointerMove",
          duration: 0,
          origin: "viewport",
          x: target.x,
          y: target.y,
        },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 50 },
        { type: "pointerUp", button: 0 },
      ],
      signal,
    );
  }

  async swipe(
    sessionId: string,
    start: IOSSimulatorPoint,
    end: IOSSimulatorPoint,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const duration = requirePositiveInteger(durationMs, 0, "durationMs");
    if (duration > 60_000) {
      throw new WdaError(
        "INVALID_CONFIGURATION",
        "durationMs exceeds the gesture limit",
      );
    }
    const startPoint = requirePoint(start, "start");
    const endPoint = requirePoint(end, "end");
    await this.#performActions(
      sessionId,
      [
        {
          type: "pointerMove",
          duration: 0,
          origin: "viewport",
          x: startPoint.x,
          y: startPoint.y,
        },
        { type: "pointerDown", button: 0 },
        { type: "pause", duration: 50 },
        {
          type: "pointerMove",
          duration,
          origin: "viewport",
          x: endPoint.x,
          y: endPoint.y,
        },
        { type: "pointerUp", button: 0 },
      ],
      signal,
    );
  }

  async typeText(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (text.length > 10_000) {
      throw new WdaError(
        "INVALID_CONFIGURATION",
        "text exceeds the WDA input limit",
      );
    }
    await this.#request(
      `/session/${requireSessionId(sessionId)}/wda/keys`,
      { method: "POST", body: JSON.stringify({ value: Array.from(text) }) },
      signal,
    );
  }

  async home(signal?: AbortSignal): Promise<void> {
    await this.#request(
      "/wda/homescreen",
      { method: "POST", body: "{}" },
      signal,
    );
  }

  async lock(sessionId?: string, signal?: AbortSignal): Promise<void> {
    const prefix = sessionId ? `/session/${requireSessionId(sessionId)}` : "";
    await this.#request(
      `${prefix}/wda/lock`,
      { method: "POST", body: "{}" },
      signal,
    );
  }

  async unlock(sessionId?: string, signal?: AbortSignal): Promise<void> {
    const prefix = sessionId ? `/session/${requireSessionId(sessionId)}` : "";
    await this.#request(
      `${prefix}/wda/unlock`,
      { method: "POST", body: "{}" },
      signal,
    );
  }

  async getWindowSize(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorWindowSize> {
    const prefix = sessionId ? `/session/${requireSessionId(sessionId)}` : "";
    const envelope = await this.#request(`${prefix}/window/size`, {}, signal);
    const value = isRecord(envelope.value) ? envelope.value : {};
    const width = value.width;
    const height = value.height;
    if (
      typeof width !== "number" ||
      !Number.isFinite(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isFinite(height) ||
      height <= 0
    ) {
      throw new WdaError(
        "PROTOCOL_ERROR",
        "WDA returned an invalid window size",
      );
    }
    return { width, height };
  }

  async getOrientation(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorOrientation> {
    const prefix = sessionId ? `/session/${requireSessionId(sessionId)}` : "";
    const envelope = await this.#request(`${prefix}/orientation`, {}, signal);
    if (envelope.value !== "PORTRAIT" && envelope.value !== "LANDSCAPE") {
      throw new WdaError(
        "PROTOCOL_ERROR",
        "WDA returned an unsupported orientation",
      );
    }
    return envelope.value;
  }

  async setOrientation(
    orientation: IOSSimulatorOrientation,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (orientation !== "PORTRAIT" && orientation !== "LANDSCAPE") {
      throw new WdaError(
        "INVALID_CONFIGURATION",
        "orientation must be PORTRAIT or LANDSCAPE",
      );
    }
    const prefix = sessionId ? `/session/${requireSessionId(sessionId)}` : "";
    try {
      await this.#request(
        `${prefix}/orientation`,
        { method: "POST", body: JSON.stringify({ orientation }) },
        signal,
      );
    } catch (error) {
      // WDA reports an app-level orientation restriction as a generic W3C
      // "unknown error". Normalize that command-specific response here so the
      // host does not mistake a healthy driver for an unavailable one.
      if (
        error instanceof WdaError &&
        error.code === "PROTOCOL_ERROR" &&
        /\bUnable To Rotate Device\b/i.test(error.message)
      ) {
        throw new WdaError(
          "ORIENTATION_UNSUPPORTED",
          "The foreground app does not support the requested orientation.",
          error.statusCode,
        );
      }
      throw error;
    }
  }

  async streamFrames(options: {
    signal?: AbortSignal;
    maxFrames?: number;
    maxFrameBytes?: number;
    onFrame(frame: {
      bytes: Uint8Array;
      receivedAt: string;
    }): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats> {
    const maxFrames =
      options.maxFrames === undefined
        ? Number.POSITIVE_INFINITY
        : requirePositiveInteger(options.maxFrames, 0, "maxFrames");
    const maxFrameBytes = requirePositiveInteger(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    const startedAt = new Date().toISOString();
    const request = createRequestSignal(options.signal, this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#mjpegUrl, { signal: request.signal });
      request.stopTimeout();
    } catch (error) {
      request.dispose();
      throw new WdaError(
        "UNREACHABLE",
        `Unable to reach WDA MJPEG server: ${errorMessage(error)}`,
      );
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      request.dispose();
      throw new WdaError(
        "HTTP_ERROR",
        `WDA MJPEG server returned HTTP ${response.status}`,
        response.status,
      );
    }

    let parser: MjpegFrameParser;
    try {
      parser = new MjpegFrameParser({
        boundary: parseMjpegBoundary(response.headers.get("content-type")),
        maxFrameBytes,
      });
    } catch (error) {
      await response.body.cancel();
      request.dispose();
      throw error;
    }
    const reader = response.body.getReader();
    let frameCount = 0;
    let byteCount = 0;
    let firstFrameAt: string | null = null;
    let endReason: IOSSimulatorStreamStats["endReason"] = "eof";
    try {
      while (frameCount < maxFrames) {
        const result = await reader.read();
        if (result.done) {
          parser.finish();
          break;
        }
        for (const bytes of parser.push(result.value)) {
          const receivedAt = new Date().toISOString();
          firstFrameAt ??= receivedAt;
          frameCount += 1;
          byteCount += bytes.length;
          await options.onFrame({ bytes, receivedAt });
          if (frameCount >= maxFrames) break;
        }
      }
      if (frameCount >= maxFrames) {
        endReason = "max-frames";
        await reader.cancel();
      }
    } catch (error) {
      if (options.signal?.aborted) {
        endReason = "aborted";
        // Caller-owned cancellation is a normal stream boundary. Preserve the
        // collected stats so visibility changes and bounded probes can stop cleanly.
      } else if (error instanceof WdaError) {
        throw error;
      } else {
        throw new WdaError(
          "STREAM_ERROR",
          `WDA MJPEG stream failed: ${errorMessage(error)}`,
        );
      }
    } finally {
      reader.releaseLock();
      request.dispose();
    }

    return {
      frameCount,
      byteCount,
      startedAt,
      firstFrameAt,
      endedAt: new Date().toISOString(),
      endReason,
    };
  }
}
