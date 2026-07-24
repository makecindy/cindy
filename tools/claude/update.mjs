#!/usr/bin/env node

/**
 * update.mjs — 下载 @anthropic-ai/claude-code 各平台可执行文件
 *
 * 用法：
 *   node tools/claude/update.mjs            # 拉最新版
 *   node tools/claude/update.mjs 2.1.100    # 指定版本
 *
 * 流程（不指定版本）：
 *   1. 拉取 npm registry 的 latest 元数据
 *   2. 与本地缓存 latest.json 对比 version
 *   3. 版本相同：仅刷新本地 JSON 缓存，退出
 *   4. 版本不同：下载到 tools/claude/updates/{version}/{platform}/
 *      全部成功后再写入缓存 JSON（失败下一次会自动重试）
 *
 * 流程（指定版本）：
 *   直接下载到 tools/claude/updates/{version}/{platform}/
 *   已存在的文件会跳过（用 --force 覆盖），不写缓存 JSON
 *
 * 供应链加固：每次真正下载(非跳过)后,用官方 per-version manifest.json 里该平台的 checksum
 * 对下载的二进制做 sha256 校验,不符 / 拿不到可信 hash 一律删文件并 exit 1(fail-closed),绝不落地。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchJsonWithTimeout, downloadToFileWithTimeout, createDownloadProgressLogger } from '../shared/fetch-with-timeout.mjs';
import { verifyFileSha256OrRemove, normalizeExpectedSha256 } from '../shared/verify-sha256.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const NPM_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
// 官方 per-version 发布清单(与二进制同一 downloads.claude.ai 端点、同源 TLS)。
// 结构:{ version, platforms: { <platformKey>: { binary, checksum(裸二进制 sha256 hex), size } } }。
// 这是官方 installer 自身用来校验的清单,作为 dev/CI 下载校验的可信 sha256 来源。
const MANIFEST_URL = (version) => `https://downloads.claude.ai/claude-code-releases/${version}/manifest.json`;
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'claude-code-bin');

const PLATFORMS = [
  { key: 'darwin-arm64', file: 'claude' },
  { key: 'darwin-x64', file: 'claude' },
  // Verified 2026-06-17 by HEAD request against downloads.claude.ai for the
  // latest npm version: linux-x64 uses the same plain `claude` binary name.
  { key: 'linux-x64', file: 'claude' },
  // Verified 2026-07-24 against the official release manifest
  // (claude-code-releases/<version>/manifest.json): linux-arm64 (glibc) is
  // published with the same plain `claude` binary name and a checksum entry.
  { key: 'linux-arm64', file: 'claude' },
  { key: 'win32-x64', file: 'claude.exe' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

async function fetchLatestMeta() {
  return fetchJsonWithTimeout(NPM_URL);
}

async function fetchMetaForVersion(version) {
  return fetchJsonWithTimeout(`https://registry.npmjs.org/@anthropic-ai/claude-code/${version}`);
}

/** 拉取该版本的官方发布清单;非 2xx / 超时 / 解析失败均抛错(由调用方 fail-closed 处理)。 */
async function fetchReleaseManifest(version) {
  return fetchJsonWithTimeout(MANIFEST_URL(version));
}

/** 从清单取某平台的可信二进制 sha256(归一化为小写 hex);缺失 / 格式非法返回 null。 */
function checksumForPlatform(manifest, platformKey) {
  return normalizeExpectedSha256(manifest?.platforms?.[platformKey]?.checksum);
}

/**
 * 生成一个"按需拉清单 + 取平台 checksum"的 resolver：清单只在第一次真正需要时拉一次并缓存,
 * 让"全平台已就位、无需下载"的快捷路径不必联网拉清单(离线从 updates 缓存 promote 仍可用)。
 */
function makeChecksumResolver(version) {
  let manifestPromise = null;
  return async (platformKey) => {
    if (!manifestPromise) manifestPromise = fetchReleaseManifest(version);
    return checksumForPlatform(await manifestPromise, platformKey);
  };
}

function readCachedVersion() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return json.version || null;
  } catch {
    return null;
  }
}

async function saveCache(meta) {
  const version = meta.version;
  if (!version) throw new Error('Cannot pin Claude runtime assets without a version');
  const manifest = await fetchReleaseManifest(version);
  const runtimeAssets = Object.fromEntries(PLATFORMS.map(({ key, file }) => {
    const entry = manifest?.platforms?.[key];
    const sha256 = normalizeExpectedSha256(entry?.checksum);
    if (!sha256) throw new Error(`Cannot pin Claude ${version} ${key}: manifest checksum is missing`);
    return [key, {
      url: `https://downloads.claude.ai/claude-code-releases/${version}/${key}/${file}`,
      sha256,
      ...(typeof entry?.size === 'number' && entry.size > 0 ? { size: entry.size } : {}),
    }];
  }));
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...meta, runtimeAssets }, null, 2) + '\n');
}

function formatMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

