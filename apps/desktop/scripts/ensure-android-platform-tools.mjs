#!/usr/bin/env node
// =============================================================================
// ensure-android-platform-tools — 打包前把 Android SDK Platform-Tools 的 Windows
// 二进制(adb.exe + AdbWinApi.dll + AdbWinUsbApi.dll)按 pin 版本就位到
// apps/android-platform-tools-bin/<platformKey>/。
//
// 为什么改成下载而不是入仓:这三个文件共 6.5MB,过去走 Git LFS。公开仓里每次
// clone、以及每次 CI checkout(ci.yml 的 lfs: true)都要把它们下一遍,LFS 免费
// 带宽额度耗尽后不是"变慢"而是 clone 与 CI checkout 一起硬失败,所有 PR 都会
// 卡住。改成打包时下载后,安装包内容与过去逐字节一致 —— 下面 pin 的 sha256 正是
// 原 Git LFS 对象的 oid(LFS oid 就是文件 sha256),对得上就说明字节没变。
//
// 版本事实源:同目录 source.properties 的 Pkg.Revision。
// generate-third-party-notices.mjs 读的是同一个文件(readAndroidPlatformToolsVersion),
// 所以许可清单里的版本号不会和实际打进包的二进制漂移。升级版本时改 source.properties
// 并同步更新下面的 sha256(可用 `--print-hashes` 现算)。
//
// 非 Windows 平台不在本脚本职责内:forge 的 stageAndroidPlatformTools 对非 win32
// 缺失即跳过,运行时由 src/main/mcp-integrations/android.ts 按需下载到 userData。
//
// 无法访问 dl.google.com(例如国内打包机没有代理)时有两条出路:
//   1) CINDY_ANDROID_PLATFORM_TOOLS_ZIP=<本地 platform-tools-*.zip 路径> 走本地解压;
//   2) 手工把三个文件放进 apps/android-platform-tools-bin/<platformKey>/,
//      sha256 匹配即视为就位(本脚本与 forge 都只校验哈希,不关心来源)。
//
// 用法:
//   node apps/desktop/scripts/ensure-android-platform-tools.mjs [--platform-key=win32-x64]
//        [--force] [--print-hashes]
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import {
  downloadToFileWithTimeout,
  createDownloadProgressLogger,
} from '../../../tools/shared/fetch-with-timeout.mjs';
// 复用 agent 二进制 de-LFS 那条链路的 sha256 工具:同一套 fail-closed 语义与错误
// 文案,不在这里重复实现哈希校验。
import { sha256File, sha256Hex, assertSha256 } from '../../../tools/shared/verify-sha256.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BIN_ROOT = path.join(REPO_ROOT, 'apps', 'android-platform-tools-bin');

/** zip 内所有条目都在这个前缀下(Google 的包结构,历代未变)。 */
const ZIP_ENTRY_PREFIX = 'platform-tools/';

/**
 * 每个平台需要落地的文件及其期望 sha256。
 *
 * 只有 win32 需要 —— 它的 adb 依赖两个 AdbWin*.dll,缺一个 adb.exe 起不来。
 * 值取自 platform-tools r32.0.0,与被本次改动删除的 Git LFS 对象 oid 完全一致。
 */
const PINNED = {
  'win32-x64': {
    zipOs: 'windows',
    files: {
      'adb.exe': 'e79dc8fc3c6385192bdccd7ff7eabe3d5c1ec292475a06b04d82759f07655982',
      'AdbWinApi.dll': 'd60103a5e99bc9888f786ee916f5d6e45493c3247972cb053833803de7e95cf9',
      'AdbWinUsbApi.dll': '25207c506d29c4e8dceb61b4bd50e8669ba26012988a43fbf26a890b1e60fc97',
    },
  },
};

function log(msg) {
  console.log(`[android-platform-tools] ${msg}`);
}

export function isSupportedPlatformKey(platformKey) {
  return Object.hasOwn(PINNED, platformKey);
}

