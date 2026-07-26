#!/usr/bin/env node
// 在 iOS 模拟器上重编 + 重装 dev 包。
//
// 何时用:动了原生层(app.json / scheme / 权限 / plugin / 原生模块 / pod)之后。
// 纯 JS/TS 改动**不需要**跑这个 —— Metro 的 Fast Refresh 直接生效。
//
// 为什么不用 `expo run:ios`:Xcode 26.5 上 expo 的 devicectl / 设备解析坏掉,
// xcodebuild 枚举不出具体模拟器,会报
//   `xcodebuild: error: Unable to find a destination matching ... { id:<udid> }`。
// 这里改用 `generic/platform=iOS Simulator` 通用目标编译(不需要枚举具体设备),
// 再用 `simctl` 把产物装到当前 booted 的模拟器。架构交给 Pods/Xcode 决定，
// 避免覆盖原生 SDK 自己声明的 simulator exclusions。
//
// 两个提速机制(2026-07 加,背景:每任务一个新 worktree 的工作流让"从零冷构建"
// 成为高频成本,一次约 12 分钟;外加一次 pod CDN 挂死 20 分钟的事故):
//
// 1. fingerprint 产物缓存:native 产物只由 @expo/fingerprint 的输入决定(与发版
//    "热更 vs 冷更"同一判定口径;ios/ 已 gitignore,按 CNG 语义不参与哈希,因此
//    跨 worktree 稳定)。构建成功后把 .app 按 fingerprint 存进
//    ~/Library/Caches/xdt-maker/sim-app-cache/;下次(常见:新开 worktree 但没动
//    原生层)fingerprint 命中就直接装缓存产物,prebuild / pod / xcodebuild 全部跳过,
//    分钟级变秒级。缓存只保留最近几份,`--force-build` 可强制重新构建。
//    注意 Debug 包不内嵌 JS(运行时连 8081 Metro),EXPO_PUBLIC_* 也在 Metro bundle
//    时注入,所以"native 产物按 fingerprint 复用"对 dev 验证是安全的。
// 2. pod install 有界化:prebuild 改用 --no-install,pod install 由本脚本经
//    sim-pod-install.mjs 自己跑——本地 specs 优先、失败带 --repo-update 重试一次,
//    两次都在**输出空转看门狗**下运行(不是总时长超时:fresh worktree 可能要下
//    ~90MB 的 RN prebuilt 产物,慢网络下合法耗时 20 分钟以上;挂死的特征是"没有
//    任何输出",详见该模块头注)。把"CDN 连接挂死无限等"变成"分钟级失败重试/报错"。
//
// 用法(apps/mobile 下):
//   node scripts/sim-rebuild.mjs                 # 重编并装到 booted 模拟器(保留 app 数据 / 登录态)
//   node scripts/sim-rebuild.mjs --clean         # 先卸载再装(干净登录态测试)
//   node scripts/sim-rebuild.mjs --force-build   # 跳过 fingerprint 产物缓存,强制完整重编
//   node scripts/sim-rebuild.mjs --build-only    # 只构建 + 入产物缓存,不装/不启动模拟器
//                                                #(预热缓存,或模拟器正被别的验证占用时)
// 或仓库根:pnpm mobile:sim:rebuild [-- --region=cn] [-- --clean] [-- --force-build] [-- --build-only]

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mobileClientBuildEnv } from '../../../scripts/shared/client-endpoint-build-env.mjs';
import { ensureMobileEnv, formatMobileEnvStatus } from './ensure-mobile-env.mjs';
import { computeFingerprintReport, parseFingerprintCliOutput } from './ci-fingerprint.mjs';
import {
  extractMobileDevRegionArgs,
  withLocalMobileRegionConfig,
} from './lib/mobile-dev-region.mjs';
import {
  ensureMobileLocalRegionConfig,
  formatMobileLocalConfigStatus,
} from './lib/mobile-local-config.mjs';
import { podInstallBounded } from './sim-pod-install.mjs';
import {
  cwdOfPid,
  gitSourceIdentity,
  gitSourceOfPid,
  isInside,
  listenerPid,
} from './sim-metro.mjs';

const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(mobileDir, '../..');
const iosDir = join(mobileDir, 'ios');
const buildDir = join(iosDir, 'build');
const { region, passthrough } = extractMobileDevRegionArgs(process.argv.slice(2));
const clean = passthrough.includes('--clean');
const forceBuild = passthrough.includes('--force-build');
const buildOnly = passthrough.includes('--build-only');
const localConfigResult = ensureMobileLocalRegionConfig({ mobileDir });
const localConfigStatus = formatMobileLocalConfigStatus(localConfigResult, worktreeRoot);
if (localConfigStatus) console.log(localConfigStatus);
const buildEnv = withLocalMobileRegionConfig(
  mobileClientBuildEnv({ authRegion: region }),
);
const devProcessEnv = { ...process.env, ...buildEnv };

