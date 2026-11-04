#!/usr/bin/env node
// 一条命令把当前 worktree 的手机版跑到 iOS 模拟器上:选设备 → 开机 → Metro → 原生包 → 启动 → 身份核对。
// 可重复运行(比如设备闲置关机后)。进度写 stderr,stdout 最后一行固定是结果 JSON,失败时含 code 与 next。
//
// 用法(仓库根):
//   pnpm mobile:sim:up                        # Global,自动选设备和端口
//   pnpm mobile:sim:up -- --mock              # 免登录的 UI 模拟数据
//   pnpm mobile:sim:up -- --device "iPhone Air" / --udid <UDID> / --port 8082 / --region=cn
//   pnpm mobile:sim:up -- --takeover          # 用户明确同意中断 8081 上的其他任务时才用
//
// 不做:--clean、卸载、新建或删除设备、安装系统工具。个人常用机型可设 CINDY_MOBILE_SIM_DEVICE。

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mobileClientBundleEnv } from "../../../scripts/shared/client-endpoint-build-env.mjs";
import { ensureMobileEnv } from "./ensure-mobile-env.mjs";
import {
  extractMobileDevRegionArgs,
  withLocalMobileRegionConfig,
} from "./lib/mobile-dev-region.mjs";
import { ensureMobileLocalRegionConfig } from "./lib/mobile-local-config.mjs";
import { applySimMockArg, readSimEnvironment } from "./lib/sim-environment.mjs";
import {
  extractSimUpArgs,
  runSimUp,
  SIM_UP_PORTS,
  SimUpFailure,
} from "./lib/sim-up.mjs";
import {
  extractSimMetroPortArgs,
  extractSimWhoamiUdidArgs,
  inspectSimMetroIdentity,
  resolveMobileSimulatorBundleId,
  resolveSimulatorDeviceSets,
  simctlArgs,
} from "./lib/sim-whoami.mjs";
import {
  gitSourceIdentity,
  inspectMetroListeners,
  readMetroOwner,
  terminateMetro,
} from "./sim-metro.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(scriptsDir, "..");
const worktreeRoot = resolve(mobileDir, "../..");
const METRO_READY_TIMEOUT_MS = 120_000;
const ENTRY_BUNDLED = /\biOS Bundled\b.*\bindex\.js\b/;

