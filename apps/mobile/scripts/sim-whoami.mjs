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
//   pnpm mobile:sim:whoami                     # cn(默认)
//   pnpm mobile:sim:whoami -- --region=global # global
//   pnpm mobile:sim:whoami -- --port 8082      # 已手动连接到显式 Metro 端口

import { execFileSync, execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractMobileDevRegionArgs } from "./lib/mobile-dev-region.mjs";
import {
  ensureMobileLocalRegionConfig,
  formatMobileLocalConfigStatus,
} from "./lib/mobile-local-config.mjs";
import {
  bootedSimulatorLinesForTarget,
  extractSimMetroPortArgs,
  extractSimWhoamiUdidArgs,
  getSimulatorAppContainer,
  resolveMobileSimulatorBundleId,
} from "./lib/sim-whoami.mjs";
import {
  cwdOfPid,
  gitSourceIdentity,
  gitSourceOfPid,
  isInside,
} from "./sim-metro.mjs";

const PORTS = [8081, 8082, 8083, 8084, 8085, 8086];
const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worktreeRoot = resolve(mobileDir, "../..");

/** 解析用户指定的 region 及其实际 Simulator bundle id。 */
const jsonOutput = process.argv.slice(2).includes("--json");

function resolveTarget() {
  const { region, passthrough } = extractMobileDevRegionArgs(
    process.argv.slice(2).filter((arg) => arg !== "--json"),
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
  };
}

let target;
try {
  const localConfigResult = ensureMobileLocalRegionConfig({ mobileDir });
  const localConfigStatus = formatMobileLocalConfigStatus(
    localConfigResult,
    worktreeRoot,
  );
  if (localConfigStatus) console.log(localConfigStatus);
  target = resolveTarget();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const { region, port: expectedPort, simulatorUdid, bundleId } = target;
const ports = [...new Set([...PORTS, expectedPort])].sort((a, b) => a - b);
const expectedSource = gitSourceIdentity(worktreeRoot);
let healthy = true;

function sh(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

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

console.log(`==> Mobile dev region: ${region}`);
console.log("==== booted 模拟器 ====");
const allBooted = sh("xcrun simctl list devices booted").split("\n");
const booted = bootedSimulatorLinesForTarget(allBooted, null);
const targetBooted = bootedSimulatorLinesForTarget(allBooted, simulatorUdid);
if (booted.length === 0) {
  console.log("  (没有 booted 模拟器)");
  healthy = false;
} else booted.forEach((l) => console.log("  " + l.trim()));
if (simulatorUdid && targetBooted.length === 0) {
  console.log(`  (目标模拟器 ${simulatorUdid} 未启动)`);
  healthy = false;
}

console.log(`\n==== 模拟器里装的 ${bundleId}(native 安装包版本)====`);
const container = getSimulatorAppContainer(shFile, simulatorUdid, bundleId);
if (!container) {
  console.log(
    simulatorUdid
      ? `  (目标模拟器 ${simulatorUdid} 未安装 / 未启动)`
      : "  (未安装 / 无 booted 设备)",
  );
  healthy = false;
} else {
  const plist = `${container}/Info.plist`;
  const pb = (key) =>
    shFile("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
  console.log("  version    :", pb("CFBundleShortVersionString"));
  console.log("  buildNumber:", pb("CFBundleVersion"));
  console.log(
    "  ⚠️ 版本号只证明装的是哪个 dev client,证明不了 JS bundle 是不是当前分支最新。",
  );
}

console.log("\n==== Metro 端口归属(哪个端口 = 哪个 worktree)====");
let anyMetro = false;
let currentSourceOnExpectedPort = false;
for (const port of ports) {
  const pids = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`)
    .split("\n")
    .filter(Boolean);
  for (const pid of pids) {
    const cwd = cwdOfPid(pid);
    // Metro 由 sim:start 以 cwd=<worktree>/apps/mobile 启动,故进程 cwd 即 worktree 位置。
    const wt = cwd ? cwd.replace(/\/apps\/mobile$/, "") : "(无法读取进程 cwd)";
    const isMetro = /expo|metro/i.test(sh(`ps -p ${pid} -o command=`));
    const runningSource = isMetro ? gitSourceOfPid(pid) : null;
    if (isMetro) anyMetro = true;
    console.log(
      `  :${port}  pid ${pid}  →  ${wt}${runningSource ? `  source=${runningSource}` : isMetro ? "  source=(未注入)" : "  (非 Metro?)"}`,
    );
    if (port === expectedPort && isMetro) {
      currentSourceOnExpectedPort = Boolean(
        cwd && isInside(worktreeRoot, cwd) && runningSource === expectedSource,
      );
      if (!currentSourceOnExpectedPort) healthy = false;
    }
  }
}
if (!anyMetro)
  console.log(
    `  (检查的端口上没发现 Metro;用 \`pnpm mobile:sim:start -- --port ${expectedPort}\` 启一个)`,
  );
if (!currentSourceOnExpectedPort) healthy = false;

console.log(`\n当前 worktree 源码指纹:${expectedSource}`);
console.log(
  `build label 必须显示这个指纹,且 host:port 必须是当前 worktree 的 ${expectedPort}。`,
);
if (healthy) {
  console.log(
    `✓ PASS:booted dev client、${expectedPort} Metro 归属和源码指纹一致。`,
  );
} else {
  console.error(
    "✗ FAIL:当前模拟器验证链不完整或源码不一致;不要声称“已经启动当前版本”。",
  );
  process.exitCode = 1;
}

if (jsonOutput) {
  console.log(
    JSON.stringify({
      healthy,
      region,
      expectedPort,
      expectedSource,
      currentSourceOnExpectedPort,
      anyMetro,
      bootedCount: booted.length,
      targetSimulatorUdid: simulatorUdid,
      targetBooted: targetBooted.length === 1,
      bundleId,
    }),
  );
}
