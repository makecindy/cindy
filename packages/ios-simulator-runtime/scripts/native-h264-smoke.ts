import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createIOSSimulatorNativeSidecarSandboxPolicy,
  IOSSimulatorNativeSidecarProcessManager,
  type IOSSimulatorH264Frame,
  type IOSSimulatorStreamStats,
} from "../src/index.js";
import { validateIOSimulatorNativeFrame } from "../src/native-sidecar/frame-validation.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const maxFrameBytes = 16 * 1024 * 1024 - 64 * 1024 - 4;

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const simulatorUdid = argument("--simulator-udid");
if (
  !simulatorUdid ||
  !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorUdid)
) {
  throw new Error(
    "Usage: pnpm native:h264-smoke -- --simulator-udid <exact-booted-UDID>",
  );
}
const framesPerSecond = positiveIntegerArgument("--fps", 5);
const maxFrames = positiveIntegerArgument("--frames", 30);
const scalingPercent = positiveIntegerArgument("--scaling", 50);
const productMode = hasFlag("--product");
const maxFramesPerSecond = productMode ? 60 : 30;
if (
  framesPerSecond > maxFramesPerSecond ||
  maxFrames > 900 ||
  scalingPercent > 100
) {
  throw new Error(
    `--fps must be <= ${maxFramesPerSecond}, --frames must be <= 900, and --scaling must be <= 100`,
  );
}

const requestedArchitecture = process.env.CINDY_IOS_SIDECAR_ARCH;
const architecture =
  requestedArchitecture === "x86_64" || requestedArchitecture === "arm64"
    ? requestedArchitecture
    : process.arch === "x64"
      ? "x86_64"
      : "arm64";
const binaryPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "native",
  architecture,
  "ios-simulator-sidecar",
);
const manager = new IOSSimulatorNativeSidecarProcessManager({
  binaryPath,
  enableH264Stream: productMode,
  sandboxPolicy: createIOSSimulatorNativeSidecarSandboxPolicy({
    required: true,
    platform: process.platform,
  }),
});

interface ProcessSample {
  rssBytes: number;
  cpuPercent: number;
}

async function sampleSidecarProcess(): Promise<ProcessSample | null> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "rss=,%cpu=,command="],
    { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
  );
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+([\d.]+)\s+(.+)$/);
    if (
      match?.[3]?.includes("ios-simulator-sidecar") &&
      match[3].includes(simulatorUdid)
    ) {
      return {
        rssBytes: Number(match[1]) * 1024,
        cpuPercent: Number(match[2]),
      };
    }
  }
  return null;
}

function annexBNalTypes(bytes: Uint8Array): number[] {
  const starts: Array<{ offset: number; length: number }> = [];
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 1
    ) {
      starts.push({ offset: index, length: 3 });
      index += 2;
      continue;
    }
    if (
      index + 4 < bytes.byteLength &&
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 &&
      bytes[index + 3] === 1
    ) {
      starts.push({ offset: index, length: 4 });
      index += 3;
    }
  }
  return starts.map(({ offset, length }) => {
    const header = bytes[offset + length];
    if (header === undefined) {
      throw new Error("Annex-B start code is missing its NAL header");
    }
    return header & 0x1f;
  });
}