const log = (message) => console.error(`[sim:up] ${message}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 启动和编译的输出可能带凭证,和 Metro 日志一样放系统临时目录,不放进 worktree;成功后删掉。
let runDir = null;
function runFile(name) {
  runDir ??= mkdtempSync(join(tmpdir(), "cindy-sim-up-"));
  return join(runDir, name);
}

/** sim-start records each launch's private Metro log in the ownership record. */
function metroLogPath(port) {
  const path = readMetroOwner(port)?.metroLogPath;
  return typeof path === "string" && existsSync(path) ? path : null;
}

function finish(result) {
  if (result.ok && runDir) rmSync(runDir, { recursive: true, force: true });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

function simctl(deviceSet, args, timeout = 30_000) {
  return execFileSync("xcrun", simctlArgs(deviceSet, args), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    killSignal: "SIGKILL",
  }).trim();
}

function listDevices(deviceSet) {
  return Object.values(
    JSON.parse(simctl(deviceSet, ["list", "devices", "-j"])).devices,
  ).flat();
}

/** The device's installed apps live on disk, so this also works while it is shut down. */
function hasApp(device, bundleId) {
  const root = join(device.dataPath ?? "", "Containers/Bundle/Application");
  if (!existsSync(root)) return false;
  return readdirSync(root).some((entry) => {
    try {
      return (
        execFileSync(
          "plutil",
          [
            "-extract",
            "MCMMetadataIdentifier",
            "raw",
            "-o",
            "-",
            join(
              root,
              entry,
              ".com.apple.mobile_container_manager.metadata.plist",
            ),
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim() === bundleId
      );
    } catch {
      return false;
    }
  });
}

function readJsLocation(deviceSet, udid, bundleId) {
  try {
    return simctl(deviceSet, [
      "spawn",
      udid,
      "defaults",
      "read",
      bundleId,
      "RCT_jsLocation",
    ]);
  } catch {
    return null;
  }
}

function setJsLocation(deviceSet, udid, bundleId, port) {
  if (port === SIM_UP_PORTS[0]) {
    if (readJsLocation(deviceSet, udid, bundleId) !== null)
      simctl(deviceSet, [
        "spawn",
        udid,
        "defaults",
        "delete",
        bundleId,
        "RCT_jsLocation",
      ]);
    return;
  }
  simctl(deviceSet, [
    "spawn",
    udid,
    "defaults",
    "write",
    bundleId,
    "RCT_jsLocation",
    `localhost:${port}`,
  ]);
}

async function bootDevice(deviceSet, udid) {
  log("开机…");
  try {
    simctl(deviceSet, ["boot", udid], 120_000);
  } catch (error) {
    // Booting an already booted device only means another caller got there first.
    if (!/current state: Booted/.test(String(error.stderr)))
      throw new Error(String(error.stderr || error.message).trim());
  }
  simctl(deviceSet, ["bootstatus", udid, "-b"], 300_000);
}

/** RunningBoard's latest state for the app since `since` (ms), as logged by SpringBoard. */
function appVisibility(deviceSet, udid, bundleId, since) {
  const start = new Date(since - 1_000);
  const pad = (value) => String(value).padStart(2, "0");
  const stamp =
    `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ` +
    `${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}`;
  let output = "";
  try {
    output = simctl(
      deviceSet,
      [
        "spawn",
        udid,
        "log",
        "show",
        "--start",
        stamp,
        "--style",
        "compact",
        "--predicate",
        `process == "SpringBoard" AND eventMessage CONTAINS "Received state update for" AND eventMessage CONTAINS "app<${bundleId}"`,
      ],
      60_000,
    );
  } catch {
    return "unknown";
  }
  const last = output
    .match(/running-active-(?:NotVisible|Visible)|running-suspended/g)
    ?.at(-1);
  if (last === undefined) return "unknown";
  return last === "running-active-Visible" ? "visible" : "hidden";
}

function logTail(path) {
  return existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").slice(-5).join("\n")
    : "";
}

/** Metro must outlive this command, so it runs detached; its own log is kept by sim-start. */
async function startMetro({ port, takeover, region, mock }) {
  const path = runFile(`sim-start-${port}.log`);
  // 重启或接管时旧 Metro 在新 Metro 就绪前仍会应答 /status,所以以归属记录换了新进程为准。
  const previousPid = readMetroOwner(port)?.pid ?? null;
  const fd = openSync(path, "a");
  const args = [
    join(scriptsDir, "sim-start.mjs"),
    `--region=${region}`,
    ...(mock ? ["--mock"] : []),
    ...(takeover ? ["--takeover"] : []),
    ...(port === SIM_UP_PORTS[0] ? [] : ["--port", String(port)]),
  ];
  const child = spawn(process.execPath, args, {
    cwd: worktreeRoot,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  let exitCode = null;
  child.once("exit", (code) => {
    exitCode = code ?? 1;
  });
  child.unref();
  closeSync(fd);
  for (
    const deadline = Date.now() + METRO_READY_TIMEOUT_MS;
    Date.now() < deadline;
    await sleep(500)
  ) {
    if (exitCode !== null)
      throw new Error(`Metro 启动退出(${exitCode}):${logTail(path)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(2_000),
      });
      const owner = readMetroOwner(port);
      const replaced =
        owner?.pid !== undefined &&
        owner.pid !== previousPid &&
        typeof owner.metroLogPath === "string" &&
        existsSync(owner.metroLogPath);
      if (
        replaced &&
        (await response.text()).includes("packager-status:running")
      ) {
        // Metro keeps writing here, duplicating its own log; unlinking frees it when Metro exits.
        rmSync(path, { force: true });
        return;
      }
    } catch {
      // Not listening yet.
    }
  }
  throw new Error(
    `Metro 在 ${METRO_READY_TIMEOUT_MS / 1000}s 内没有就绪:${logTail(path)}`,
  );
}