// fingerprint 产物缓存位置与保留份数。跨 worktree 共享;条目按 LRU(目录 mtime)清理。
const appCacheRoot = join(homedir(), 'Library/Caches/xdt-maker/sim-app-cache');
const APP_CACHE_KEEP = 4;
// prune 的最小年龄护栏:mtime 在此窗口内的条目视为"可能正被另一个并发 rebuild
// 读/写",即使排到 LRU 尾部也不删。读方命中时会先 touch mtime、写方最后才写
// meta.json,配合这个窗口,跨 worktree 并发时不会删到正在使用的条目
// (缓存无锁,这是面向单人多 worktree 场景的轻量保护,不追求分布式正确性)。
const APP_CACHE_PRUNE_MIN_AGE_MS = 30 * 60_000;

const envResult = ensureMobileEnv({ mobileDir, authRegion: region, endpointEnv: buildEnv });
console.log(formatMobileEnvStatus(envResult, worktreeRoot));
console.log(`==> Mobile dev region: ${region}`);
const envChanged = envResult.created || envResult.addedKeys.length > 0;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: mobileDir, env: devProcessEnv, ...opts });
const capture = (cmd, args) =>
  execFileSync(cmd, args, { cwd: mobileDir, env: devProcessEnv, encoding: 'utf8' }).trim();

// 必须有一台 booted 模拟器(--build-only 不装机,无此要求)。
if (!buildOnly) {
  const booted = capture('xcrun', ['simctl', 'list', 'devices', 'booted']);
  if (!/\(Booted\)/.test(booted)) {
    console.error('✗ 没有 booted 的模拟器。先打开 Simulator.app 并启动一台 iPhone,再重试。');
    process.exit(1);
  }
}

// 宿主机架构只参与缓存隔离；真实构建架构由 Xcode 与各 Pod 的支持矩阵决定。
const simArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';

// —— fingerprint 产物缓存查询 ——
// 失败(工具异常等)只降级为完整构建,绝不让缓存机制本身挡住构建路径。
// --force-build 也要算哈希:它只跳过缓存"读",构建结果仍写回同一条目,把坏缓存
// 覆盖掉——否则逃生舱跑完一次,坏条目还在,下次普通 rebuild 又命中它。
let fingerprintHash = null;
try {
  console.log('› 计算 native fingerprint(产物缓存键)…');
  fingerprintHash = computeFingerprintReport(mobileDir, {
    platforms: ['ios'],
    run: runFingerprintWithCurrentEnv,
  }).platforms.ios;
} catch (error) {
  console.warn(`  fingerprint 计算失败(${error.message}),回退完整构建(本次不读写产物缓存)。`);
}
const cacheDir = fingerprintHash ? join(appCacheRoot, `ios-${simArch}-${fingerprintHash}`) : null;

let app = null;
if (cacheDir && !forceBuild) {
  const cached = readAppCacheEntry(cacheDir, simArch);
  if (cached) {
    console.log(`✓ fingerprint 命中产物缓存(${fingerprintHash.slice(0, 12)}…),跳过 prebuild / pod / xcodebuild。`);
    console.log('  (改了原生层但怀疑缓存不对时,用 --force-build 强制重编。)');
    utimesSync(cacheDir, new Date(), new Date());
    app = cached;
  }
}

