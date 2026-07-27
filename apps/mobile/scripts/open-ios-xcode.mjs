#!/usr/bin/env node
// 按所选 region(默认 global)读取 self-host-regions.json,重新生成 iOS 原生工程、安装 Pods，
// 然后打开 app 的 .xcworkspace。
// 这是本地开发入口：不 archive、不上传 NPKG/OSS，也不写任何发版记录。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { podInstallBounded } from './sim-pod-install.mjs';
import { cwdOfPid, isInside, listenerPid, portInUse } from './sim-metro.mjs';
import { withLocalMobileRegionConfig } from './lib/mobile-dev-region.mjs';
import {
  mobileXcodeGeneratedDir,
  parseMobileXcodeArgs,
  selectMobileXcodeWorkspace,
  updateMobileXcodeEnvContent,
} from './lib/mobile-xcode.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(mobileDir, '../..');
const iosDir = resolve(mobileDir, 'ios');
const envPath = resolve(mobileDir, '.env');
const simStartPath = resolve(mobileDir, 'scripts/sim-start.mjs');
const metroPort = 8081;

function printUsage() {
  console.log(`用法:
  pnpm mobile:xcode                   # Cindy(Global,默认)
  pnpm mobile:xcode --region=cn       # 中国大陆版

流程:读取 self-host-regions.json → 切换 apps/mobile/.env 地区 → clean prebuild → 安装 Pods → 打开 Xcode → 启动 Metro
说明:只准备本地 Xcode 工程，不会上传或发布。`);
}

async function main() {
  const args = parseMobileXcodeArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('mobile:xcode 只能在安装了 Xcode 的 macOS 上运行');
  }

  const buildEnv = withLocalMobileRegionConfig(
    mobileClientBuildEnv({ authRegion: args.region }),
  );
  const env = { ...process.env, ...buildEnv };
  const previousEnv = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const nextEnv = updateMobileXcodeEnvContent(previousEnv, buildEnv);
  const envChanged = nextEnv !== previousEnv;

  // 已运行的 Metro 会把 EXPO_PUBLIC_* 固化在它生成的 JS bundle 中。切 region 时不能
  // 静默复用旧进程，否则 native 工程虽已切到 global/cn，JS 仍会走上一个地区。
  if (await portInUse(metroPort)) {
    const pid = listenerPid(metroPort);
    const ownerCwd = pid ? cwdOfPid(pid) : null;
    if (!ownerCwd || !isInside(worktreeRoot, ownerCwd)) {
      throw new Error(
        `${metroPort} 端口被其它 checkout/process 占用(${ownerCwd || '未知进程'})；请先停止它再重试`,
      );
    }
    if (envChanged) {
      throw new Error(
        `检测到 region/env 将变化，但 ${metroPort} 上已有本 checkout 的 Metro；请先停止旧 Metro 再重试，避免 native 与 JS 地区错配`,
      );
    }
  }
  if (nextEnv !== previousEnv) writeFileSync(envPath, nextEnv);

  const builtInBundleId = {
    cn: 'com.xd.cindycn',
    global: 'com.xd.cindy',
    dev: 'com.xd.cindydev',
  }[args.region];
  const editionLabel = {
    cn: '中国大陆版',
    global: 'Cindy',
    dev: 'CindyDev',
  }[args.region];
  console.log(`\n› 准备 Cindy iOS Xcode 工程(region=${args.region})`);
  console.log(`  bundle: ${builtInBundleId}`);
  console.log(`  已同步 apps/mobile/.env；原生构建与 Metro 将读取 self-host-regions.json 的 ${args.region}。`);
  console.log('› clean prebuild(重新生成 ios/，避免沿用另一地区的 bundle/scheme)…');
  execFileSync('pnpm', ['exec', 'expo', 'prebuild', '-p', 'ios', '--clean', '--no-install'], {
    cwd: mobileDir,
    env,
    stdio: 'inherit',
  });

  console.log('› pod install(本地 specs 优先，输出空转看门狗兜底)…');
  await podInstallBounded({ iosDir, env });

  const workspace = selectMobileXcodeWorkspace(iosDir, readdirSync(iosDir));
  console.log(`› 打开 ${workspace}`);
  execFileSync('open', ['-a', 'Xcode', workspace], { cwd: mobileDir, stdio: 'inherit' });
  console.log(`\n✓ ${editionLabel} Xcode 工程已生成并打开。`);
  console.log(`  工程目录: ${mobileXcodeGeneratedDir(workspace)}`);
  console.log(`› 启动 Metro(${metroPort})；请保持当前终端开启，在 Xcode 选择设备后点击 Run。`);
  execFileSync(process.execPath, [simStartPath, `--region=${args.region}`], {
    cwd: worktreeRoot,
    env,
    stdio: 'inherit',
  });
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
