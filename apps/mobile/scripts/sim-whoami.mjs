#!/usr/bin/env node
// "我现在看到的到底是哪一版?" 的终端体检。一次性打印:
//   1) 当前 booted 模拟器
//   2) 所选 region 的实际 bundle id 与已安装 native development client 版本
//   3) 常用端口及显式指定端口上的 Metro 分别属于哪个 worktree
//
// bundle id 不在本脚本硬编码:它用与 sim:start / sim:rebuild 相同的 region + 本地
// self-host-regions.json 环境解析 Expo config,确保 cn/global 与后续身份迁移自动同步。
// 注意:native 版本号只证明安装包,证明不了 JS 新鲜度——JS 要看连的是哪个 worktree
// 的 Metro(配合模拟器里的 __DEV__ build label)。
//
// 用法:
//   pnpm mobile:sim:whoami                     # Global(默认)
//   pnpm mobile:sim:whoami -- --region=cn      # 中国大陆版
//   pnpm mobile:sim:whoami -- --json           # Skill 可消费的结构化状态
//   pnpm mobile:sim:whoami -- --mock           # 核对的是 --mock 启动的模拟数据 Metro
//
// 模拟器默认先找 Cindy 模拟器(Baguette 插件的独立设备目录)，没有再找系统模拟器；
// CINDY_MOBILE_SIMULATOR=cindy|system|<设备目录绝对路径> 可固定其一。

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSimulatorViewer } from "./lib/simulator-viewer.mjs";
import { inspectSimulatorNativeIdentity } from "./lib/sim-native-identity.mjs";
import { mobileClientBundleEnv } from "../../../scripts/shared/client-endpoint-build-env.mjs";
import { applySimMockArg, readSimEnvironment } from "./lib/sim-environment.mjs";
import { withLocalMobileRegionConfig, extractMobileDevRegionArgs } from "./lib/mobile-dev-region.mjs";
import {
  ensureMobileLocalRegionConfig,
  formatMobileLocalConfigStatus,
} from "./lib/mobile-local-config.mjs";
import {
  classifySimMetroListener,
  validateSimMetroIdentity,
  extractSimMetroPortArgs,
  extractSimWhoamiUdidArgs,
  getSimulatorAppContainer,
  resolveMobileSimulatorBundleId,
  resolveSimulatorDeviceSets,
  selectBootedSimulator,
  simctlArgs,
} from "./lib/sim-whoami.mjs";
import {
  gitSourceIdentity,
  probeMetroOwnership,
} from "./sim-metro.mjs";

const PORTS = [8081, 8082, 8083, 8084, 8085, 8086];
const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worktreeRoot = resolve(mobileDir, "../..");

const cliArgs = applySimMockArg(process.argv.slice(2));
const jsonOutput = cliArgs.includes("--json");
const requireViewer = cliArgs.includes("--viewer");

function resolveTarget() {
  const { region, passthrough } = extractMobileDevRegionArgs(
    cliArgs.filter((arg) => arg !== "--json" && arg !== "--viewer"),
  );
  const udidArgs = extractSimWhoamiUdidArgs(passthrough);
  const portArgs = extractSimMetroPortArgs(udidArgs.passthrough);
  if (portArgs.passthrough.length > 0) {
    throw new Error(
      `mobile:sim:whoami 不支持参数: ${portArgs.passthrough.join(" ")}`,
    );
  }
  return {
    region,
    port: portArgs.port,
    simulatorUdid: udidArgs.simulatorUdid,
    bundleId: resolveMobileSimulatorBundleId(region),
    deviceSets: resolveSimulatorDeviceSets(),
  };
}

let target;
try {
  const localConfigResult = ensureMobileLocalRegionConfig({ mobileDir });
  if (!jsonOutput) {
    const localConfigStatus = formatMobileLocalConfigStatus(
      localConfigResult,
      worktreeRoot,
    );
    if (localConfigStatus) console.log(localConfigStatus);
  }
  target = resolveTarget();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(jsonOutput ? JSON.stringify({ healthy: false, error: message }) : `✗ ${message}`);
  process.exit(1);
}
const { region, port: expectedPort, simulatorUdid, bundleId, deviceSets } = target;
const ports = [...new Set([...PORTS, expectedPort])].sort((a, b) => a - b);
const expectedSource = gitSourceIdentity(worktreeRoot);
let healthy = true;

