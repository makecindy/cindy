#!/usr/bin/env node
// "我现在看到的到底是哪一版?" 的终端体检。一次性打印:
//   1) 当前 booted 模拟器
//   2) 所选 region 的实际 bundle id 与已安装 native development client 版本
//   3) 常用端口及显式指定端口上的 Metro 分别属于哪个 worktree
//
// bundle id 不在本脚本硬编码:它用与 sim:start / sim:rebuild 相同的 region + 本地
// self-host-regions.json 环境解析 Expo config,确保 cn/global 与后续身份迁移自动同步。
// 注意:native 版本号只证明安装包,证明不了 JS bundle 是不是当前分支最新——JS 要看连的是哪个
// worktree 的 Metro(配合模拟器里的 __DEV__ build label)。
//
// 用法:
//   pnpm mobile:sim:whoami                     # Global(默认)
//   pnpm mobile:sim:whoami -- --region=cn      # 中国大陆版
//   pnpm mobile:sim:whoami -- --json           # Skill 可消费的结构化状态
//   pnpm mobile:sim:whoami -- --port 8082      # 已手动连接到显式 Metro 端口

import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMobileDevRegionArgs } from './lib/mobile-dev-region.mjs';
import {
  ensureMobileLocalRegionConfig,
  formatMobileLocalConfigStatus,
} from './lib/mobile-local-config.mjs';
import {
  extractSimJsonArgs,
  extractSimMetroPortArgs,
  resolveMobileSimulatorBundleId,
} from './lib/sim-whoami.mjs';
import {
  cwdOfPid,
  gitSourceIdentity,
  gitSourceOfPid,
  isInside,
} from './sim-metro.mjs';

const PORTS = [8081, 8082, 8083, 8084, 8085, 8086];
const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(mobileDir, '../..');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function shFile(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function parseArgs() {
  const rawArgs = process.argv.slice(2);
  const requestedJson = rawArgs.includes('--json');
  try {
    const { region, passthrough: regionPassthrough } = extractMobileDevRegionArgs(rawArgs);
    const { json, passthrough } = extractSimJsonArgs(regionPassthrough);
    const portArgs = extractSimMetroPortArgs(passthrough);
    if (portArgs.passthrough.length > 0) {
      throw new Error(`mobile:sim:whoami 不支持参数: ${portArgs.passthrough.join(' ')}`);
    }
    return { region, json, port: portArgs.port };
  } catch (error) {
    error.requestedJson = requestedJson;
    throw error;
  }
}

let args;
try {
  args = parseArgs();
  const localConfigResult = ensureMobileLocalRegionConfig({ mobileDir });
  if (!args.json) {
    const localConfigStatus = formatMobileLocalConfigStatus(localConfigResult, worktreeRoot);
    if (localConfigStatus) console.log(localConfigStatus);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error?.requestedJson ? JSON.stringify({ healthy: false, error: message }) : `✗ ${message}`);
  process.exit(1);
}

const { region, json, port: expectedPort } = args;
let bundleId;
try {
  bundleId = resolveMobileSimulatorBundleId(region);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(json ? JSON.stringify({ healthy: false, region, error: message }) : `✗ ${message}`);
  process.exit(1);
}

const ports = [...new Set([...PORTS, expectedPort])].sort((a, b) => a - b);
const expectedSource = gitSourceIdentity(worktreeRoot);
const bootedLines = sh('xcrun simctl list devices booted').split('\n').filter((line) => /\(Booted\)/.test(line));
const container = shFile('xcrun', ['simctl', 'get_app_container', 'booted', bundleId, 'app']);
const installed = container ? {
  version: shFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', `${container}/Info.plist`]),
  buildNumber: shFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', `${container}/Info.plist`]),
} : null;
const metros = [];
let currentSourceOnExpectedPort = false;
for (const currentPort of ports) {
  const pids = sh(`lsof -nP -iTCP:${currentPort} -sTCP:LISTEN -t`).split('\n').filter(Boolean);
  for (const pid of pids) {
    const cwd = cwdOfPid(pid);
    const command = sh(`ps -p ${pid} -o command=`);
    const isMetro = /expo|metro/i.test(command);
    const runningSource = isMetro ? gitSourceOfPid(pid) : null;
    const metro = {
      port: currentPort,
      pid: Number(pid),
      cwd: cwd ?? null,
      worktree: cwd ? cwd.replace(/\/apps\/mobile$/, '') : null,
      isMetro,
      source: runningSource,
    };
    metros.push(metro);
    if (currentPort === expectedPort && isMetro) {
      currentSourceOnExpectedPort ||= Boolean(
        cwd && isInside(worktreeRoot, cwd) && runningSource === expectedSource,
      );
    }
  }
}

const state = {
  healthy: bootedLines.length > 0 && Boolean(installed) && currentSourceOnExpectedPort,
  region,
  bundleId,
  worktree: worktreeRoot,
  source: expectedSource,
  expectedPort,
  booted: bootedLines.map((line) => line.trim()),
  installed,
  metros,
};

if (json) {
  console.log(JSON.stringify(state));
} else {
  console.log(`==> Mobile dev region: ${region}`);
  console.log('==== booted 模拟器 ====');
  if (bootedLines.length === 0) console.log('  (没有 booted 模拟器)');
  else bootedLines.forEach((line) => console.log(`  ${line.trim()}`));

  console.log(`\n==== 模拟器里装的 ${bundleId}(native 安装包版本)====`);
  if (!installed) {
    console.log('  (未安装 / 无 booted 设备)');
  } else {
    console.log('  version    :', installed.version);
    console.log('  buildNumber:', installed.buildNumber);
    console.log('  ⚠️ 版本号只证明装的是哪个 dev client,证明不了 JS bundle 是不是当前分支最新。');
  }

  console.log('\n==== Metro 端口归属(哪个端口 = 哪个 worktree)====');
  if (metros.length === 0) {
    console.log(`  (检查的端口上没发现 Metro;用 \`pnpm mobile:sim:start -- --port ${expectedPort}\` 启一个)`);
  } else {
    metros.forEach((metro) => console.log(
      `  :${metro.port}  pid ${metro.pid}  →  ${metro.worktree || '(无法读取进程 cwd)'}${metro.source ? `  source=${metro.source}` : metro.isMetro ? '  source=(未注入)' : '  (非 Metro?)'}`,
    ));
  }

  console.log(`\n当前 worktree 源码指纹:${expectedSource}`);
  console.log(`build label 必须显示这个指纹,且 host:port 必须是当前 worktree 的 ${expectedPort}。`);
  if (state.healthy) console.log(`✓ PASS:booted dev client、${expectedPort} Metro 归属和源码指纹一致。`);
  else {
    console.error('✗ FAIL:当前模拟器验证链不完整或源码不一致;不要声称“已经启动当前版本”。');
    process.exitCode = 1;
  }
}

if (!state.healthy) process.exitCode = 1;
