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
// 模拟器默认用 Cindy 模拟器(Baguette 插件的独立设备目录)，不可用时才找系统模拟器；
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
  inspectSimMetroIdentity,
  extractSimMetroPortArgs,
  extractSimWhoamiUdidArgs,
  getSimulatorAppContainer,
  inspectTargetNativeIdentity,
  resolveMobileSimulatorBundleId,
  resolveSimulatorDeviceSets,
  selectBootedSimulator,
  simctlArgs,
  simulatorBackendNotice,
} from "./lib/sim-whoami.mjs";
import { gitSourceIdentity } from "./sim-metro.mjs";

const PORTS = [8081, 8082, 8083, 8084, 8085, 8086];
const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worktreeRoot = resolve(mobileDir, "../..");

const cliArgs = applySimMockArg(process.argv.slice(2));
const jsonOutput = cliArgs.includes("--json");
const requireViewer = cliArgs.includes("--viewer");
const startedAt = Date.now();
const checks = [];
const probeErrors = [];

// Progress goes to stderr even in --json mode; stdout keeps one result object.
function timedCheck(stage, run) {
  const start = Date.now();
  console.error(`[whoami] ${stage}…`);
  try {
    const result = run();
    const elapsedMs = Date.now() - start;
    checks.push({ stage, elapsedMs });
    console.error(`[whoami] ${stage}: ${elapsedMs}ms`);
    return result;
  } catch (error) {
    checks.push({ stage, elapsedMs: Date.now() - start });
    const failure = { healthy: false, pageVerified: false, stage,
      code: error.code ?? 'CHECK_FAILED', checks, elapsedMs: Date.now() - startedAt,
      error: `${stage} 检查失败：${error.message ?? 'unknown error'}；检查该阶段的工具/当前 worktree 依赖后重试，不要将检查失败当作未安装 App。` };
    if (jsonOutput) console.log(JSON.stringify(failure));
    else console.error(`✗ ${failure.code}: ${failure.error}`);
    process.exit(1);
  }
}

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

const target = timedCheck('configuration', () => {
  const localConfigResult = ensureMobileLocalRegionConfig({ mobileDir });
  if (!jsonOutput) {
    const localConfigStatus = formatMobileLocalConfigStatus(
      localConfigResult,
      worktreeRoot,
    );
    if (localConfigStatus) console.log(localConfigStatus);
  }
  return resolveTarget();
});
const { region, port: expectedPort, simulatorUdid, bundleId, deviceSets } = target;
const { envFingerprint, uiMock } = timedCheck('environment', () => readSimEnvironment(mobileDir,
  withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region }))));
const ports = [...new Set([...PORTS, expectedPort])].sort((a, b) => a - b);
const expectedSource = timedCheck('source-identity', () => gitSourceIdentity(worktreeRoot));
let healthy = true;

function shFile(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      killSignal: "SIGKILL",
    }).trim();
  } catch (error) {
    if (error.code === 'ETIMEDOUT') {
      probeErrors.push({ command, code: 'PROBE_TIMEOUT', timeoutMs: 15_000 });
      console.error(`[whoami] ${command}: PROBE_TIMEOUT (15s)`);
    }
    return "";
  }
}

if (!jsonOutput) {
  console.log(`==> Mobile dev region: ${region}`);
}
const { deviceSet, booted, targetBooted } = timedCheck('simulator', () => selectBootedSimulator(
  deviceSets,
  (set) => shFile("xcrun", simctlArgs(set, ["list", "devices", "booted"])),
  simulatorUdid,
));
if (!jsonOutput) console.log(`==== booted 模拟器(${deviceSet.name})====`);
if (booted.length === 0) {
  if (!jsonOutput) console.log("  (没有 booted 模拟器)");
  healthy = false;
} else if (!jsonOutput) booted.forEach((l) => console.log("  " + l.trim()));
if (targetBooted.length !== 1) {
  if (!jsonOutput) console.log(`  (需要唯一的已启动目标模拟器；多设备时传 --udid)`);
  healthy = false;
}
const backendNotice = simulatorBackendNotice({
  deviceSet, booted, simulatorUdid,
  listDevices: (set) => shFile("xcrun", simctlArgs(set, ["list", "devices"])),
});
if (backendNotice && !jsonOutput) {
  console.log(`  ⚠️ ${backendNotice.message}`);
  backendNotice.reusable?.forEach((line) => console.log(`    ${line}`));
}