/** 该平台需要落地的 { 文件名: 期望 sha256 };未支持的平台返回 null。 */
export function expectedHashesFor(platformKey) {
  const spec = PINNED[platformKey];
  return spec ? { ...spec.files } : null;
}

/** 当前宿主对应的 platformKey;不受支持时返回 null(调用方据此跳过)。 */
export function currentPlatformKey() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return null;
}

/**
 * 从 <BIN_ROOT>/<platformKey>/source.properties 解析 pin 版本。
 *
 * 这个文件随二进制一起来自上游 zip,是仓库内唯一的版本事实源;缺失即报错而不是
 * 猜 latest —— 拉到比声明更新的版本会让许可清单里的版本号说谎。
 */
export function readPinnedVersion(platformKey, binRoot = BIN_ROOT) {
  const propsPath = path.join(binRoot, platformKey, 'source.properties');
  if (!fs.existsSync(propsPath)) {
    throw new Error(
      `missing ${path.relative(REPO_ROOT, propsPath)} — 无法确定 pin 版本。` +
        `该文件与 NOTICE.txt 是有意入仓的文本(不占 LFS),不应被删除。`,
    );
  }
  const revision = /^Pkg\.Revision=(.+)$/m.exec(fs.readFileSync(propsPath, 'utf8'))?.[1]?.trim();
  if (!revision) {
    throw new Error(`cannot parse Pkg.Revision from ${path.relative(REPO_ROOT, propsPath)}`);
  }
  return revision;
}

export function downloadUrlFor(platformKey, version) {
  const spec = PINNED[platformKey];
  if (!spec) throw new Error(`unsupported platform key: ${platformKey}`);
  // 版本化 URL(非 -latest-):锁得住版本,才能用固定 sha256 校验。
  return `https://dl.google.com/android/repository/platform-tools_r${version}-${spec.zipOs}.zip`;
}

/** 三个文件都在且 sha256 都对 → 视为就位。任一不符都当作缺失重新获取。 */
export function verifyInstalled(platformKey, binRoot = BIN_ROOT) {
  const spec = PINNED[platformKey];
  if (!spec) return { ok: false, reason: `unsupported platform key: ${platformKey}` };
  for (const [name, expected] of Object.entries(spec.files)) {
    const filePath = path.join(binRoot, platformKey, name);
    if (!fs.existsSync(filePath)) return { ok: false, reason: `${name} missing` };
    const actual = sha256File(filePath);
    if (actual !== expected) {
      return { ok: false, reason: `${name} sha256 mismatch (expected ${expected}, got ${actual})` };
    }
  }
  return { ok: true };
}

/**
 * 从 zip buffer 里抽出该平台需要的文件,逐个校验 sha256 后写入目标目录。
 *
 * 先校验再落盘:校验不过就整批不写,免得留下半套二进制让 forge 以为已就位。
 */
async function extractVerifiedFiles(zipBuffer, platformKey, destDir) {
  const spec = PINNED[platformKey];
  const zip = await JSZip.loadAsync(zipBuffer);
  const staged = new Map();

  for (const [name, expected] of Object.entries(spec.files)) {
    const entry = zip.file(`${ZIP_ENTRY_PREFIX}${name}`);
    if (!entry) throw new Error(`zip 内找不到 ${ZIP_ENTRY_PREFIX}${name}`);
    const content = await entry.async('nodebuffer');
    // fail-closed:哈希不符直接抛,不落盘。上游包被替换、或 source.properties 的
    // 版本与 pin 的哈希对不上,都会走到这里。
    assertSha256({
      actualHex: sha256Hex(content),
      expected,
      label: `${name} (platform-tools ${platformKey})`,
    });
    staged.set(name, content);
  }

  fs.mkdirSync(destDir, { recursive: true });
  for (const [name, content] of staged) {
    fs.writeFileSync(path.join(destDir, name), content);
  }
  return [...staged.keys()];
}

