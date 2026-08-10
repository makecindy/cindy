import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  IOSSimulatorNativeSidecarProcessManager,
  type IOSSimulatorStreamStats,
} from "../src/index.js";
import { validateIOSimulatorNativeFrame } from "../src/native-sidecar/frame-validation.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const udidArgument = process.argv.indexOf("--simulator-udid");
const simulatorUdid =
  udidArgument >= 0 ? process.argv[udidArgument + 1]?.trim() : undefined;
if (
  !simulatorUdid ||
  !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorUdid)
) {
  throw new Error(
    "Usage: pnpm native:framebuffer-smoke -- --simulator-udid <exact-booted-UDID>",
  );
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeIntegerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

const framesPerSecond = positiveIntegerArgument("--fps", 5);
const maxFrames = positiveIntegerArgument("--frames", 150);
const consumerDelayMs = nonNegativeIntegerArgument("--consumer-delay-ms", 0);
const maxFrameBytes = 16 * 1024 * 1024 - 64 * 1024 - 4;
if (framesPerSecond > 15 || maxFrames > 900) {
  throw new Error("--fps must be <= 15 and --frames must be <= 900");
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
const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "cindy-native-framebuffer-smoke-"),
);
const manager = new IOSSimulatorNativeSidecarProcessManager({ binaryPath });

interface ProcessSample {
  pid: number;
  rssBytes: number;
  cpuPercent: number;
}

