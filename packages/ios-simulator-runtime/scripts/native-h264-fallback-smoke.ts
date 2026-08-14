import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createIOSSimulatorRuntime,
  createIOSSimulatorSimctlLifecycle,
  createIOSSimulatorNativeDevelopmentAdmissionPolicy,
  createNodeIOSSimulatorCommandRunner,
  HostIOSSimulatorSidecarSupervisor,
  IOSSimulatorFramePump,
  IOSSimulatorH264FramePump,
  IOSSimulatorNativeSidecarProcessManager,
  IOSSimulatorStaticSidecarArtifactResolver,
  type IOSSimulatorFramePumpSnapshot,
  type IOSSimulatorSidecarSupervisor,
  WdaProcessManager,
} from "../src/index.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const archivePath = path.resolve(
  packageRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "resources",
  "ios-simulator",
  "WebDriverAgent-v15.1.6.tar.gz",
);
const cacheRoot = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "cindy-ios-simulator-smoke",
  "wda",
);
const architecture = process.arch === "x64" ? "x86_64" : "arm64";
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
const instanceId = "native-h264-fallback-smoke";
const generation = 1;
const lifecycle = createIOSSimulatorSimctlLifecycle();
const runner = createNodeIOSSimulatorCommandRunner();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSnapshot(
  pump: {
    snapshot(instanceId: string): IOSSimulatorFramePumpSnapshot | null;
  },
  predicate: (snapshot: IOSSimulatorFramePumpSnapshot) => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<IOSSimulatorFramePumpSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = pump.snapshot(instanceId);
    if (snapshot && predicate(snapshot)) return snapshot;
    await delay(100);
  }
  const snapshot = pump.snapshot(instanceId);
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(
      snapshot
        ? {
            state: snapshot.state,
            reconnectAttempt: snapshot.reconnectAttempt,
            encoding: snapshot.latestFrame?.encoding ?? null,
            sequence: snapshot.latestFrame?.sequence ?? null,
          }
        : null,
    )}`,
  );
}

let simulatorUdid: string | null = null;
let wdaManager: WdaProcessManager | null = null;
let nativeProvider: IOSSimulatorSidecarSupervisor | null = null;
const h264Pump = new IOSSimulatorH264FramePump({
  maxReconnectAttempts: 1,
  reconnectDelaysMs: [0],
});
const jpegPump = new IOSSimulatorFramePump({
  maxReconnectAttempts: 1,
  reconnectDelaysMs: [0],
});

try {
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
    name: `Cindy Native H264 Fallback Smoke ${Date.now()}`,
    deviceTypeIdentifier: template.deviceTypeIdentifier,
    runtimeIdentifier: runtime.identifier,
  });
  simulatorUdid = created.udid;
  const device = await lifecycle.bootExact(simulatorUdid);
  await mkdir(cacheRoot, { recursive: true });

  nativeProvider = new HostIOSSimulatorSidecarSupervisor({
    providerId: "cindy.native-h264-fallback-smoke",
    artifactResolver: new IOSSimulatorStaticSidecarArtifactResolver({
      artifactId: "cindy.ios-simulator-sidecar",
      source: "bundled",
      version: "smoke",
      architecture,
      executablePath: binaryPath,
      trust: "development",
      sha256: null,
    }),
    admissionPolicy: {
      resolve: () =>
        createIOSSimulatorNativeDevelopmentAdmissionPolicy({
          enableH264Stream: true,
        }),
    },
    createRuntime: ({ artifact, admissionPolicy }) =>
      new IOSSimulatorNativeSidecarProcessManager({
        binaryPath: artifact.executablePath,
        admissionPolicy,
      }),
  });
  wdaManager = new WdaProcessManager({
    archivePath,
    cacheRoot,
    nativeCapabilityProvider: nativeProvider,
  });
  const wda = await wdaManager.start({
    instanceId,
    simulatorUdid,
    runtimeIdentifier: device.runtimeIdentifier,
    xcodeBuild: environment.xcodeVersion ?? "unknown",
    architecture,
    generation,
  });
  await wda.driver.configureStream(wda.driverSessionId, {
    framesPerSecond: 5,
    jpegQuality: 25,
    scalingPercent: 50,
  });
  const launch = await runner.run(
    "/usr/bin/xcrun",
    ["simctl", "launch", simulatorUdid, "com.apple.mobilesafari"],
    { timeoutMs: 30_000 },
  );
  if (launch.exitCode !== 0) {
    throw new Error("Unable to launch Safari in the temporary simulator");
  }
  await delay(500);

  const nativeRoute = wda.driverRouter?.stream("h264");
  if (nativeRoute?.adapter !== "native-sidecar") {
    throw new Error("Opt-in sidecar did not advertise H.264 streaming");
  }

  h264Pump.setVisible({
    instanceId,
    generation,
    driver: nativeRoute.source,
    profile: {
      encoding: "h264",
      framesPerSecond: 5,
      scalingPercent: 50,
      orientation: "PORTRAIT",
    },
    visible: true,
  });
  const h264Streaming = await waitForSnapshot(
    h264Pump,
    (snapshot) =>
      snapshot.state === "streaming" &&
      snapshot.latestFrame?.encoding === "h264",
    "the first native H.264 frame",
  );
  const h264Frame = h264Streaming.latestFrame;
  if (
    h264Frame?.encoding !== "h264" ||
    !h264Frame.keyFrame ||
    h264Frame.bytes.byteLength === 0
  ) {
    throw new Error(
      "The first native H.264 frame is not independently decodable",
    );
  }

  const disconnectedAt = performance.now();
  await nativeProvider.stop(instanceId);
  const h264Disconnected = await waitForSnapshot(
    h264Pump,
    (snapshot) => snapshot.state === "disconnected",
    "the native H.264 pump to disconnect",
  );

  jpegPump.setVisible({
    instanceId,
    generation,
    driver: wda.driver,
    visible: true,
  });
  const jpegStreaming = await waitForSnapshot(
    jpegPump,
    (snapshot) =>
      snapshot.state === "streaming" &&
      snapshot.latestFrame?.encoding === "jpeg",
    "the first WDA MJPEG fallback frame",
  );
  const jpegFrame = jpegStreaming.latestFrame;
  if (
    jpegFrame?.encoding !== "jpeg" ||
    jpegFrame.bytes.byteLength < 4 ||
    jpegFrame.bytes[0] !== 0xff ||
    jpegFrame.bytes[1] !== 0xd8 ||
    jpegFrame.bytes.at(-2) !== 0xff ||
    jpegFrame.bytes.at(-1) !== 0xd9
  ) {
    throw new Error("WDA fallback did not produce a complete JPEG frame");
  }
  const fallbackLatencyMs = Math.round(performance.now() - disconnectedAt);

  const recoveredWda = await wdaManager.recoverNativeSidecar(instanceId, {
    rearm: true,
  });
  const recoveredRoute = recoveredWda?.driverRouter?.stream("h264");
  if (recoveredRoute?.adapter !== "native-sidecar") {
    throw new Error("Native H.264 route did not recover");
  }
  h264Pump.setVisible({
    instanceId,
    generation,
    driver: recoveredRoute.source,
    profile: {
      encoding: "h264",
      framesPerSecond: 5,
      scalingPercent: 50,
      orientation: "PORTRAIT",
    },
    visible: true,
  });
  const h264Recovered = await waitForSnapshot(
    h264Pump,
    (snapshot) =>
      snapshot.state === "streaming" &&
      snapshot.latestFrame?.encoding === "h264" &&
      snapshot.latestFrame.sequence > h264Frame.sequence,
    "the recovered native H.264 frame",
  );
  const recoveredFrame = h264Recovered.latestFrame;
  if (
    recoveredFrame?.encoding !== "h264" ||
    !recoveredFrame.keyFrame ||
    recoveredFrame.bytes.byteLength === 0
  ) {
    throw new Error("Recovered native H.264 did not restart from a key frame");
  }
  jpegPump.clear(instanceId);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      simulatorUdid,
      runtime: runtime.identifier,
      architecture,
      h264: {
        width: h264Frame.width,
        height: h264Frame.height,
        bytes: h264Frame.bytes.byteLength,
        sequence: h264Frame.sequence,
        keyFrame: h264Frame.keyFrame,
      },
      disconnect: {
        reconnectAttempt: h264Disconnected.reconnectAttempt,
        retainedEncoding: h264Disconnected.latestFrame?.encoding ?? null,
      },
      mjpeg: {
        bytes: jpegFrame.bytes.byteLength,
        sequence: jpegFrame.sequence,
      },
      recoveredH264: {
        width: recoveredFrame.width,
        height: recoveredFrame.height,
        bytes: recoveredFrame.bytes.byteLength,
        sequence: recoveredFrame.sequence,
        keyFrame: recoveredFrame.keyFrame,
      },
      fallbackLatencyMs,
    })}\n`,
  );
} finally {
  h264Pump.clear(instanceId);
  jpegPump.clear(instanceId);
  if (nativeProvider) {
    await nativeProvider.dispose().catch(() => undefined);
  }
  if (wdaManager) {
    await wdaManager.stop(instanceId).catch(() => undefined);
  }
  if (simulatorUdid) {
    await lifecycle.shutdownExact(simulatorUdid).catch(() => undefined);
    await lifecycle.deleteExact(simulatorUdid).catch(() => undefined);
  }
}
