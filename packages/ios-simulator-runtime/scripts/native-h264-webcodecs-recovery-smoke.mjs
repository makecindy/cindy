import "tsx/esm";

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { app, BrowserWindow } from "electron";
import ts from "typescript";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(packageRoot, "..", "..");
const decoderSourcePath = path.join(
  repositoryRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
  "features",
  "right-sidebar",
  "plugins",
  "ios-simulator",
  "iosSimulatorH264Decoder.ts",
);
const architecture =
  process.env.CINDY_IOS_SIDECAR_ARCH === "x86_64" ||
  process.env.CINDY_IOS_SIDECAR_ARCH === "arm64"
    ? process.env.CINDY_IOS_SIDECAR_ARCH
    : os.arch() === "x64"
      ? "x86_64"
      : "arm64";
const binaryPath = path.join(
  repositoryRoot,
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "native",
  architecture,
  "ios-simulator-sidecar",
);
const maxFrameBytes = 16 * 1024 * 1024 - 64 * 1024 - 4;
const instanceId = "native-h264-webcodecs-recovery-smoke";
const lifecycleModule = await import("../src/index.ts");
const {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createNodeIOSSimulatorCommandRunner,
  IOSSimulatorNativeSidecarProcessManager,
} = lifecycleModule;
const lifecycle = createIOSSimulatorSimctlLifecycle();
const commandRunner = createNodeIOSSimulatorCommandRunner();

function reportStage(stage) {
  process.stderr.write(`[native-h264-webcodecs-recovery-smoke] ${stage}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createTemporarySimulator() {
  const environment = await createIOSSimulatorRuntime().inspect();
  if (!environment.ready) {
    throw new Error(
      environment.error ??
        environment.issue ??
        "Simulator environment unavailable",
    );
  }
  const requestedRuntime = process.env.CINDY_IOS_SIMULATOR_RUNTIME?.trim();
  const runtime = environment.runtimes.find(
    (candidate) =>
      candidate.isAvailable &&
      candidate.identifier.includes(".iOS-") &&
      (!requestedRuntime ||
        candidate.identifier === requestedRuntime ||
        candidate.version === requestedRuntime ||
        candidate.name === requestedRuntime),
  );
  if (!runtime) {
    throw new Error(
      requestedRuntime
        ? `Requested iOS runtime is not available: ${requestedRuntime}`
        : "No available iOS runtime",
    );
  }
  const template =
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime.identifier &&
        candidate.deviceTypeIdentifier?.includes("iPhone-17-Pro"),
    ) ??
    environment.devices.find(
      (candidate) =>
        candidate.isAvailable &&
        candidate.runtimeIdentifier === runtime.identifier &&
        candidate.deviceTypeIdentifier,
    );
  if (!template?.deviceTypeIdentifier) {
    throw new Error("No compatible simulator device type");
  }
  const created = await lifecycle.createExact({
    name: `Cindy Native H264 WebCodecs Recovery Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  await lifecycle.bootExact(created.udid);
  return {
    runtimeIdentifier: runtime.identifier,
    simulatorUdid: created.udid,
  };
}

async function cleanupTemporarySimulator(simulatorUdid) {
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await lifecycle.shutdownExact(simulatorUdid);
    } catch (error) {
      lastError = error;
    }
    try {
      await lifecycle.deleteExact(simulatorUdid);
    } catch (error) {
      lastError = error;
    }
    const listed = await commandRunner.run(
      "/usr/bin/xcrun",
      ["simctl", "list", "devices", "-j"],
      { timeoutMs: 30_000 },
    );
    if (listed.exitCode !== 0) {
      lastError = new Error(
        `Unable to verify temporary simulator cleanup: ${listed.stderr.trim()}`,
      );
    } else if (!listed.stdout.toUpperCase().includes(simulatorUdid)) {
      return;
    } else {
      lastError = new Error(
        `Temporary simulator ${simulatorUdid} still exists after cleanup attempt ${attempt}`,
      );
    }
    await delay(250);
  }
  throw lastError ?? new Error("Temporary simulator cleanup failed");
}

