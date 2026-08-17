#!/usr/bin/env node
/**
 * ensure-deps — 启动/构建/发布前的依赖守护
 *
 * 四道检查（任一失败都会自动修复）：
 *   1. Lockfile 同步性 — 比对 pnpm-lock.yaml 与 node_modules/.modules.yaml 的 mtime
 *   2. 关键依赖完整性 — 确认 workspace / native / binary 依赖的 package.json 存在
 *   3. Electron binary 完整性 — 确认 electron postinstall 已完整解出 dist binary
 *   4. native ABI 隔离 — root 保持 Node ABI，Electron cache 单独准备 native binding
 *
 * 关于 hoisted 模式：项目 .npmrc 指定 node-linker=hoisted，绝大多数依赖被平铺到根
 * node_modules，但原生二进制包（electron、protobufjs 等）必须留
 * 在子包 node_modules 下。如果这些子包目录只剩 postinstall 产物（例如
 * apps/desktop/node_modules/electron 只剩 dist/ 而缺 package.json），pnpm install
 * 甚至 --force 都会认为目录存在而跳过——必须先物理删除再重装，才能让 pnpm 重建。
 *
 * 关于 Electron binary 完整性：`node_modules/electron/package.json` 存在不代表
 * Electron 安装完整。已观察到 Node 24.16.0 + extract-zip@2.0.1 / yauzl@2.10.0
 * 解 Electron 41 win32 zip 时在 Windows 上静默半解压：electron postinstall 没
 * 报错，pnpm 也认为成功，但 node_modules/electron/dist 里缺 electron.exe。因
 * 此这里必须按 Electron install.js 语义同时校验 dist/version、path.txt 和实际
 * 平台 binary，不能只看 package.json。
 *
 * 关于 native ABI：root better-sqlite3 必须保持纯 Node/Vitest 可加载；Electron
 * 需要单独 ABI。这里把 Electron 产物保留到 node_modules/.xdt-electron-native；
 * 若 electron-rebuild 临时回写 root，脚本会立即恢复 root Node ABI，避免
 * 启动/构建守护脚本和 Node 测试互相踩 ABI。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { resolvePnpmInvocation, usablePnpmExecPath } from './shared/pnpm-invocation.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY_FILE = fileURLToPath(import.meta.url);
const log = (msg) => console.log(`\x1b[36m[ensure-deps]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[ensure-deps]\x1b[0m ${msg}`);
const err = (msg) => console.error(`\x1b[31m[ensure-deps]\x1b[0m ${msg}`);

// 关键依赖清单 —— 损坏会直接让 dev/release 挂掉
// checkPath 是相对仓库根目录的 package.json 位置
// pnpm 10 的 hoisted 模式下，这些核心包都 hoist 到根 node_modules（包括 electron）
const CRITICAL_DEPS = [
  {
    name: '@cindy/device-link-protocol',
    checkPath: 'packages/device-link/node_modules/@cindy/device-link-protocol/package.json',
  },
  {
    name: '@cindy/slack-hook-protocol',
    checkPath: 'apps/desktop/node_modules/@cindy/slack-hook-protocol/package.json',
  },
  { name: 'electron', checkPath: 'node_modules/electron/package.json' },
  { name: 'better-sqlite3', checkPath: 'node_modules/better-sqlite3/package.json' },
];

const WORKSPACE_CRITICAL_DEPS = CRITICAL_DEPS.slice(0, 2);
// 子包下的残缺目录 —— 这些本不该存在于子包 node_modules（pnpm 10 会 hoist 到根），
// 但某些 postinstall 残留（例如 electron postinstall 解压的 dist/）可能会让这些路径
// 看起来"存在"。Node.js 的 require 解析会卡在残缺目录（有路径但没 package.json）
// 无法 fallback 到根，导致 electron-forge 这类硬依赖子包路径的工具直接崩溃。
// 策略：若目录存在但没 package.json，物理铲除，让 Node.js 正常 fallback 到根 hoisted 版本。
const STALE_SUBPKG_DIRS = [
  'apps/desktop/node_modules/electron',
];

export function getElectronPlatformBinaryRelPath(platform = process.platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin' || platform === 'mas') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

function getElectronDir(root = ROOT) {
  return path.join(root, 'node_modules', 'electron');
}

function getElectronDistBinaryPath(root = ROOT, platform = process.platform) {
  const relPath = getElectronPlatformBinaryRelPath(platform);
  return path.join(getElectronDir(root), 'dist', ...relPath.split('/'));
}

function readElectronPackageVersion(electronDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

export function findElectronBinaryIssue(root = ROOT, platform = process.platform) {
  const electronDir = getElectronDir(root);
  const packageJson = path.join(electronDir, 'package.json');
  if (!fs.existsSync(packageJson)) return null;

  // package.json 只证明 npm package 解出来了，不证明 Electron postinstall 解
  // dist 成功。Windows + Node 24.16.0 上见过 postinstall 静默半解压，最后
  // 留下有 package.json / path.txt 但缺 electron.exe 的坏安装。
  const expectedRelPath = getElectronPlatformBinaryRelPath(platform);
  const expectedVersion = readElectronPackageVersion(electronDir);
  const pathTxt = path.join(electronDir, 'path.txt');
  const versionPath = path.join(electronDir, 'dist', 'version');
  const binaryPath = getElectronDistBinaryPath(root, platform);

  if (expectedVersion) {
    if (!fs.existsSync(versionPath)) {
      return {
        reason: 'version-missing',
        expectedVersion,
        missingPath: versionPath,
        pathTxt,
        binaryPath,
        versionPath,
      };
    }

    const actualVersion = fs.readFileSync(versionPath, 'utf8').trim().replace(/^v/, '');
    if (actualVersion !== expectedVersion) {
      return {
        reason: 'version-mismatch',
        expectedVersion,
        actualVersion,
        missingPath: versionPath,
        pathTxt,
        binaryPath,
        versionPath,
      };
    }
  }

  if (!fs.existsSync(pathTxt)) {
    return {
      reason: 'path-txt-missing',
      expectedRelPath,
      missingPath: pathTxt,
      pathTxt,
      binaryPath,
    };
  }

  const actualRelPath = fs.readFileSync(pathTxt, 'utf8').trim();
  if (actualRelPath !== expectedRelPath) {
    return {
      reason: 'path-txt-mismatch',
      expectedRelPath,
      actualRelPath,
      missingPath: pathTxt,
      pathTxt,
      binaryPath,
    };
  }

  if (!fs.existsSync(binaryPath)) {
    return {
      reason: 'binary-missing',
      expectedRelPath,
      missingPath: binaryPath,
      pathTxt,
      binaryPath,
    };
  }

  return null;
}

function getNodeMajor(nodeVersion = process.versions.node) {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : 0;
}

export function getElectronRepairMode(platform = process.platform, nodeVersion = process.versions.node) {
  if (platform === 'win32' && getNodeMajor(nodeVersion) >= 24) return 'system-tar';
  return 'install-js';
}

function describeElectronBinaryIssue(issue, root = ROOT) {
  const relMissing = path.relative(root, issue.missingPath);
  if (issue.reason === 'version-missing') {
    return `缺少 ${relMissing}`;
  }
  if (issue.reason === 'version-mismatch') {
    return `dist/version 是 ${JSON.stringify(issue.actualVersion)}，预期 ${issue.expectedVersion}`;
  }
  if (issue.reason === 'path-txt-missing') {
    return `缺少 ${relMissing}`;
  }
  if (issue.reason === 'path-txt-mismatch') {
    return `path.txt 指向 ${issue.actualRelPath}，预期 ${issue.expectedRelPath}`;
  }
  return `缺少 ${relMissing}`;
}

function reasonLockfileOutOfSync() {
  const lockFile = path.join(ROOT, 'pnpm-lock.yaml');
  const modulesYaml = path.join(ROOT, 'node_modules', '.modules.yaml');
  if (!fs.existsSync(modulesYaml)) return 'node_modules/.modules.yaml 不存在，首次安装';
  if (!fs.existsSync(lockFile)) return null;
  const lockMtime = fs.statSync(lockFile).mtimeMs;
  const modulesMtime = fs.statSync(modulesYaml).mtimeMs;
  if (lockMtime > modulesMtime) {
    return `pnpm-lock.yaml (${new Date(lockMtime).toLocaleString()}) 比 node_modules 新`;
  }
  return null;
}

const NODE_MODULES_DIRS = [
  path.join(ROOT, 'node_modules'),
  path.join(ROOT, 'apps', 'desktop', 'node_modules'),
];

function findBrokenDeps(deps = CRITICAL_DEPS) {
  const broken = [];
  for (const { name, checkPath } of deps) {
    const abs = path.join(ROOT, checkPath);
    if (!fs.existsSync(abs)) {
      // 推断模块根目录（package.json 的上级）用于 remediate 时精准清理
      const moduleDir = path.dirname(abs);
      broken.push({ name, checkPath, moduleDir });
    }
  }
  return broken;
}

function ensureWorkspaceOnlyDependencies() {
  const broken = findBrokenDeps(WORKSPACE_CRITICAL_DEPS);
  const lockIssue = reasonLockfileOutOfSync();
  if (broken.length === 0 && !lockIssue) {
    log('workspace 依赖已同步，跳过');
    return;
  }

  if (broken.length > 0) {
    warn(`workspace 依赖缺失：${broken.map((item) => item.name).join(', ')}`);
    removeBrokenDirs(broken);
  }
  if (lockIssue) log(lockIssue);
  runInstall(['install']);

  const still = findBrokenDeps(WORKSPACE_CRITICAL_DEPS);
  if (still.length > 0) {
    err(`pnpm install 后 workspace 依赖仍缺失：${still.map((item) => item.name).join(', ')}`);
    process.exit(1);
  }
  log('workspace 依赖已同步');
}

function runInstall(args = ['install']) {
  const invocation = resolvePnpmInstallInvocation(args);
  log(`运行 ${invocation.displayCommand} ...`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...createElectronInstallEnv(), ...(invocation.env ?? {}) },
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error || result.status !== 0) {
    if (result.error) err(result.error.message);
    err(`${invocation.displayCommand} 失败`);
    // frozen-lockfile 模式下，改了依赖声明（package.json）却没更新 lock 会让 install
    // 直接失败。给出针对性指引，避免把 frozen 失败误当成环境 / 网络问题。
    if (isFrozenLockfileEnabled()) {
      warn('提示：.npmrc 已启用 frozen-lockfile。若你刚改过依赖（package.json），lock 不会自动更新。');
      warn('      请改用 pnpm add <pkg> / pnpm remove <pkg>，或先 pnpm install --no-frozen-lockfile 再重试。');
    }
    process.exit(1);
  }
  log('依赖同步完成');
}

function createElectronInstallEnv() {
  return {
    ...process.env,
    COREPACK_ENABLE: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    SHARP_IGNORE_GLOBAL_LIBVIPS: process.env.SHARP_IGNORE_GLOBAL_LIBVIPS ?? '1',
  };
}

export function resolvePnpmInstallInvocation(args, env = process.env, exists = fs.existsSync, options = {}) {
  // npm_execpath 只保证是路径：JS 入口能交给 node，原生二进制发行版必须直接执行，
  // Windows 命令包装通过 cmd.exe/ComSpec 解析 PATH/PATHEXT——判定统一收敛在 resolvePnpmInvocation。
  const invocation = resolvePnpmInvocation(args, {
    npmExecPath: usablePnpmExecPath(env.npm_execpath, exists),
    execPath: options.execPath,
    platform: options.platform,
    comSpec: options.comSpec,
  });
  return { ...invocation, displayCommand: `pnpm ${args.join(' ')}` };
}

function runElectronInstallJs(root = ROOT) {
  const installScript = 'node_modules/electron/install.js';
  log(`运行 ${process.execPath} ${installScript} ...`);
  const result = spawnSync(process.execPath, [installScript], {
    cwd: root,
    stdio: 'inherit',
    env: createElectronInstallEnv(),
  });

  if (result.error) {
    err(`Electron install.js 启动失败：${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    err(`Electron install.js 失败，退出码：${result.status}`);
    process.exit(1);
  }
}

function downloadElectronZip(root = ROOT) {
  const script = `
const { downloadArtifact } = require('@electron/get');
const { version } = require('./node_modules/electron/package.json');
const checksums = (process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums)
  ? undefined
  : require('./node_modules/electron/checksums.json');
downloadArtifact({
  version,
  artifactName: 'electron',
  force: process.env.force_no_cache === 'true',
  cacheRoot: process.env.electron_config_cache,
  checksums,
  platform: process.env.npm_config_platform || process.platform,
  arch: process.env.npm_config_arch || process.arch,
}).then((zipPath) => {
  process.stdout.write(zipPath);
}).catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
`;
  log('下载 Electron zip（仅下载，不走 extract-zip 解压）...');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: createElectronInstallEnv(),
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    err(`Electron zip 下载进程启动失败：${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    err(`Electron zip 下载失败，退出码：${result.status}`);
    process.exit(1);
  }
  const zipPath = result.stdout.trim();
  if (!zipPath || !fs.existsSync(zipPath)) {
    err(`Electron zip 下载结果无效：${zipPath || '(empty)'}`);
    process.exit(1);
  }
  return zipPath;
}

function extractElectronZipWithSystemTar(zipPath, root = ROOT) {
  const electronDir = getElectronDir(root);
  const distDir = path.join(electronDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });

  log(`使用系统 tar 解压 Electron zip：${zipPath}`);
  const result = spawnSync('tar', ['-xf', zipPath, '-C', distDir], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) {
    err(`系统 tar 启动失败：${result.error.message}`);
    err('Windows Node 24 会触发 Electron 自带 extract-zip 半解压问题；请安装系统 tar，或切换 Node 22 后重试。');
    process.exit(1);
  }
  if (result.status !== 0) {
    err(`系统 tar 解压失败，退出码：${result.status}`);
    process.exit(1);
  }

  const srcTypeDefPath = path.join(distDir, 'electron.d.ts');
  const targetTypeDefPath = path.join(electronDir, 'electron.d.ts');
  if (fs.existsSync(srcTypeDefPath)) {
    fs.renameSync(srcTypeDefPath, targetTypeDefPath);
  }
  fs.writeFileSync(path.join(electronDir, 'path.txt'), getElectronPlatformBinaryRelPath());
}

function runElectronSystemTarRepair(root = ROOT) {
  const zipPath = downloadElectronZip(root);
  extractElectronZipWithSystemTar(zipPath, root);
}

function runElectronRepairInstall(root = ROOT) {
  const mode = getElectronRepairMode();
  if (mode === 'system-tar') {
    warn(`检测到 Windows + Node ${process.versions.node}，绕开 Electron install.js 的 extract-zip 解压链路`);
    runElectronSystemTarRepair(root);
    return;
  }
  runElectronInstallJs(root);
}

function repairElectronBinary(issue, root = ROOT) {
  warn(`Electron 安装不完整：${describeElectronBinaryIssue(issue, root)}`);

  const electronDir = getElectronDir(root);
  const distDir = path.join(electronDir, 'dist');
  if (fs.existsSync(distDir)) {
    warn(`删除残缺 Electron dist：${path.relative(root, distDir)}`);
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  if (fs.existsSync(issue.pathTxt)) {
    warn(`删除 Electron path.txt：${path.relative(root, issue.pathTxt)}`);
    fs.rmSync(issue.pathTxt, { force: true });
  }

  runElectronRepairInstall(root);

  const still = findElectronBinaryIssue(root);
  if (still) {
    err(`Electron 修复后仍不完整：${describeElectronBinaryIssue(still, root)}`);
    err(`当前 Node ${process.version}。请清理 Electron 下载缓存或切换 Node 22 后重试`);
    process.exit(1);
  }

  log('Electron binary 完整性恢复');
}

function ensureElectronBinaryComplete(root = ROOT) {
  const issue = findElectronBinaryIssue(root);
  if (issue) {
    repairElectronBinary(issue, root);
  }
}

// 检测 frozen-lockfile 是否生效（根 .npmrc 显式配置，或环境变量覆盖）。
// 仅用于在 install 失败时判断要不要给出 frozen 专属的修复指引。
function isFrozenLockfileEnabled() {
  if (process.env.npm_config_frozen_lockfile === 'true') return true;
  const npmrc = path.join(ROOT, '.npmrc');
  if (!fs.existsSync(npmrc)) return false;
  return fs
    .readFileSync(npmrc, 'utf8')
    .split(/\r?\n/)
    .some((line) => !line.trim().startsWith('#') && /^\s*frozen-lockfile\s*=\s*true\s*$/i.test(line));
}

function removeBrokenDirs(broken) {
  for (const { checkPath, moduleDir } of broken) {
    if (fs.existsSync(moduleDir)) {
      warn(`删除损坏目录：${path.relative(ROOT, moduleDir)}`);
      fs.rmSync(moduleDir, { recursive: true, force: true });
    } else {
      warn(`缺失（无目录可删）：${checkPath}`);
    }
  }
}

function nukeAllNodeModules() {
  for (const dir of NODE_MODULES_DIRS) {
    if (fs.existsSync(dir)) {
      warn(`核弹清理：${path.relative(ROOT, dir) || 'node_modules'}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

// 前置清理：残缺的子包目录（只有 postinstall 残留，没 package.json）
// 这些目录会让 Node.js require 解析卡死——必须在 install 前物理铲除
function cleanStaleSubpkgDirs() {
  let cleaned = 0;
  for (const rel of STALE_SUBPKG_DIRS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const pkgJson = path.join(abs, 'package.json');
    if (!fs.existsSync(pkgJson)) {
      warn(`铲除残缺目录：${rel}（有目录无 package.json，会阻塞 Node.js 模块解析）`);
      fs.rmSync(abs, { recursive: true, force: true });
      cleaned++;
    }
  }
  return cleaned;
}

// Electron 专用 native cache：root node_modules 保持 Node ABI, Electron ABI 产物独立存放。
const ELECTRON_NATIVE_MODULE = 'better-sqlite3';
const ELECTRON_NATIVE_MARKER = '.xdt-native-marker.json';

function readElectronVersion() {
  const pkgPath = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return null;
  }
}

function detectElectronArch() {
  if (process.platform !== 'darwin') return process.arch;

  const electronBin = path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron',
  );
  if (!fs.existsSync(electronBin)) return process.arch;

  const res = spawnSync('lipo', ['-archs', electronBin], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) return process.arch;

  const archs = res.stdout.trim().split(/\s+/).filter(Boolean);
  if (archs.includes('arm64') && !archs.includes('x86_64')) return 'arm64';
  if (archs.includes('x86_64') && !archs.includes('arm64')) return 'x64';
  if (archs.includes(process.arch === 'x64' ? 'x86_64' : process.arch)) return process.arch;
  return archs.includes('arm64') ? 'arm64' : process.arch;
}

function getElectronNativeCacheDir(electronVersion, electronArch, moduleVersion, root = ROOT) {
  return path.join(
    root,
    'node_modules',
    '.xdt-electron-native',
    `electron-${electronVersion}-${process.platform}-${electronArch}-${ELECTRON_NATIVE_MODULE}-${moduleVersion}`,
  );
}

function getElectronNativeBindingPath(electronVersion, electronArch, moduleVersion, root = ROOT) {
  return path.join(
    getElectronNativeCacheDir(electronVersion, electronArch, moduleVersion, root),
    'node_modules',
    ELECTRON_NATIVE_MODULE,
    'build',
    'Release',
    'better_sqlite3.node',
  );
}

function readPackageVersion(moduleName) {
  const pkgPath = path.join(ROOT, 'node_modules', moduleName, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return null;
  }
}

function getElectronNativeMarkerPath(cacheDir) {
  return path.join(cacheDir, ELECTRON_NATIVE_MARKER);
}

function readElectronNativeMarker(cacheDir) {
  const markerPath = getElectronNativeMarkerPath(cacheDir);
  if (!fs.existsSync(markerPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return null;
  }
}

function createElectronNativeMarker(electronVersion, electronArch, moduleVersion) {
  return {
    module: ELECTRON_NATIVE_MODULE,
    moduleVersion,
    electronVersion,
    platform: process.platform,
    arch: electronArch,
  };
}

function isElectronNativeMarkerCurrent(actual, expected) {
  return (
    actual?.module === expected.module &&
    actual?.moduleVersion === expected.moduleVersion &&
    actual?.electronVersion === expected.electronVersion &&
    actual?.platform === expected.platform &&
    actual?.arch === expected.arch
  );
}

function prepareElectronNativeCache(cacheDir, moduleVersion) {
  const sourceDir = path.join(ROOT, 'node_modules', ELECTRON_NATIVE_MODULE);
  if (!fs.existsSync(sourceDir)) {
    err(`缺少 ${path.relative(ROOT, sourceDir)}，无法准备 Electron native cache`);
    process.exit(1);
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  const cacheNodeModules = path.join(cacheDir, 'node_modules');
  fs.mkdirSync(cacheNodeModules, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'package.json'),
    `${JSON.stringify({
      name: 'xdt-electron-native-cache',
      private: true,
      dependencies: {
        [ELECTRON_NATIVE_MODULE]: moduleVersion,
      },
    }, null, 2)}\n`,
  );

  const targetDir = path.join(cacheNodeModules, ELECTRON_NATIVE_MODULE);
  fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
  // 源包可能带着 Node ABI 产物，复制到 cache 后必须删掉再按 Electron 目标重编。
  fs.rmSync(path.join(targetDir, 'build'), { recursive: true, force: true });
}

function runNodeTool(label, scriptPath, args, options = {}) {
  if (!fs.existsSync(scriptPath)) {
    if (options.allowFailure) return false;
    err(`缺少本地工具 ${label}：${path.relative(ROOT, scriptPath)}`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    env: createElectronInstallEnv(),
  });
  if (result.error || result.status !== 0) {
    if (options.allowFailure) return false;
    if (result.error) {
      err(`${label} 启动失败：${result.error.message}`);
      process.exit(1);
    }
    err(`${label} 失败`);
    process.exit(1);
  }
  return true;
}

function probeRootBetterSqliteNodeAbi() {
  const result = spawnSync(
    process.execPath,
    ['-e', "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close();"],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: createElectronInstallEnv(),
    },
  );
  if (result.status === 0) return null;
  return `${result.stderr || result.stdout || `exit ${result.status}`}`.trim();
}

function ensureRootNodeNativeBinding() {
  const failure = probeRootBetterSqliteNodeAbi();
  if (!failure) {
    log(`${ELECTRON_NATIVE_MODULE} root Node ABI 已就绪`);
    return;
  }

  warn(`${ELECTRON_NATIVE_MODULE} root Node ABI 不可用，按当前 Node 重建`);
  warn(failure.split(/\r?\n/).slice(0, 4).join('\n'));
  runBetterSqliteNodeInstall();

  const still = probeRootBetterSqliteNodeAbi();
  if (still) {
    err(`${ELECTRON_NATIVE_MODULE} root Node ABI 修复后仍不可用`);
    err(still.split(/\r?\n/).slice(0, 8).join('\n'));
    process.exit(1);
  }

  log(`${ELECTRON_NATIVE_MODULE} root Node ABI 已恢复`);
}

function runBetterSqliteNodeInstall() {
  const moduleDir = path.join(ROOT, 'node_modules', ELECTRON_NATIVE_MODULE);
  const usedPrebuild = runNodeTool('prebuild-install', path.join(ROOT, 'node_modules', 'prebuild-install', 'bin.js'), [], {
    cwd: moduleDir,
    allowFailure: true,
  });
  if (usedPrebuild) return;
  runNodeTool('node-gyp', path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'), ['rebuild', '--release'], {
    cwd: moduleDir,
  });
}

function rebuildElectronNativeCache(electronVersion, electronArch, cacheDir) {
  log(`编译 Electron ${electronVersion} (${electronArch}) 专用 ${ELECTRON_NATIVE_MODULE} native binding`);
  runNodeTool('electron-rebuild', path.join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'), [
    '-f',
    '-o',
    ELECTRON_NATIVE_MODULE,
    `--arch=${electronArch}`,
    `--version=${electronVersion}`,
    `--module-dir=${cacheDir}`,
  ]);
}

function ensureElectronNativeBinding(electronVersion, electronArch) {
  const moduleVersion = readPackageVersion(ELECTRON_NATIVE_MODULE);
  if (!moduleVersion) {
    err(`无法读取 ${ELECTRON_NATIVE_MODULE} 版本`);
    process.exit(1);
  }

  const cacheDir = getElectronNativeCacheDir(electronVersion, electronArch, moduleVersion);
  const bindingPath = getElectronNativeBindingPath(electronVersion, electronArch, moduleVersion);
  const expectedMarker = createElectronNativeMarker(electronVersion, electronArch, moduleVersion);
  const actualMarker = readElectronNativeMarker(cacheDir);

  if (fs.existsSync(bindingPath) && isElectronNativeMarkerCurrent(actualMarker, expectedMarker)) {
    log(`Electron native cache 已就绪：${path.relative(ROOT, bindingPath)}`);
    return;
  }

  if (actualMarker) {
    warn('Electron native cache 标记不匹配，重新生成');
  } else if (!fs.existsSync(bindingPath)) {
    warn(`Electron native cache 缺少 ${path.relative(ROOT, bindingPath)}`);
  }

  prepareElectronNativeCache(cacheDir, moduleVersion);
  rebuildElectronNativeCache(electronVersion, electronArch, cacheDir);

  if (!fs.existsSync(bindingPath)) {
    err(`electron-rebuild 后仍缺少 ${path.relative(ROOT, bindingPath)}`);
    process.exit(1);
  }

  fs.writeFileSync(getElectronNativeMarkerPath(cacheDir), `${JSON.stringify(expectedMarker, null, 2)}\n`);
  log(`Electron native cache 已生成：${path.relative(ROOT, bindingPath)}`);
  // electron-rebuild 在 hoisted workspace 下可能仍回写 root 包；生成 cache 后立刻恢复 Node ABI 不变量。
  ensureRootNodeNativeBinding();
}

function main() {
  if (process.argv.slice(2).includes('--workspace-only')) {
    ensureWorkspaceOnlyDependencies();
    return;
  }

  cleanStaleSubpkgDirs();

  // 优先级：完整性损坏 > lockfile 不同步
  // 完整性失败意味着即使 lockfile 看起来同步，实际安装也是坏的——必须干预才能让 pnpm 重建
  const broken = findBrokenDeps();
  if (broken.length > 0) {
    warn(`关键依赖损坏：${broken.map((b) => b.name).join(', ')}`);

    // 阶段 1：删损坏目录 + pnpm install
    removeBrokenDirs(broken);
    runInstall(['install']);
    let still = findBrokenDeps();

    // 阶段 2：pnpm install --force
    if (still.length > 0) {
      warn(`阶段 1 后仍有 ${still.length} 个损坏，升级到 --force`);
      removeBrokenDirs(still);
      runInstall(['install', '--force']);
      still = findBrokenDeps();
    }

    // 阶段 3：核弹清理 + pnpm install
    if (still.length > 0) {
      warn(`阶段 2 后仍有 ${still.length} 个损坏，执行核弹清理重装`);
      nukeAllNodeModules();
      runInstall(['install']);
      still = findBrokenDeps();
    }

    if (still.length > 0) {
      err(`核弹清理后依然损坏：${still.map((b) => b.name).join(', ')}`);
      err('这通常意味着 pnpm 本身有问题或 lockfile 异常，请手动检查');
      process.exit(1);
    }

    log('关键依赖完整性恢复，继续检查 Electron binary/native ABI');
  }

  const lockIssue = reasonLockfileOutOfSync();
  if (lockIssue) {
    log(lockIssue);
    runInstall(['install']);
    // install 后 Electron native cache 可能跟依赖版本不一致，继续走 cache 检查
  }

  ensureElectronBinaryComplete();
  ensureRootNodeNativeBinding();

  const electronVersion = readElectronVersion();
  if (electronVersion) {
    const electronArch = detectElectronArch();
    ensureElectronNativeBinding(electronVersion, electronArch);
  }

  log('依赖已同步，跳过');
}

if (process.argv[1] && path.resolve(process.argv[1]) === ENTRY_FILE) {
  main();
}