/**
 * 缓存文件是否可用——存在、≥1KB、且不是 Git LFS pointer。
 * 只判 existsSync 会把旧 checkout 残留的 LFS pointer / 截断文件当成有效缓存，
 * 导致 ensure 反复复制坏文件且无法自修复（见 PR review）。
 */
function isUsableCache(filePath) {
  try {
    if (fs.statSync(filePath).size < 1024) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.subarray(0, n).toString('utf8').startsWith(LFS_POINTER_HEADER)) return false;
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** 指定版本下，目标平台的 updates/<version>/<platform>/<file> 是否都已是可用缓存。 */
function targetsExist(version, targets) {
  return targets.every(({ key, file }) => isUsableCache(path.join(UPDATES_DIR, version, key, file)));
}

// throughputGuard：龟速掐断（吞吐低于下限即放弃）只允许 install 链路（ensurePlatform）开启——
// 那条链有 CDN 兜底，尽早放弃上游才有意义；update CLI 直连上游无兜底（CDN 不会有比
// release 更新的版本），掐断只会把"慢但能成"变成失败，故默认关闭。
async function downloadBinary(version, platformKey, fileName, { force = false, throughputGuard = false, resolveExpectedSha256 = null } = {}) {
  const url = `https://downloads.claude.ai/claude-code-releases/${version}/${platformKey}/${fileName}`;
  const destDir = path.join(UPDATES_DIR, version, platformKey);
  const destPath = path.join(destDir, fileName);

  fs.mkdirSync(destDir, { recursive: true });

  if (!force && isUsableCache(destPath)) {
    if (resolveExpectedSha256) {
      const cachedHash = await resolveExpectedSha256(platformKey);
      if (!cachedHash) {
        throw new Error(`[${platformKey}] trusted sha256 not available for claude ${platformKey} v${version}: cannot verify cached binary (fail-closed)`);
      }
      verifyFileSha256OrRemove(destPath, cachedHash, `claude ${platformKey} binary v${version} (cached)`);
      const size = fs.statSync(destPath).size;
      console.log(`  [${platformKey}] skip (cached, sha256 ok, ${formatMB(size)})`);
      return;
    }
    const size = fs.statSync(destPath).size;
    console.log(`  [${platformKey}] skip (already exists, ${formatMB(size)})`);
    return;
  }

  // 供应链加固：下载前先取可信 sha256；resolver 缺失或 hash 拿不到即 fail-closed，不浪费数百 MB 下载。
  if (!resolveExpectedSha256) {
    throw new Error(`[${platformKey}] no sha256 resolver — cannot download without trusted checksum source`);
  }
  const expectedSha256 = await resolveExpectedSha256(platformKey);
  if (!expectedSha256) {
    throw new Error(`[${platformKey}] trusted sha256 not available for claude ${platformKey} v${version}: manifest missing this platform. Refusing download (fail-closed).`);
  }

  console.log(`  [${platformKey}] ${url}`);
  const progress = createDownloadProgressLogger(platformKey);
  try {
    await downloadToFileWithTimeout(url, destPath, {}, {
      onProgress: progress.onProgress,
      minThroughputBytesPerSec: throughputGuard ? undefined : 0, // undefined → env/默认值生效
    });
  } finally {
    progress.finish();
  }

  // 校验下载的二进制；不符 / 无可信 hash → 删除文件并抛错（fail-closed，绝不落地未验证二进制）。
  verifyFileSha256OrRemove(destPath, expectedSha256, `claude ${platformKey} binary v${version}`);
  console.log(`    [${platformKey}] sha256 ok`);

  // darwin 二进制需要可执行权限（Windows 不需要）
  if (!fileName.endsWith('.exe')) {
    try { fs.chmodSync(destPath, 0o755); } catch { /* ignore */ }
  }

  const size = fs.statSync(destPath).size;
  console.log(`    → ${destPath} (${formatMB(size)})`);
}

/**
 * 把单个平台的 updates/<version>/<platform>/<binary> 拷到 apps/claude-code-bin/<platform>/。
 * 源文件缺失会 warn 跳过；目标被占用（app 运行中）也 warn 跳过。
 */
function promoteOnePlatform(version, key, file) {
  const srcPath = path.join(UPDATES_DIR, version, key, file);
  const destDir = path.join(BIN_DIR, key);
  const destPath = path.join(destDir, file);

  if (!fs.existsSync(srcPath)) {
    console.warn(`  [${key}] WARN: source missing, skipping (${srcPath})`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.copyFileSync(srcPath, destPath);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'ETXTBSY') {
      console.warn(`  [${key}] WARN: target locked (probably running). Close the app and re-run, or copy manually:`);
      console.warn(`         cp "${srcPath}" "${destPath}"`);
      return;
    }
    throw err;
  }
  if (!file.endsWith('.exe')) {
    try { fs.chmodSync(destPath, 0o755); } catch { /* ignore */ }
  }

  // 写版本标记，供 scripts/ensure-agent-binaries.mjs 判断是否需要随 pin 升级刷新
  try { fs.writeFileSync(path.join(destDir, '.version'), version + '\n'); } catch { /* ignore */ }

  const size = fs.statSync(destPath).size;
  console.log(`  [${key}] → ${destPath} (${formatMB(size)})`);
}

/**
 * 把 updates/<version>/<platform>/<binary> 同步到 apps/claude-code-bin/<platform>/<binary>。
 * 只有当源文件存在时才覆盖目标——某平台缺失会 warn 跳过。
 */
function promoteToVendorBin(version, platforms = PLATFORMS) {
  console.log('');
  console.log(`==> Promoting to apps/claude-code-bin/ ...`);
  for (const { key, file } of platforms) {
    promoteOnePlatform(version, key, file);
  }
}

// ── Programmatic API（供 scripts/ensure-agent-binaries.mjs 复用） ─────────────

/** 读 latest.json 里 pin 的版本号（按需下载以此为准，不取 upstream latest）。 */
export function readPinnedVersion() {
  return readCachedVersion();
}

/**
 * 确保单个平台的二进制就位：下载到 updates/ 并 promote 到 apps/claude-code-bin/<platformKey>/。
 * 已存在合法文件时 downloadBinary 会自动跳过（除非 force）。
 */
export async function ensurePlatform({ version, platformKey, force = false }) {
  const entry = PLATFORMS.find((p) => p.key === platformKey);
  if (!entry) throw new Error(`Unknown platform key for claude: ${platformKey}`);
  // install 链路（ensure-agent-binaries）有 CDN 兜底，开启吞吐守卫尽早切换
  await downloadBinary(version, platformKey, entry.file, {
    force,
    throughputGuard: true,
    resolveExpectedSha256: makeChecksumResolver(version),
  });
  promoteOnePlatform(version, platformKey, entry.file);
}

// ── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { version: null, force: false, platform: null };
  for (const a of argv) {
    if (a === '--force' || a === '-f') args.force = true;
    else if (a.startsWith('--platform=')) args.platform = a.slice('--platform='.length);
    else if (a.startsWith('--version=')) args.version = a.slice('--version='.length);
    else if (!a.startsWith('-')) args.version = a;
  }
  return args;
}