async function createDecoderWindow() {
  const source = await readFile(decoderSourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
    },
    fileName: decoderSourcePath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      `Unable to transpile the production decoder: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        )
        .join("; ")}`,
    );
  }

  const decoderWindow = new BrowserWindow({
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
  await decoderWindow.loadURL(
    pathToFileURL(
      path.join(packageRoot, "scripts", "native-h264-webcodecs-smoke.html"),
    ).href,
  );
  const initialized = await decoderWindow.webContents.executeJavaScript(`
    (() => {
      if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") {
        return false;
      }
      const exports = {};
      const module = { exports };
      ${transpiled.outputText}
      const ProductionDecoder = module.exports.IOSSimulatorH264Decoder;
      if (typeof ProductionDecoder !== "function") return false;

      const state = {
        decoder: null,
        retiredDecoder: null,
        webDecoder: null,
        productionDecoderInstances: 0,
        webDecoderInstances: 0,
        renderedFrames: 0,
        lastFrame: null,
        fallbackReasons: [],
        decodeResults: [],
      };
      const runtime = {
        async isConfigSupported(configuration) {
          const support = await VideoDecoder.isConfigSupported(configuration);
          return support.supported === true;
        },
        createDecoder(callbacks) {
          const decoder = new VideoDecoder(callbacks);
          state.webDecoder = decoder;
          state.webDecoderInstances += 1;
          return decoder;
        },
        createChunk(init) {
          return new EncodedVideoChunk(init);
        },
      };
      const createProductionDecoder = () => {
        if (state.decoder) {
          state.decoder.close();
          state.retiredDecoder = state.decoder;
        }
        state.decoder = new ProductionDecoder({
          runtime,
          renderFrame(frame, width, height) {
            state.renderedFrames += 1;
            state.lastFrame = {
              width,
              height,
              codedWidth: frame.codedWidth,
              codedHeight: frame.codedHeight,
              timestamp: frame.timestamp,
            };
          },
          onFallback(reason) {
            state.fallbackReasons.push(reason);
          },
        });
        state.productionDecoderInstances += 1;
      };
      const materializeFrame = (input) => ({
        ...input,
        bytes: new Uint8Array(input.bytes),
      });

      globalThis.__cindyProductionH264Smoke = {
        createDecoder() {
          createProductionDecoder();
          return state.productionDecoderInstances;
        },
        async decode(input) {
          const result = await state.decoder.decode(
            materializeFrame(input.frame),
            input.generation,
          );
          state.decodeResults.push(result);
          return result;
        },
        async decodeRetired(input) {
          if (!state.retiredDecoder) return "missing";
          return state.retiredDecoder.decode(
            materializeFrame(input.frame),
            input.generation,
          );
        },
        async flush() {
          const decoder = state.webDecoder;
          if (!decoder || decoder.state === "closed") return;
          let timeoutId;
          const timeout = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error("Electron WebCodecs did not flush within 5 seconds")),
              5000,
            );
          });
          try {
            await Promise.race([decoder.flush(), timeout]);
          } finally {
            clearTimeout(timeoutId);
          }
        },
        closeDecoder() {
          if (state.decoder) {
            state.decoder.close();
            state.retiredDecoder = state.decoder;
            state.decoder = null;
          }
        },
        snapshot() {
          return {
            productionDecoderInstances: state.productionDecoderInstances,
            webDecoderInstances: state.webDecoderInstances,
            renderedFrames: state.renderedFrames,
            lastFrame: state.lastFrame,
            fallbackReasons: [...state.fallbackReasons],
            decodeResults: [...state.decodeResults],
          };
        },
      };
      createProductionDecoder();
      return true;
    })()
  `);
  if (initialized !== true) {
    decoderWindow.destroy();
    throw new Error(
      "Electron Renderer could not initialize the production H.264 decoder",
    );
  }
  return decoderWindow;
}

function frameInput(frame) {
  return {
    generation: 1,
    frame: {
      encoding: frame.encoding,
      format: frame.format,
      bytes: Array.from(frame.bytes),
      receivedAt: frame.receivedAt,
      width: frame.width,
      height: frame.height,
      orientation: frame.orientation,
      scale: frame.scale,
      colorSpace: frame.colorSpace,
      timestampMicros: frame.timestampMicros,
      keyFrame: frame.keyFrame,
    },
  };
}

async function evaluate(decoderWindow, expression) {
  return decoderWindow.webContents.executeJavaScript(
    `globalThis.__cindyProductionH264Smoke.${expression}`,
  );
}

async function waitForRenderedFrames(decoderWindow, minimum) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const snapshot = await evaluate(decoderWindow, "snapshot()");
    if (snapshot.renderedFrames >= minimum) return snapshot;
    await delay(50);
  }
  const snapshot = await evaluate(decoderWindow, "snapshot()");
  throw new Error(
    `Timed out waiting for ${minimum} rendered frames: ${JSON.stringify(snapshot)}`,
  );
}