if (!jsonOutput) console.log(`\n==== 模拟器里装的 ${bundleId}(native 安装包版本)====`);
const container = timedCheck('installed-app', () => targetBooted.length === 1 ? getSimulatorAppContainer(shFile, simulatorUdid, bundleId, deviceSet) : "");
let installed = null;
if (!container) {
  if (!jsonOutput) {
    console.log(
      simulatorUdid
        ? `  (目标模拟器 ${simulatorUdid} 未安装 / 未启动)`
        : targetBooted.length === 1 ? "  (未安装)" : "  (没有唯一的目标模拟器，未检查)",
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

const native = timedCheck('native-fingerprint', () => inspectTargetNativeIdentity({
  targetBooted,
  probeFailed: probeErrors.length > 0,
  inspect: () => inspectSimulatorNativeIdentity({
    appPath: container, projectDir: mobileDir,
    env: { ...process.env, ...withLocalMobileRegionConfig(mobileClientBundleEnv({ authRegion: region })) },
  }),
}));
if (!native.healthy) healthy = false;
if (!jsonOutput) {
  console.log(`  native: ${native.code}`);
  if (!native.healthy) {
    if (native.reason === 'target-not-unique') {
      console.log('  未检查原生身份：先确定唯一的已启动目标模拟器，这不代表 App 未安装。');
    } else if (probeErrors.length > 0 || native.reason === 'native-fingerprint-timeout' || native.reason === 'native-fingerprint-unavailable') {
      console.log(`  原生身份检查未完成（${native.reason}）；先修复探测/指纹计算，再决定是否需要 rebuild。`);
    } else {
      const mock = uiMock ? ' --mock' : '';
      console.log(`  请运行 pnpm mobile:sim:rebuild -- --region=${region}${simulatorUdid ? ` --udid ${simulatorUdid}` : ''}${mock}，先查询匹配缓存，再检查原生兼容性。`);
    }
  }
}

if (!jsonOutput) console.log("\n==== Metro 端口归属(哪个端口 = 哪个 worktree)====");
const metro = inspectSimMetroIdentity({
  ports, expectedPort, worktreeRoot, expectedSource, region, envFingerprint,
}, { timedCheck });
const { anyMetro, currentSourceOnExpectedPort, metros } = metro;
probeErrors.push(...metro.probeErrors);
for (const error of metro.probeErrors) {
  console.error(error.stage === "metro-listeners"
    ? `[whoami] ${error.code}；端口归属尚未确认，不能当作没有 Metro。`
    : `[whoami] :${error.port} ${error.stage}: ${error.code}；进程身份检查未完成，请先排查该查询。`);
}
if (!jsonOutput) for (const entry of metros)
  console.log(`  :${entry.port} pid ${entry.pid} → ${entry.worktree || '(unknown)'}: ${entry.identity.code}`);
if (metro.canSuggestStart && !jsonOutput)
  console.log(
    `  (检查的端口上没发现 Metro;用 \`pnpm mobile:sim:start -- --port ${expectedPort}\` 启一个)`,
  );
if (!metro.healthy) healthy = false;

// Devices outside the system set are not shown by Device Hub; Cindy's appear in its sidebar.
const viewerStartedAt = Date.now();
console.error('[whoami] viewer…');
const viewer = deviceSet.path
  ? { available: false, running: false, status: `${deviceSet.name}-managed`, windowVerified: false,
      error: "该设备不在系统模拟器中，没有外部窗口；Cindy 模拟器请在 Cindy 侧边栏查看" }
  : await inspectSimulatorViewer();
checks.push({ stage: 'viewer', elapsedMs: Date.now() - viewerStartedAt });
console.error(`[whoami] viewer: ${Date.now() - viewerStartedAt}ms`);
if (requireViewer && !viewer.running) healthy = false;
if (probeErrors.length > 0) healthy = false;
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
      checks,
      probeErrors,
      elapsedMs: Date.now() - startedAt,
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
      simulatorNotice: backendNotice,
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