if (!app) {
  // 总是先 prebuild,再 xcodebuild。本脚本是 native 变更的验证路径 —— 若只在 ios/ 缺失时
  // prebuild,那么"改了 app.json / Expo plugins / Pods 但 ios/ 已存在"时会构建到 stale 的
  // native 工程还报成功。prebuild 不带 --clean 是增量的,无 native 改动时很快。
  // --no-install:node modules 由仓库工作流负责,pod install 由下面的 podInstall() 有界执行。
  // pnpm exec:pnpm 不在 apps/mobile/node_modules/.bin 放 expo bin,直接 node 跑会 MODULE_NOT_FOUND。
  console.log('› expo prebuild(把 app.json / plugins / Pods 的 native 改动应用进 ios/,不含 pod install)…');
  run('pnpm', ['exec', 'expo', 'prebuild', '-p', 'ios', '--no-install']);
  console.log('› pod install(本地 specs 优先,输出空转看门狗兜底)…');
  try {
    await podInstallBounded({ iosDir, env: devProcessEnv });
  } catch (error) {
    console.error(`✗ ${error.message}`);
    if (!error.podMissing) {
      console.error('  多为网络/代理问题(CocoaPods CDN / prebuilt 产物源不可达)。检查网络后重试;specs 缓存在 ~/.cocoapods/。');
    }
    process.exit(1);
  }

  const workspace = existsSync(iosDir)
    ? readdirSync(iosDir).find((f) => f.endsWith('.xcworkspace'))
    : undefined;
  if (!workspace) {
    console.error('✗ prebuild 后仍未生成 .xcworkspace,请检查 expo prebuild 输出。');
    process.exit(1);
  }
  const scheme = workspace.replace(/\.xcworkspace$/, '');

  console.log(`› 编译 ${scheme}(generic iOS Simulator destination)…`);
  run('xcodebuild', [
    '-workspace', join(iosDir, workspace),
    '-scheme', scheme,
    '-configuration', 'Debug',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', buildDir,
    '-quiet',
    'build',
  ]);

  app = join(buildDir, 'Build/Products/Debug-iphonesimulator', `${scheme}.app`);
  if (!existsSync(app)) {
    console.error(`✗ 没找到产物 ${app}`);
    process.exit(1);
  }
  if (cacheDir) storeAppCacheEntry(cacheDir, scheme, app, readAppBundleIdentifier(app));
}

assertAppSupportsArchitecture(app, simArch);

// bundle identity 必须从实际产物读:global 的 app.config.js 会把 bundle id
// 切成 com.xd.cindy，不能再用默认 cn 的 app.json 值启动错 app。
const bundleId = readAppBundleIdentifier(app);

if (buildOnly) {
  console.log(`\n✓ --build-only 完成:产物在 ${app}${cacheDir ? '(已入 fingerprint 缓存)' : ''}。未安装到模拟器。`);
  process.exit(0);
}

if (clean) {
  console.log('› --clean:卸载旧包…');
  // uninstall 容错:app 未安装时 simctl 返回非零会让 execFileSync 抛错、后续 install 不执行
  // (首次干净安装就是这个场景)。卸载失败基本只意味着"本来就没装",忽略即可。
  try {
    run('xcrun', ['simctl', 'uninstall', 'booted', bundleId]);
  } catch {
    console.log('  (没有可卸载的旧包,跳过)');
  }
}
console.log('› 安装到 booted 模拟器…');
run('xcrun', ['simctl', 'install', 'booted', app]);

// 启动前校验 8081(app 默认连 8081)。两种情况都会让"装了本分支 native、却加载别处 JS"污染验证:
//   (a) 8081 被别的 worktree 占;(b) 是本 worktree 的 Metro 但没注入当前分支 git env
//       (手动 expo start 起的 / 起后切过分支)。命中则不自动启动,提示用 sim:start 起对的 Metro。
const metroPid = listenerPid(8081);
if (metroPid) {
  const metroCwd = cwdOfPid(metroPid);
  const foreign = !metroCwd || !isInside(worktreeRoot, metroCwd);
  const currentSource = gitSourceIdentity(worktreeRoot);
  const runningSource = gitSourceOfPid(metroPid);
  if (foreign || runningSource !== currentSource) {
    const why = foreign
      ? `属于别的 worktree(${metroCwd || '未知'})`
      : `源码指纹已过期(运行中=${runningSource || '无'} ≠ 当前=${currentSource})`;
    console.log(`\n✓ native 包已安装(${bundleId})。`);
    console.error(`⚠️ 未自动启动:8081 上的 Metro ${why}。`);
    console.error('   直接启动会让 app 加载错分支的 JS(native 是本分支、JS 不是)。');
    console.error('   先停掉它、再 `pnpm mobile:sim:start`(起本 worktree 当前分支的 8081 Metro),然后启动 app。');
    process.exit(0);
  }
  if (envChanged) {
    console.log(`\n✓ native 包已安装(${bundleId})。`);
    console.error('⚠️ 未自动启动:已补/改 apps/mobile/.env,但 8081 上的 Metro 是用旧 env 启动的(env 在 bundle 时注入)。');
    console.error('   先停掉它再 `pnpm mobile:sim:start`(用新 env 起 Metro),然后启动 app,新 env 才生效。');
    process.exit(0);
  }
}
console.log('› 启动…');
run('xcrun', ['simctl', 'launch', 'booted', bundleId]);
console.log(`\n✓ 完成。${bundleId} 已重装并启动。改 JS 直接靠 Metro Fast Refresh,不用再跑本脚本。`);