async function captureProfile({
  decoderWindow,
  running,
  scalingPercent,
  expectedDecoderInstances,
  decodeRetiredFirstFrame = false,
}) {
  await running.adapter.configureNativeStream({
    encoding: "h264",
    framesPerSecond: 5,
    scalingPercent,
  });
  const before = await evaluate(decoderWindow, "snapshot()");
  let firstFrame = null;
  let retiredDecodeResult = null;
  const stats = await running.adapter.streamNativeFrames({
    maxFrames: 3,
    maxFrameBytes,
    async onFrame(frame) {
      if (frame.encoding !== "h264" || frame.format !== "annex-b") {
        throw new Error(
          `Expected Annex-B H.264, received ${frame.encoding}/${frame.format}`,
        );
      }
      firstFrame ??= frame;
      const input = frameInput(frame);
      if (decodeRetiredFirstFrame && retiredDecodeResult === null) {
        retiredDecodeResult = await evaluate(
          decoderWindow,
          `decodeRetired(${JSON.stringify(input)})`,
        );
      }
      const result = await evaluate(
        decoderWindow,
        `decode(${JSON.stringify(input)})`,
      );
      if (result !== "decoded") {
        throw new Error(`Production decoder returned ${String(result)}`);
      }
    },
  });
  await evaluate(decoderWindow, "flush()");
  const after = await waitForRenderedFrames(
    decoderWindow,
    before.renderedFrames + stats.frameCount,
  );
  if (
    stats.endReason !== "max-frames" ||
    stats.frameCount !== 3 ||
    !firstFrame?.keyFrame ||
    after.lastFrame?.width !== firstFrame.width ||
    after.lastFrame?.height !== firstFrame.height ||
    after.lastFrame?.codedWidth !== firstFrame.width ||
    after.lastFrame?.codedHeight !== firstFrame.height ||
    after.webDecoderInstances !== expectedDecoderInstances ||
    after.fallbackReasons.length > 0
  ) {
    throw new Error(
      `Production decoder profile validation failed: ${JSON.stringify({
        scalingPercent,
        stats,
        firstFrame: firstFrame
          ? {
              width: firstFrame.width,
              height: firstFrame.height,
              keyFrame: firstFrame.keyFrame,
            }
          : null,
        before,
        after,
      })}`,
    );
  }
  return {
    width: firstFrame.width,
    height: firstFrame.height,
    keyFrame: firstFrame.keyFrame,
    renderedFrames: after.renderedFrames - before.renderedFrames,
    webDecoderInstances: after.webDecoderInstances,
    retiredDecodeResult,
  };
}

const manager = new IOSSimulatorNativeSidecarProcessManager({
  binaryPath,
  enableH264Stream: true,
});

// This standalone smoke owns its only hidden window. Keep Electron alive after
// destroying that window so sidecar and temporary-device cleanup can finish.
app.on("window-all-closed", () => undefined);