function resolvePlatforms(platformKey) {
  if (!platformKey) return PLATFORMS;
  const entry = PLATFORMS.find((p) => p.key === platformKey);
  if (!entry) throw new Error(`Unknown --platform=${platformKey} (known: ${PLATFORMS.map((p) => p.key).join(', ')})`);
  return [entry];
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { version: requestedVersion, force, platform } = parseArgs(process.argv.slice(2));
  const targets = resolvePlatforms(platform);

  if (requestedVersion) {
    console.log(`==> Pinning claude-code to ${requestedVersion} (specified)...`);
    const resolveExpectedSha256 = makeChecksumResolver(requestedVersion);
    for (const { key, file } of targets) {
      await downloadBinary(requestedVersion, key, file, { force, resolveExpectedSha256 });
    }
    promoteToVendorBin(requestedVersion, targets);
    // 指定版本 == bump pin：写回 latest.json，使其成为唯一真相源（install / ensure 据此对齐）。
    await saveCache(await fetchMetaForVersion(requestedVersion));
    console.log('');
    console.log('=== Done ===');
    console.log(`Version: ${requestedVersion}`);
    console.log(`Output:  ${path.join(UPDATES_DIR, requestedVersion)}`);
    console.log(`Bin:     ${BIN_DIR}`);
    return;
  }

  console.log('==> Fetching latest version from npm registry...');
  const meta = await fetchLatestMeta();
  const latestVersion = meta.version;
  if (!latestVersion) throw new Error('No "version" field in npm metadata');

  const cachedVersion = readCachedVersion();
  console.log(`    Latest: ${latestVersion}`);
  console.log(`    Cached: ${cachedVersion ?? '(none)'}`);

  // 仅当目标平台的 updates 文件齐备时才走快捷路径——否则（如 clean checkout：latest.json 已是最新
  // 但 updates/<ver>/<plat> 缺失）必须 fall through 去真正下载，不能只 promote 出一个空 bin 就报成功。
  if (cachedVersion === latestVersion && !force && targetsExist(latestVersion, targets)) {
    await saveCache(meta); // 刷新缓存（保持 JSON 新鲜）
    promoteToVendorBin(latestVersion, targets); // 即使没下载，也确保 bin 与 updates 一致
    console.log('==> Already up to date.');
    return;
  }

  console.log(`==> New version detected (${cachedVersion ?? 'none'} → ${latestVersion}), downloading...`);
  const resolveExpectedSha256 = makeChecksumResolver(latestVersion);
  for (const { key, file } of targets) {
    await downloadBinary(latestVersion, key, file, { force, resolveExpectedSha256 });
  }

  // 所有平台下载成功后再更新缓存，中途失败下一次会自动重试
  await saveCache(meta);
  promoteToVendorBin(latestVersion, targets);

  console.log('');
  console.log('=== Done ===');
  console.log(`Version: ${latestVersion}`);
  console.log(`Output:  ${path.join(UPDATES_DIR, latestVersion)}`);
  console.log(`Bin:     ${BIN_DIR}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