async function sampleSidecarProcess(): Promise<ProcessSample | null> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,rss=,%cpu=,command="],
    { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
  );
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (
      !match ||
      !match[4]!.includes("ios-simulator-sidecar") ||
      !match[4]!.includes(simulatorUdid)
    ) {
      continue;
    }
    return {
      pid: Number(match[1]),
      rssBytes: Number(match[2]) * 1024,
      cpuPercent: Number(match[3]),
    };
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const running = await manager.start({
    instanceId: "native-framebuffer-smoke",
    simulatorUdid,
    generation: 1,
  });
  if (
    running.handshake.capabilities.bgraStream ||
    running.handshake.capabilities.h264Stream
  ) {
    throw new Error(
      "Single-frame correctness build must not advertise continuous stream capability",
    );
  }
  const frame = await running.adapter.captureNativeFrame({
    maxFrameBytes,
  });
  validateIOSimulatorNativeFrame(frame);

  const screenshotPath = path.join(tempRoot, "simctl.png");
  await execFileAsync(
    "/usr/bin/xcrun",
    ["simctl", "io", simulatorUdid, "screenshot", "--type=png", screenshotPath],
    { maxBuffer: 1024 * 1024, timeout: 30_000 },
  );
  const screenshot = await readFile(screenshotPath);
  if (
    screenshot.byteLength < 24 ||
    screenshot.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error("simctl screenshot did not produce a valid PNG");
  }
  const screenshotWidth = screenshot.readUInt32BE(16);
  const screenshotHeight = screenshot.readUInt32BE(20);
  const dimensionsMatch =
    frame.width === screenshotWidth && frame.height === screenshotHeight;
  if (!dimensionsMatch) {
    throw new Error(
      `Framebuffer ${frame.width}x${frame.height} does not match simctl screenshot ${screenshotWidth}x${screenshotHeight}`,
    );
  }

  const processSamples: ProcessSample[] = [];
  const collectSample = async () => {
    const sample = await sampleSidecarProcess();
    if (sample) processSamples.push(sample);
  };
  await collectSample();
  const sampleTimer = setInterval(() => {
    void collectSample();
  }, 250);
  const dimensions = new Set<string>();
  let dimensionTransitions = 0;
  let previousDimension: string | null = null;
  let previousTimestamp = -1;
  let observedFrames = 0;
  const streamStartedAt = performance.now();
  let streamStats: IOSSimulatorStreamStats;
  try {
    streamStats = await running.adapter.streamNativeBgraCorrectnessFrames({
      framesPerSecond,
      maxFrames,
      maxFrameBytes,
      async onFrame(nextFrame) {
        validateIOSimulatorNativeFrame(nextFrame, { maxFrameBytes });
        if (nextFrame.sequence !== observedFrames) {
          throw new Error(
            `Expected frame sequence ${observedFrames}, received ${String(nextFrame.sequence)}`,
          );
        }
        if (nextFrame.timestampMicros <= previousTimestamp) {
          throw new Error("Framebuffer timestamps are not strictly monotonic");
        }
        const dimension =
          `${nextFrame.width}x${nextFrame.height}:` +
          `${nextFrame.bytesPerRow}:${nextFrame.bytes.byteLength}`;
        dimensions.add(dimension);
        if (previousDimension !== null && previousDimension !== dimension) {
          dimensionTransitions += 1;
        }
        previousDimension = dimension;
        previousTimestamp = nextFrame.timestampMicros;
        observedFrames += 1;
        if (consumerDelayMs > 0) await delay(consumerDelayMs);
      },
    });
  } finally {
    clearInterval(sampleTimer);
    await collectSample();
  }
  const streamDurationMs = performance.now() - streamStartedAt;
  if (
    streamStats.frameCount !== maxFrames ||
    observedFrames !== maxFrames ||
    streamStats.endReason !== "max-frames"
  ) {
    throw new Error(
      `Bounded stream ended unexpectedly: ${JSON.stringify(streamStats)}`,
    );
  }
  const minimumPacedDurationMs =
    ((maxFrames - 1) / framesPerSecond) * 1_000 * 0.8;
  if (streamDurationMs < minimumPacedDurationMs) {
    throw new Error("Correctness stream did not respect its FPS bound");
  }
  if (
    consumerDelayMs > 1_000 / framesPerSecond &&
    streamDurationMs < consumerDelayMs * maxFrames * 0.8
  ) {
    throw new Error("Correctness stream did not apply consumer backpressure");
  }

  const stopController = new AbortController();
  let stopFrameCount = 0;
  const stoppedStats = await running.adapter.streamNativeBgraCorrectnessFrames({
    framesPerSecond: Math.min(framesPerSecond, 5),
    maxFrames: 900,
    maxFrameBytes,
    signal: stopController.signal,
    onFrame() {
      stopFrameCount += 1;
      if (stopFrameCount === 3) stopController.abort();
    },
  });
  if (stoppedStats.endReason !== "aborted" || stopFrameCount !== 3) {
    throw new Error(
      `Correctness stream cancellation failed: ${JSON.stringify(stoppedStats)}`,
    );
  }

  const diagnostics = manager.diagnostics("native-framebuffer-smoke");
  const peakRssBytes = processSamples.reduce(
    (peak, sample) => Math.max(peak, sample.rssBytes),
    0,
  );
  const peakCpuPercent = processSamples.reduce(
    (peak, sample) => Math.max(peak, sample.cpuPercent),
    0,
  );
  const firstRssBytes = processSamples[0]?.rssBytes ?? 0;
  const lastRssBytes = processSamples.at(-1)?.rssBytes ?? 0;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      simulatorUdid,
      framebuffer: {
        width: frame.width,
        height: frame.height,
        bytesPerRow: frame.bytesPerRow,
        byteCount: frame.bytes.byteLength,
        encoding: frame.encoding,
        orientation: frame.orientation,
        colorSpace: frame.colorSpace,
      },
      screenshot: {
        width: screenshotWidth,
        height: screenshotHeight,
        dimensionsMatch,
      },
      capabilities: running.handshake.capabilities,
      probe: diagnostics.probe,
      correctnessStream: {
        framesPerSecond,
        maxFrames,
        consumerDelayMs,
        observedFrames,
        byteCount: streamStats.byteCount,
        durationMs: Math.round(streamDurationMs),
        throughputBytesPerSecond: Math.round(
          streamStats.byteCount / (streamDurationMs / 1_000),
        ),
        dimensions: [...dimensions],
        dimensionTransitions,
        processSamples: processSamples.length,
        firstRssBytes,
        lastRssBytes,
        rssDeltaBytes: lastRssBytes - firstRssBytes,
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
  await manager.stop("native-framebuffer-smoke").catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