try {
  const running = await manager.start({
    instanceId: "native-h264-smoke",
    simulatorUdid,
    generation: 1,
  });
  if (running.handshake.capabilities.bgraStream) {
    throw new Error(
      "Native sidecar must not advertise raw BGRA product streaming",
    );
  }
  if (running.handshake.capabilities.h264Stream !== productMode) {
    throw new Error(
      productMode
        ? "Opt-in sidecar did not advertise H.264 product streaming"
        : "Correctness build must not advertise H.264 product streaming",
    );
  }

  const framebuffer = await running.adapter.captureNativeFrame({
    maxFrameBytes,
  });
  validateIOSimulatorNativeFrame(framebuffer, { maxFrameBytes });

  const expectedWidth = productMode
    ? Math.max(
        2,
        Math.floor(Math.floor((framebuffer.width * scalingPercent) / 100) / 2) *
          2,
      )
    : framebuffer.width;
  const expectedHeight = productMode
    ? Math.max(
        2,
        Math.floor(
          Math.floor((framebuffer.height * scalingPercent) / 100) / 2,
        ) * 2,
      )
    : framebuffer.height;
  if (productMode) {
    await running.adapter.configureNativeStream({
      encoding: "h264",
      framesPerSecond,
      scalingPercent,
    });
  }

  const streamH264Frames = (options: {
    framesPerSecond: number;
    maxFrames: number;
    signal?: AbortSignal;
    onFrame(frame: IOSSimulatorH264Frame): void | Promise<void>;
  }): Promise<IOSSimulatorStreamStats> => {
    if (!productMode) {
      return running.adapter.streamNativeH264CorrectnessFrames({
        ...options,
        maxFrameBytes,
      });
    }
    return running.adapter.streamNativeFrames({
      signal: options.signal,
      maxFrames: options.maxFrames,
      maxFrameBytes,
      async onFrame(frame) {
        if (frame.encoding !== "h264") {
          throw new Error(
            `Expected H.264 product frame, received ${frame.encoding}`,
          );
        }
        await options.onFrame(frame);
      },
    });
  };

  const processSamples: ProcessSample[] = [];
  const collectSample = async () => {
    const sample = await sampleSidecarProcess();
    if (sample) processSamples.push(sample);
  };
  await collectSample();
  const sampleTimer = setInterval(() => {
    void collectSample();
  }, 250);

  let observedFrames = 0;
  let previousTimestamp = -1;
  let firstNalTypes: number[] = [];
  let keyFrameCount = 0;
  const streamStartedAt = performance.now();
  let streamStats: IOSSimulatorStreamStats;
  try {
    streamStats = await streamH264Frames({
      framesPerSecond,
      maxFrames,
      onFrame(frame) {
        validateIOSimulatorNativeFrame(frame, { maxFrameBytes });
        if (frame.format !== "annex-b") {
          throw new Error(`Expected Annex-B, received ${frame.format}`);
        }
        if (frame.sequence !== observedFrames) {
          throw new Error(
            `Expected sequence ${observedFrames}, received ${String(frame.sequence)}`,
          );
        }
        if (frame.timestampMicros <= previousTimestamp) {
          throw new Error("H.264 timestamps are not strictly monotonic");
        }
        if (frame.width !== expectedWidth || frame.height !== expectedHeight) {
          throw new Error(
            `H.264 dimensions ${frame.width}x${frame.height} do not match expected ${expectedWidth}x${expectedHeight}`,
          );
        }
        const nalTypes = annexBNalTypes(frame.bytes);
        if (observedFrames === 0) {
          firstNalTypes = nalTypes;
          if (
            !frame.keyFrame ||
            !nalTypes.includes(7) ||
            !nalTypes.includes(8) ||
            !nalTypes.includes(5)
          ) {
            throw new Error(
              `First access unit is not independently decodable: ${nalTypes.join(",")}`,
            );
          }
        }
        if (frame.keyFrame) keyFrameCount += 1;
        previousTimestamp = frame.timestampMicros;
        observedFrames += 1;
      },
    });
  } finally {
    clearInterval(sampleTimer);
    await collectSample();
  }
  const durationMs = performance.now() - streamStartedAt;
  if (
    streamStats.frameCount !== maxFrames ||
    observedFrames !== maxFrames ||
    streamStats.endReason !== "max-frames"
  ) {
    throw new Error(
      `H.264 stream ended unexpectedly: ${JSON.stringify(streamStats)}`,
    );
  }
  const minimumPacedDurationMs =
    ((maxFrames - 1) / framesPerSecond) * 1_000 * 0.8;
  if (durationMs < minimumPacedDurationMs) {
    throw new Error("H.264 correctness stream did not respect its FPS bound");
  }

  const stopController = new AbortController();
  let stopFrameCount = 0;
  const stopFramesPerSecond = Math.min(framesPerSecond, 5);
  if (productMode) {
    await running.adapter.configureNativeStream({
      encoding: "h264",
      framesPerSecond: stopFramesPerSecond,
      scalingPercent,
    });
  }
  const stoppedStats = await streamH264Frames({
    framesPerSecond: stopFramesPerSecond,
    maxFrames: 900,
    signal: stopController.signal,
    onFrame(frame) {
      validateIOSimulatorNativeFrame(frame, { maxFrameBytes });
      stopFrameCount += 1;
      if (stopFrameCount === 3) stopController.abort();
    },
  });
  if (stoppedStats.endReason !== "aborted" || stopFrameCount !== 3) {
    throw new Error(
      `H.264 cancellation failed: ${JSON.stringify(stoppedStats)}`,
    );
  }

  const theoreticalBgraBytes = framebuffer.bytes.byteLength * maxFrames;
  const peakRssBytes = processSamples.reduce(
    (peak, sample) => Math.max(peak, sample.rssBytes),
    0,
  );
  const peakCpuPercent = processSamples.reduce(
    (peak, sample) => Math.max(peak, sample.cpuPercent),
    0,
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      mode: productMode ? "product" : "correctness",
      simulatorUdid,
      architecture,
      capabilities: running.handshake.capabilities,
      framebuffer: {
        width: framebuffer.width,
        height: framebuffer.height,
        bytesPerRow: framebuffer.bytesPerRow,
        byteCount: framebuffer.bytes.byteLength,
      },
      h264: {
        framesPerSecond,
        scalingPercent: productMode ? scalingPercent : 100,
        width: expectedWidth,
        height: expectedHeight,
        maxFrames,
        observedFrames,
        keyFrameCount,
        firstNalTypes,
        byteCount: streamStats.byteCount,
        theoreticalBgraBytes,
        compressionRatio: Number(
          (theoreticalBgraBytes / streamStats.byteCount).toFixed(2),
        ),
        durationMs: Math.round(durationMs),
        throughputBytesPerSecond: Math.round(
          streamStats.byteCount / (durationMs / 1_000),
        ),
        peakRssBytes,
        peakCpuPercent,
      },
      stopCheck: {
        frameCount: stopFrameCount,
        endReason: stoppedStats.endReason,
      },
    })}\n`,
  );
} finally {
  await manager.stop("native-h264-smoke").catch(() => undefined);
}
