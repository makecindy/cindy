import "tsx/esm";

import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow } from "electron";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const maxFrameBytes = 16 * 1024 * 1024 - 64 * 1024 - 4;

function reportStage(stage) {
  process.stderr.write(`[native-h264-webcodecs-smoke] ${stage}\n`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function positiveIntegerArgument(name, fallback) {
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
    "Usage: pnpm native:h264-webcodecs-smoke -- --simulator-udid <exact-booted-UDID>",
  );
}
const framesPerSecond = positiveIntegerArgument("--fps", 5);
const maxFrames = positiveIntegerArgument("--frames", 5);
const scalingPercent = positiveIntegerArgument("--scaling", 50);
if (framesPerSecond > 60 || maxFrames > 60 || scalingPercent > 100) {
  throw new Error(
    "--fps and --frames must be <= 60, and --scaling must be <= 100",
  );
}

const requestedArchitecture = process.env.CINDY_IOS_SIDECAR_ARCH;
const architecture =
  requestedArchitecture === "x86_64" || requestedArchitecture === "arm64"
    ? requestedArchitecture
    : os.arch() === "x64"
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

const { IOSSimulatorNativeSidecarProcessManager } =
  await import("../src/native-sidecar/process-manager.ts");

function readStartCode(bytes, offset) {
  if (
    offset + 3 > bytes.byteLength ||
    bytes[offset] !== 0 ||
    bytes[offset + 1] !== 0
  ) {
    return 0;
  }
  if (bytes[offset + 2] === 1) return 3;
  return bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
}

function splitAnnexBNalUnits(bytes) {
  const units = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const prefixLength = readStartCode(bytes, offset);
    if (prefixLength === 0) {
      offset += 1;
      continue;
    }
    const start = offset + prefixLength;
    let end = start;
    while (end < bytes.byteLength && readStartCode(bytes, end) === 0) {
      end += 1;
    }
    if (end > start) units.push(bytes.subarray(start, end));
    offset = end;
  }
  return units;
}