async function runSmoke() {
  app.dock?.hide();
  let decoderWindow = null;
  let simulatorUdid = null;
  let runtimeIdentifier = null;
  try {
    reportStage("creating temporary simulator");
    const temporary = await createTemporarySimulator();
    simulatorUdid = temporary.simulatorUdid;
    runtimeIdentifier = temporary.runtimeIdentifier;
    reportStage(`temporary simulator ready: ${simulatorUdid}`);

    let running = await manager.start({
      instanceId,
      simulatorUdid,
      generation: 1,
    });
    if (!running.handshake.capabilities.h264Stream) {
      throw new Error("Opt-in sidecar did not advertise H.264 streaming");
    }
    decoderWindow = await createDecoderWindow();
    reportStage("production decoder ready in Electron Renderer");

    const initial = await captureProfile({
      decoderWindow,
      running,
      scalingPercent: 50,
      expectedDecoderInstances: 1,
    });
    reportStage(
      `decoded initial profile at ${initial.width}x${initial.height}`,
    );
    const scaled = await captureProfile({
      decoderWindow,
      running,
      scalingPercent: 60,
      expectedDecoderInstances: 2,
    });
    reportStage(`decoded scaled profile at ${scaled.width}x${scaled.height}`);
    const restored = await captureProfile({
      decoderWindow,
      running,
      scalingPercent: 50,
      expectedDecoderInstances: 3,
    });
    reportStage(
      `decoded restored profile at ${restored.width}x${restored.height}`,
    );
    if (
      initial.width !== restored.width ||
      initial.height !== restored.height ||
      initial.width === scaled.width ||
      initial.height === scaled.height
    ) {
      throw new Error("H.264 profile dimensions did not reset as expected");
    }

    const beforeStop = await evaluate(decoderWindow, "snapshot()");
    await evaluate(decoderWindow, "closeDecoder()");
    const afterClose = await evaluate(decoderWindow, "snapshot()");
    if (
      JSON.stringify(afterClose.lastFrame) !==
      JSON.stringify(beforeStop.lastFrame)
    ) {
      throw new Error(
        "Closing the production decoder cleared the retained frame",
      );
    }
    reportStage("stopping sidecar for controlled recovery");
    await manager.stop(instanceId);

    running = await manager.start({
      instanceId,
      simulatorUdid,
      generation: 1,
    });
    await evaluate(decoderWindow, "createDecoder()");
    const recovered = await captureProfile({
      decoderWindow,
      running,
      scalingPercent: 50,
      expectedDecoderInstances: 4,
      decodeRetiredFirstFrame: true,
    });
    if (recovered.retiredDecodeResult !== "closed") {
      throw new Error(
        `Retired production decoder returned ${String(recovered.retiredDecodeResult)}`,
      );
    }
    reportStage(
      `decoded recovered stream at ${recovered.width}x${recovered.height}`,
    );

    const finalSnapshot = await evaluate(decoderWindow, "snapshot()");
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        simulatorUdid,
        runtime: runtimeIdentifier,
        architecture,
        decoder: "IOSSimulatorH264Decoder",
        profiles: {
          initial,
          scaled,
          restored,
          recovered,
        },
        productionDecoderInstances: finalSnapshot.productionDecoderInstances,
        webDecoderInstances: finalSnapshot.webDecoderInstances,
        renderedFrames: finalSnapshot.renderedFrames,
        retainedFrameAcrossRecovery: true,
        retiredDecoderResult: recovered.retiredDecodeResult,
        fallbackReasons: finalSnapshot.fallbackReasons,
      })}\n`,
    );
  } finally {
    if (decoderWindow && !decoderWindow.isDestroyed()) {
      await decoderWindow.webContents
        .executeJavaScript(
          "globalThis.__cindyProductionH264Smoke?.closeDecoder()",
        )
        .catch(() => undefined);
      decoderWindow.destroy();
    }
    await manager.stop(instanceId).catch(() => undefined);
    if (simulatorUdid) {
      reportStage(`cleaning temporary simulator: ${simulatorUdid}`);
      await cleanupTemporarySimulator(simulatorUdid);
      reportStage("temporary simulator removed");
    }
  }
}

reportStage("waiting for Electron");
app
  .whenReady()
  .then(() => {
    reportStage("Electron ready");
    return runSmoke();
  })
  .then(() => {
    app.quit();
  })
  .catch((error) => {
    process.stderr.write(
      `[native-h264-webcodecs-recovery-smoke] failed: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    app.exit(1);
  });