function shFile(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

if (!jsonOutput) {
  console.log(`==> Mobile dev region: ${region}`);
}
const { deviceSet, booted, targetBooted } = selectBootedSimulator(
  deviceSets,
  (set) => shFile("xcrun", simctlArgs(set, ["list", "devices", "booted"])),
  simulatorUdid,
);
if (!jsonOutput) console.log(`==== booted 模拟器(${deviceSet.name})====`);
if (booted.length === 0) {
  if (!jsonOutput) console.log("  (没有 booted 模拟器)");
  healthy = false;
} else if (!jsonOutput) booted.forEach((l) => console.log("  " + l.trim()));
if (targetBooted.length !== 1) {
  if (!jsonOutput) console.log(`  (需要唯一的已启动目标模拟器；多设备时传 --udid)`);
  healthy = false;
}

if (!jsonOutput) console.log(`\n==== 模拟器里装的 ${bundleId}(native 安装包版本)====`);
const container = targetBooted.length === 1 ? getSimulatorAppContainer(shFile, simulatorUdid, bundleId, deviceSet) : "";
let installed = null;
if (!container) {
  if (!jsonOutput) {
    console.log(
      simulatorUdid
        ? `  (目标模拟器 ${simulatorUdid} 未安装 / 未启动)`
        : "  (未安装 / 无 booted 设备)",
    );
  }
  healthy = false;
} else {
  const plist = `${container}/Info.plist`;
  const pb = (key) =>
    shFile("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
  installed = {
    version: pb("CFBundleShortVersionString"),
    buildNumber: pb("CFBundleVersion"),
  };
  if (!jsonOutput) {
    console.log("  version    :", installed.version);
    console.log("  buildNumber:", installed.buildNumber);
    console.log(
      "  ⚠️ 版本号只证明装的是哪个 dev client,证明不了 JS bundle 是不是当前分支最新。",
    );
  }
}

const native = inspectSimulatorNativeIdentity({
  appPath: container, projectDir: mobileDir,
  env: { ...process.env, ...withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region })) },
});
if (!native.healthy) healthy = false;
if (!jsonOutput) {
  console.log(`  native: ${native.code}`);
  if (!native.healthy) console.log(`  请运行 pnpm mobile:sim:rebuild -- --region=${region}${simulatorUdid ? ` --udid ${simulatorUdid}` : ''}，再检查原生兼容性。`);
}

if (!jsonOutput) console.log("\n==== Metro 端口归属(哪个端口 = 哪个 worktree)====");
let anyMetro = false;
let currentSourceOnExpectedPort = false;
const metros = [];
const { envFingerprint, uiMock } = readSimEnvironment(mobileDir,
  withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region })));
for (const port of ports) {
  const ownership = probeMetroOwnership(port);
  if (!ownership) continue;
  const listener = classifySimMetroListener({
    cwd: ownership.cwd, source: ownership.source, targetWorktree: worktreeRoot,
  });
  const verdict = validateSimMetroIdentity({
    listener, currentSource: expectedSource, runningSource: ownership.source,
    currentRegion: region, runningRegion: ownership.region,
    currentEnvFingerprint: envFingerprint, runningEnvFingerprint: ownership.envFingerprint,
  });
  anyMetro ||= listener.confirmed;
  metros.push({ port, ...ownership, pid: Number(ownership.pid), worktree: listener.worktree,
    isMetro: listener.confirmed, identity: verdict });
  if (!jsonOutput) console.log(`  :${port} pid ${ownership.pid} → ${listener.worktree || '(unknown)'}: ${verdict.code}`);
  if (port === expectedPort) currentSourceOnExpectedPort = verdict.healthy;
}

if (!anyMetro && !jsonOutput)
  console.log(
    `  (检查的端口上没发现 Metro;用 \`pnpm mobile:sim:start -- --port ${expectedPort}\` 启一个)`,
  );
if (!currentSourceOnExpectedPort) healthy = false;

// Devices outside the system set are not shown by Device Hub; Cindy's appear in its sidebar.
const viewer = deviceSet.path
  ? { available: false, running: false, status: `${deviceSet.name}-managed`, windowVerified: false,
      error: "该设备不在系统模拟器中，没有外部窗口；Cindy 模拟器请在 Cindy 侧边栏查看" }
  : await inspectSimulatorViewer();
if (requireViewer && !viewer.running) healthy = false;
if (!jsonOutput) {
  console.log(`\nSimulator viewer: ${viewer.status} (${viewer.appPath ?? viewer.error ?? 'not available'})`);
  console.log('Viewer process status does not verify a visible device window.');
}

if (!jsonOutput) {
  console.log(`\n当前 worktree 源码指纹:${expectedSource}`);
  console.log(
    `build label 必须显示这个指纹,且 host:port 必须是当前 worktree 的 ${expectedPort}。`,
  );
  if (healthy) {
    console.log(
      `✓ PASS:原生指纹匹配、${expectedPort} Metro 身份一致；尚未验证 App 加载 bundle 或显示页面。`,
    );
  } else {
    console.error(
      "✗ FAIL:当前模拟器验证链不完整或源码不一致;不要声称“已经启动当前版本”。",
    );
  }
} else {
  console.log(
    JSON.stringify({
      healthy,
      pageVerified: false,
      viewerRequired: requireViewer,
      viewer,
      region,
      uiMock,
      bundleId,
      worktree: worktreeRoot,
      source: expectedSource,
      expectedSource,
      expectedPort,
      currentSourceOnExpectedPort,
      anyMetro,
      simulator: deviceSet.name,
      booted: booted.map((line) => line.trim()),
      installed,
      native,
      metros,
      targetSimulatorUdid: simulatorUdid,
      targetBooted: simulatorUdid ? targetBooted.length === 1 : null,
    }),
  );
}

if (!healthy) process.exitCode = 1;