function codecFromAnnexB(bytes) {
  const sequenceParameterSet = splitAnnexBNalUnits(bytes).find(
    (unit) => (unit[0] & 0x1f) === 7,
  );
  if (!sequenceParameterSet || sequenceParameterSet.byteLength < 4) return null;
  return `avc1.${Array.from(sequenceParameterSet.subarray(1, 4), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

/**
 * Creates an isolated Chromium context for the real WebCodecs gate. It has no
 * preload, Node access, remote content, persistence, or visible window.
 */
async function createDecoderWindow() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
    },
  });
  await window.loadURL(
    pathToFileURL(
      path.join(packageRoot, "scripts", "native-h264-webcodecs-smoke.html"),
    ).href,
  );
  const initialized = await window.webContents.executeJavaScript(`
    (() => {
      if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") {
        return false;
      }
      const state = {
        decoder: null,
        codec: null,
        width: 0,
        height: 0,
        decodedFrames: 0,
        lastFrame: null,
        errorMessage: null,
      };
      globalThis.__cindyH264Smoke = state;
      globalThis.__cindyDecodeH264 = async (input) => {
        if (
          !state.decoder ||
          state.codec !== input.codec ||
          state.width !== input.width ||
          state.height !== input.height
        ) {
          state.decoder?.close();
          const config = {
            codec: input.codec,
            codedWidth: input.width,
            codedHeight: input.height,
            optimizeForLatency: true,
            hardwareAcceleration: "prefer-hardware",
          };
          const support = await VideoDecoder.isConfigSupported(config);
          if (support.supported !== true) {
            throw new Error("Electron WebCodecs rejected the H.264 configuration");
          }
          state.decoder = new VideoDecoder({
            output(frame) {
              state.decodedFrames += 1;
              state.lastFrame = {
                codedWidth: frame.codedWidth,
                codedHeight: frame.codedHeight,
                timestamp: frame.timestamp,
              };
              frame.close();
            },
            error(error) {
              state.errorMessage = error?.message || "WebCodecs decoder error";
            },
          });
          state.decoder.configure(config);
          state.codec = input.codec;
          state.width = input.width;
          state.height = input.height;
        }
        if (state.errorMessage) throw new Error(state.errorMessage);
        state.decoder.decode(new EncodedVideoChunk({
          type: input.keyFrame ? "key" : "delta",
          timestamp: input.timestampMicros,
          data: new Uint8Array(input.bytes),
        }));
        return { queued: true };
      };
      globalThis.__cindyFlushH264 = async () => {
        let timeoutId;
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("Electron WebCodecs did not flush within 5 seconds"));
          }, 5000);
        });
        try {
          await Promise.race([state.decoder?.flush() ?? Promise.resolve(), timeout]);
        } finally {
          clearTimeout(timeoutId);
        }
        if (state.errorMessage) throw new Error(state.errorMessage);
        return {
          decodedFrames: state.decodedFrames,
          lastFrame: state.lastFrame,
        };
      };
      globalThis.__cindyCloseH264 = () => {
        state.decoder?.close();
        state.decoder = null;
      };
      return true;
    })()
  `);
  if (initialized !== true) {
    window.destroy();
    throw new Error("Electron Renderer does not expose WebCodecs");
  }
  return window;
}

const manager = new IOSSimulatorNativeSidecarProcessManager({
  binaryPath,
  enableH264Stream: true,
});
async function runSmoke() {
  app.dock?.hide();
  let decoderWindow;
  try {
    reportStage("starting sidecar");
    const running = await manager.start({
      instanceId: "native-h264-webcodecs-smoke",
      simulatorUdid,
      generation: 1,
    });
    if (!running.handshake.capabilities.h264Stream) {
      throw new Error(
        "Opt-in sidecar did not advertise H.264 product streaming",
      );
    }
    reportStage("sidecar ready");
    decoderWindow = await createDecoderWindow();
    reportStage("WebCodecs renderer ready");
    await running.adapter.configureNativeStream({
      encoding: "h264",
      framesPerSecond,
      scalingPercent,
    });

    let observedFrames = 0;
    let codec = null;
    let expectedWidth = 0;
    let expectedHeight = 0;
    const stats = await running.adapter.streamNativeFrames({
      maxFrames,
      maxFrameBytes,
      async onFrame(frame) {
        reportStage(`decoding frame ${observedFrames + 1}`);
        if (frame.encoding !== "h264") {
          throw new Error(`Expected H.264, received ${frame.encoding}`);
        }
        if (frame.format !== "annex-b") {
          throw new Error(`Expected Annex-B, received ${frame.format}`);
        }
        if (!codec) codec = codecFromAnnexB(frame.bytes);
        if (!codec) throw new Error("The first H.264 access unit has no SPS");
        const queued = await decoderWindow.webContents.executeJavaScript(`
        globalThis.__cindyDecodeH264(${JSON.stringify({
          codec,
          width: frame.width,
          height: frame.height,
          keyFrame: frame.keyFrame,
          timestampMicros: frame.timestampMicros,
          bytes: Array.from(frame.bytes),
        })})
      `);
        if (queued?.queued !== true) {
          throw new Error("Electron WebCodecs did not queue the access unit");
        }
        expectedWidth = frame.width;
        expectedHeight = frame.height;
        observedFrames += 1;
        reportStage(`queued frame ${observedFrames}`);
      },
    });
    if (
      observedFrames !== maxFrames ||
      stats.frameCount !== maxFrames ||
      stats.endReason !== "max-frames"
    ) {
      throw new Error(
        `WebCodecs stream ended unexpectedly: ${JSON.stringify(stats)}`,
      );
    }
    reportStage("flushing decoder");
    const decoded = await decoderWindow.webContents.executeJavaScript(
      "globalThis.__cindyFlushH264()",
    );
    if (
      decoded.decodedFrames !== maxFrames ||
      decoded.lastFrame?.codedWidth !== expectedWidth ||
      decoded.lastFrame?.codedHeight !== expectedHeight
    ) {
      throw new Error(
        `Decoded ${JSON.stringify(decoded)}, expected ${maxFrames} frames at ${expectedWidth}x${expectedHeight}`,
      );
    }
    reportStage(`decoded ${decoded.decodedFrames} frames`);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        simulatorUdid,
        architecture,
        codec,
        framesPerSecond,
        scalingPercent,
        observedFrames,
        decodedFrames: decoded.decodedFrames,
        width: decoded.lastFrame.codedWidth,
        height: decoded.lastFrame.codedHeight,
        byteCount: stats.byteCount,
        endReason: stats.endReason,
      })}\n`,
    );
  } finally {
    if (decoderWindow && !decoderWindow.isDestroyed()) {
      await decoderWindow.webContents
        .executeJavaScript("globalThis.__cindyCloseH264?.()")
        .catch(() => undefined);
      decoderWindow.destroy();
    }
    await manager.stop("native-h264-webcodecs-smoke").catch(() => undefined);
    app.quit();
  }
}

reportStage("waiting for Electron");
app
  .whenReady()
  .then(() => {
    reportStage("Electron ready");
    return runSmoke();
  })
  .catch((error) => {
    process.stderr.write(
      `[native-h264-webcodecs-smoke] failed: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    app.exit(1);
  });