/**
 * 用**当前环境**跑 @expo/fingerprint。不能用 ci-fingerprint 默认 runner:它是
 * production 口径,会剥离全部 EXPO_PUBLIC_*;而本脚本后面的 expo prebuild 继承
 * 当前环境(app.config.js 在 EXPO_PUBLIC_APP_VARIANT==='beta' 时会改原生 name),
 * 缓存键必须跟着同一份 env 算,否则 beta / production 变体会命中彼此的产物。
 */
function runFingerprintWithCurrentEnv({ binPath, projectDir, platform }) {
  const result = spawnSync(process.execPath, [binPath, 'fingerprint:generate', '--platform', platform], {
    cwd: resolve(projectDir),
    env: devProcessEnv,
    encoding: 'utf8',
    // 输出含全部 sources(>1MB),必须调大 maxBuffer(与 ci-fingerprint 同款)。
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`fingerprint:generate --platform ${platform} failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  }
  return parseFingerprintCliOutput(result.stdout);
}

/** 读产物缓存条目;结构不完整(半份缓存)时视为未命中。 */
function readAppCacheEntry(dir, expectedArch) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    if (typeof meta.scheme !== 'string' || !meta.scheme) return null;
    const cachedApp = join(dir, `${meta.scheme}.app`);
    if (!existsSync(cachedApp)) return null;
    const architectures = readAppArchitectures(cachedApp);
    if (!architectures.includes(expectedArch)) {
      console.warn(
        `  缓存产物架构不匹配(实际=${architectures.join(',') || '未知'},当前 Simulator 需要=${expectedArch}),忽略并重新构建。`,
      );
      return null;
    }
    return cachedApp;
  } catch {
    return null;
  }
}

/**
 * 把构建产物 .app 存进 fingerprint 缓存。先写 .app 再写 meta.json(meta 是条目
 * 完整性的标记,readAppCacheEntry 缺 meta 即未命中,天然规避半份缓存),最后按
 * LRU 清理只留最近 APP_CACHE_KEEP 份。缓存写失败不影响本次构建结果。
 */
function storeAppCacheEntry(dir, scheme, builtApp, builtBundleId) {
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    cpSync(builtApp, join(dir, `${scheme}.app`), { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify({
      scheme,
      bundleId: builtBundleId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
    pruneAppCache();
    console.log(`› 产物已入 fingerprint 缓存(下次未动原生层的 worktree 可直接复用)。`);
  } catch (error) {
    console.warn(`  产物缓存写入失败(${error.message}),忽略。`);
  }
}

/** 从已构建 .app 的 Info.plist 读取真实 bundle identity。 */
function readAppBundleIdentifier(appPath) {
  return readAppInfoValue(appPath, 'CFBundleIdentifier');
}

/** 读取 .app 可执行文件实际包含的 Mach-O 架构。 */
function readAppArchitectures(appPath) {
  const executableName = readAppInfoValue(appPath, 'CFBundleExecutable');
  return capture('lipo', ['-archs', join(appPath, executableName)])
    .split(/\s+/)
    .filter(Boolean);
}

/** 产物架构不匹配时在安装前失败，避免把 IXUserPresentableErrorDomain 丢给用户。 */
function assertAppSupportsArchitecture(appPath, expectedArch) {
  const architectures = readAppArchitectures(appPath);
  if (architectures.includes(expectedArch)) return;
  throw new Error(
    `Simulator 产物架构错误:实际=${architectures.join(',') || '未知'},期望=${expectedArch};请检查排除 arm64 的 native pod。`,
  );
}

/** 从已构建 .app 的 Info.plist 读取单个原生配置值。 */
function readAppInfoValue(appPath, key) {
  return capture('plutil', [
    '-extract',
    key,
    'raw',
    '-o',
    '-',
    join(appPath, 'Info.plist'),
  ]);
}

/** 按目录 mtime 保留最近 APP_CACHE_KEEP 份;更旧的里只删超过最小年龄的(见常量注释)。 */
function pruneAppCache() {
  const entries = readdirSync(appCacheRoot)
    .map((name) => {
      const dir = join(appCacheRoot, name);
      try {
        const stat = statSync(dir);
        return stat.isDirectory() ? { dir, mtimeMs: stat.mtimeMs } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries.slice(APP_CACHE_KEEP)) {
    if (Date.now() - entry.mtimeMs < APP_CACHE_PRUNE_MIN_AGE_MS) continue;
    rmSync(entry.dir, { recursive: true, force: true });
  }
}
