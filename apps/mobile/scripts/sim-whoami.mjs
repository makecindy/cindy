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

if (!jsonOutput) {
  console.log(`==> Mobile dev region: ${region}`);
  console.log("==== booted 模拟器 ====");
}
const allBooted = sh("xcrun simctl list devices booted").split("\n");
const booted = bootedSimulatorLinesForTarget(allBooted, null);
const targetBooted = bootedSimulatorLinesForTarget(allBooted, simulatorUdid);
if (booted.length === 0) {
  if (!jsonOutput) console.log("  (没有 booted 模拟器)");
  healthy = false;
} else if (!jsonOutput) booted.forEach((l) => console.log("  " + l.trim()));
if (simulatorUdid && targetBooted.length === 0) {
  if (!jsonOutput) console.log(`  (目标模拟器 ${simulatorUdid} 未启动)`);
  healthy = false;
}

if (!jsonOutput) console.log(`\n==== 模拟器里装的 ${bundleId}(native 安装包版本)====`);
const container = getSimulatorAppContainer(shFile, simulatorUdid, bundleId);
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

if (!jsonOutput) console.log("\n==== Metro 端口归属(哪个端口 = 哪个 worktree)====");
let anyMetro = false;
let currentSourceOnExpectedPort = false;
const metros = [];
for (const port of ports) {
  const pids = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`)
    .split("\n")
    .filter(Boolean);
  for (const pid of pids) {
    const cwd = cwdOfPid(pid);
    const worktree = cwd ? cwd.replace(/\/apps\/mobile$/, "") : null;
    const isMetro = /expo|metro/i.test(sh(`ps -p ${pid} -o command=`));
    const runningSource = isMetro ? gitSourceOfPid(pid) : null;
    if (isMetro) anyMetro = true;
    metros.push({
      port,
      pid: Number(pid),
      cwd: cwd ?? null,
      worktree,
      isMetro,
      source: runningSource,
    });
    if (!jsonOutput) {
      console.log(
        `  :${port}  pid ${pid}  →  ${worktree || "(无法读取进程 cwd)"}${runningSource ? `  source=${runningSource}` : isMetro ? "  source=(未注入)" : "  (非 Metro?)"}`,
      );
    }
    if (port === expectedPort && isMetro) {
      currentSourceOnExpectedPort ||= Boolean(
        cwd && isInside(worktreeRoot, cwd) && runningSource === expectedSource,
      );
    }
  }
}
if (!anyMetro && !jsonOutput)
  console.log(
    `  (检查的端口上没发现 Metro;用 \`pnpm mobile:sim:start -- --port ${expectedPort}\` 启一个)`,
  );
if (!currentSourceOnExpectedPort) healthy = false;

if (!jsonOutput) {
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
  }
} else {
  console.log(
    JSON.stringify({
      healthy,
      region,
      bundleId,
      worktree: worktreeRoot,
      source: expectedSource,
      expectedSource,
      expectedPort,
      currentSourceOnExpectedPort,
      anyMetro,
      booted: booted.map((line) => line.trim()),
      installed,
      metros,
      targetSimulatorUdid: simulatorUdid,
      targetBooted: simulatorUdid ? targetBooted.length === 1 : null,
    }),
  );
}

if (!healthy) process.exitCode = 1;