/**
 * 确保指定平台的 platform-tools 二进制就位。
 *
 * @returns {Promise<{ status: 'skipped'|'installed', version: string, files?: string[] }>}
 */
export async function ensureAndroidPlatformTools({
  platformKey = currentPlatformKey(),
  force = false,
  binRoot = BIN_ROOT,
} = {}) {
  if (!platformKey || !isSupportedPlatformKey(platformKey)) {
    throw new Error(
      `unsupported platform key: ${platformKey ?? '(none)'} — ` +
        `仅 ${Object.keys(PINNED).join(', ')} 需要预置,其他平台由运行时按需下载。`,
    );
  }

  const version = readPinnedVersion(platformKey, binRoot);
  const destDir = path.join(binRoot, platformKey);

  if (!force) {
    const installed = verifyInstalled(platformKey, binRoot);
    if (installed.ok) {
      log(`${platformKey}: already present @ ${version} (sha256 verified), skip`);
      return { status: 'skipped', version };
    }
    log(`${platformKey}: need fetch @ ${version} — ${installed.reason}`);
  }

  // 本地 zip 出路优先:无外网/无法访问 Google 的打包机靠它离线完成。
  const localZip = process.env.CINDY_ANDROID_PLATFORM_TOOLS_ZIP?.trim();
  if (localZip) {
    if (!fs.existsSync(localZip)) {
      throw new Error(`CINDY_ANDROID_PLATFORM_TOOLS_ZIP 指向的文件不存在:${localZip}`);
    }
    log(`${platformKey}: 使用本地 zip ${localZip}`);
    const files = await extractVerifiedFiles(fs.readFileSync(localZip), platformKey, destDir);
    log(`${platformKey}: installed @ ${version} from local zip (${files.join(', ')})`);
    return { status: 'installed', version, files };
  }

  const url = downloadUrlFor(platformKey, version);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-platform-tools-'));
  const tmpZip = path.join(tmpDir, 'platform-tools.zip');
  try {
    log(`${platformKey}: downloading ${url}`);
    await downloadToFileWithTimeout(url, tmpZip, {}, {
      onProgress: createDownloadProgressLogger(`platform-tools ${platformKey}`),
    });
    const files = await extractVerifiedFiles(fs.readFileSync(tmpZip), platformKey, destDir);
    log(`${platformKey}: installed @ ${version} (${files.join(', ')})`);
    return { status: 'installed', version, files };
  } catch (err) {
    throw new Error(
      `无法就位 Android platform-tools ${platformKey}@${version}:${err.message}\n` +
        `  下载地址: ${url}\n` +
        `  出路 1: 设 CINDY_ANDROID_PLATFORM_TOOLS_ZIP=<本地 zip 路径> 后重试;\n` +
        `  出路 2: 手工把 ${Object.keys(PINNED[platformKey].files).join(' / ')} 放进 ` +
        `apps/android-platform-tools-bin/${platformKey}/(sha256 需匹配)。`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = { platformKey: currentPlatformKey(), force: false, printHashes: false };
  for (const arg of argv) {
    if (arg === '--force') out.force = true;
    else if (arg === '--print-hashes') out.printHashes = true;
    else if (arg.startsWith('--platform-key=')) out.platformKey = arg.slice('--platform-key='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

// 直接执行时作为 CLI 跑;被 import 时(forge / package-desktop)只暴露函数。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  if (args.printHashes) {
    // 升级版本时用:先手工放好新版三个文件,再用它打印新 sha256 回填 PINNED。
    const key = args.platformKey ?? 'win32-x64';
    for (const name of Object.keys(PINNED[key]?.files ?? {})) {
      const p = path.join(BIN_ROOT, key, name);
      console.log(`${fs.existsSync(p) ? sha256File(p) : '(missing)'}  ${name}`);
    }
  } else {
    ensureAndroidPlatformTools(args).catch((err) => {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    });
  }
}