function runWhoami({ udid, port, region, mock }) {
  const result = spawnSync(
    process.execPath,
    [
      join(scriptsDir, "sim-whoami.mjs"),
      `--region=${region}`,
      ...(mock ? ["--mock"] : []),
      "--udid",
      udid,
      "--port",
      String(port),
      "--json",
    ],
    {
      cwd: worktreeRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 300_000,
      killSignal: "SIGKILL",
    },
  );
  const line = String(result.stdout ?? "")
    .trim()
    .split("\n")
    .at(-1);
  try {
    return JSON.parse(line);
  } catch {
    return {
      healthy: false,
      code: "WHOAMI_UNAVAILABLE",
      error: `whoami 没有返回结果(退出码 ${result.status})`,
    };
  }
}

/** Output goes to stderr and a log file; the failure classifier also needs it in memory. */
function runRebuild({ udid, region, mock }) {
  const logPath = runFile("rebuild.log");
  const file = createWriteStream(logPath);
  let output = "";
  const child = spawn(
    process.execPath,
    [
      join(scriptsDir, "sim-rebuild.mjs"),
      `--region=${region}`,
      ...(mock ? ["--mock"] : []),
      "--udid",
      udid,
    ],
    { cwd: worktreeRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
    file.write(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return new Promise((done) => {
    const settle = (status) => {
      file.end();
      done({ status, output, logPath });
    };
    child.once("error", () => settle(1));
    child.once("close", (code) => settle(code ?? 1));
  });
}

async function waitForBundle(path, offset, timeoutMs) {
  for (
    const deadline = Date.now() + timeoutMs;
    Date.now() < deadline;
    await sleep(1_000)
  ) {
    if (!existsSync(path)) continue;
    const lines = readFileSync(path)
      .subarray(offset)
      .toString("utf8")
      .split("\n");
    const failed = lines.find((line) => /iOS Bundling failed/.test(line));
    if (failed) return { status: "failed", line: failed.trim() };
    if (lines.some((line) => ENTRY_BUNDLED.test(line)))
      return { status: "bundled" };
  }
  return { status: "timeout" };
}

let parsed;
try {
  if (process.platform !== "darwin") {
    throw new SimUpFailure(
      "UNSUPPORTED_PLATFORM",
      "arguments",
      "mobile:sim:up 目前只支持 macOS 上的 iOS 模拟器。",
      "Windows 用 pnpm mobile:sim:start 和 pnpm mobile:sim:rebuild。",
    );
  }
  const mockArgs = applySimMockArg(
    process.argv.slice(2).filter((arg) => arg !== "--"),
  );
  const { region, passthrough: regionRest } =
    extractMobileDevRegionArgs(mockArgs);
  const {
    deviceName,
    takeover,
    passthrough: upRest,
  } = extractSimUpArgs(regionRest);
  const { simulatorUdid, passthrough: udidRest } =
    extractSimWhoamiUdidArgs(upRest);
  const portArgs = extractSimMetroPortArgs(udidRest);
  if (portArgs.passthrough.length > 0)
    throw new Error(`不支持的参数: ${portArgs.passthrough.join(" ")}`);
  parsed = {
    region,
    deviceName,
    takeover,
    simulatorUdid,
    explicitPort: portArgs.explicit ? portArgs.port : null,
  };
} catch (error) {
  finish(
    error instanceof SimUpFailure
      ? {
          ok: false,
          code: error.code,
          step: error.step,
          error: error.message,
          next: error.next,
        }
      : {
          ok: false,
          code: "BAD_ARGS",
          step: "arguments",
          error: error.message,
          next: "用法见 apps/mobile/scripts/sim-up.mjs 开头。",
        },
  );
}

const { region, deviceName, takeover, simulatorUdid, explicitPort } = parsed;

try {
  ensureMobileLocalRegionConfig({ mobileDir });
  const buildEnv = withLocalMobileRegionConfig(
    mobileClientBundleEnv({ authRegion: region }),
  );
  ensureMobileEnv({ mobileDir, authRegion: region, endpointEnv: buildEnv });
  const { uiMock: mock, envFingerprint } = readSimEnvironment(
    mobileDir,
    buildEnv,
  );
  let deviceSets;
  try {
    deviceSets = resolveSimulatorDeviceSets();
  } catch (error) {
    throw new SimUpFailure(
      "SIMULATOR_UNAVAILABLE",
      "select-device",
      error.message,
      "按提示在 Cindy 打开模拟器插件;不要自行改用系统模拟器,除非用户明确要求。",
    );
  }

  const result = await runSimUp(
    {
      region,
      mock,
      worktreeRoot,
      deviceSets,
      simulatorUdid,
      deviceName:
        deviceName ?? process.env.CINDY_MOBILE_SIM_DEVICE?.trim() ?? null,
      takeover,
      explicitPort,
      bundleId: resolveMobileSimulatorBundleId(region),
    },
    {
      log,
      listDevices,
      hasApp,
      readJsLocation,
      // 探测失败按有人在用处理,宁可多问一次也不打断别的任务。
      isPortListening: (port) => {
        const listeners = inspectMetroListeners([port]);
        return !listeners.healthy || Boolean(listeners.pids[port]);
      },
      setJsLocation,
      boot: bootDevice,
      launch: (deviceSet, udid, bundleId) => {
        simctl(
          deviceSet,
          ["launch", "--terminate-running-process", udid, bundleId],
          60_000,
        );
      },
      // Without --terminate-running-process launch only brings the running app forward.
      activate: (deviceSet, udid, bundleId) => {
        simctl(deviceSet, ["launch", udid, bundleId], 60_000);
      },
      appVisibility,
      now: () => Date.now(),
      sleep,
      metroState: () => {
        const ports = explicitPort
          ? [...new Set([...SIM_UP_PORTS, explicitPort])]
          : [...SIM_UP_PORTS];
        const listeners = inspectMetroListeners(ports);
        const identity = inspectSimMetroIdentity({
          ports,
          expectedPort: explicitPort ?? SIM_UP_PORTS[0],
          worktreeRoot,
          expectedSource: gitSourceIdentity(worktreeRoot),
          region,
          envFingerprint,
        });
        return {
          healthy: identity.probeErrors.length === 0,
          probeErrors: identity.probeErrors,
          metros: identity.metros,
          busyPorts: Object.keys(listeners.pids).map(Number),
        };
      },
      worktreeExists: (path) => Boolean(path) && existsSync(path),
      stopMetro: (metro) =>
        terminateMetro(metro.launcherPid ?? metro.pid, { worktreeRoot }),
      startMetro: ({ port, takeover: takeoverMetro }) =>
        startMetro({ port, takeover: takeoverMetro, region, mock }),
      metroLogPath,
      logSize: (path) => (path && existsSync(path) ? statSync(path).size : 0),
      waitForBundle,
      whoami: ({ udid, port }) => runWhoami({ udid, port, region, mock }),
      rebuild: ({ udid }) => runRebuild({ udid, region, mock }),
    },
  );
  finish(result);
} catch (error) {
  if (error instanceof SimUpFailure) {
    finish({
      ok: false,
      code: error.code,
      step: error.step,
      error: error.message,
      next: error.next,
      ...error.detail,
    });
  }
  finish({
    ok: false,
    code: "UNEXPECTED",
    step: "unknown",
    error: String(error?.message ?? error),
    next: "这是脚本未归类的错误;报告原文,不要据此断定本机缺工具。",
  });
}
