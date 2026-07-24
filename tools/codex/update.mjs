#!/usr/bin/env node

/**
 * update.mjs — 下载 openai/codex GitHub Release 各平台可执行文件
 *
 * 用法：
 *   node tools/codex/update.mjs            # 拉最新版
 *   node tools/codex/update.mjs 0.128.0    # 指定版本（裸版本号，内部拼 rust-v 前缀）
 *
 * 流程（不指定版本）：
 *   1. 拉取 GitHub Releases 的 latest 元数据（tag 形如 rust-v0.128.0）
 *   2. 与本地缓存 latest.json 对比 version
 *   3. 版本相同：仅刷新本地 JSON 缓存 + 重新 promote bin，退出
 *   4. 版本不同：下载 tar.gz → 解压 → 改名为 codex(.exe)
 *      到 tools/codex/updates/{version}/{platform}/，全部成功后写缓存
 *
 * 流程（指定版本）：
 *   直接下载到 tools/codex/updates/{version}/{platform}/
 *   已存在的文件会跳过（用 --force 覆盖），不写缓存 JSON
 *
 * 供应链加固：每次真正下载(非跳过)的 tar.gz 归档,解压前先用 GitHub Release asset 元数据里的
 * digest 字段(sha256:<hex>,与下载 URL 出自同一 API 响应)做 sha256 校验,不符 / 拿不到 digest
 * 一律删归档并 exit 1(fail-closed),绝不解压 / 落地。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchJsonWithTimeout, downloadToFileWithTimeout, createDownloadProgressLogger } from '../shared/fetch-with-timeout.mjs';
import { normalizeExpectedSha256, verifyFileSha256OrRemove, sha256File } from '../shared/verify-sha256.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const RELEASES_LATEST_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const RELEASES_BY_TAG_URL = (tag) => `https://api.github.com/repos/openai/codex/releases/tags/${tag}`;
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'codex-bin');

// 平台 → GitHub Release 资产文件名 + 解压后的 binary 名
const PLATFORMS = [
  {
    key: 'darwin-arm64',
    asset: 'codex-aarch64-apple-darwin.tar.gz',
    binFile: 'codex',
  },
  {
    key: 'darwin-x64',
    asset: 'codex-x86_64-apple-darwin.tar.gz',
    binFile: 'codex',
  },
  {
    key: 'linux-x64',
    // Verified 2026-06-17 from the official openai/codex GitHub release asset
    // list: x86_64 Linux is published as the musl tarball, not a gnu/glibc one.
    asset: 'codex-x86_64-unknown-linux-musl.tar.gz',
    binFile: 'codex',
  },
  {
    key: 'linux-arm64',
    // Verified 2026-07-24 from the official openai/codex GitHub release asset
    // list: aarch64 Linux is likewise published as the musl tarball only.
    asset: 'codex-aarch64-unknown-linux-musl.tar.gz',
    binFile: 'codex',
  },
  {
    key: 'win32-x64',
    asset: 'codex-x86_64-pc-windows-msvc.exe.tar.gz',
    binFile: 'codex.exe',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function ghHeaders() {
  const headers = { 'User-Agent': 'cindy-codex-update' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchReleaseMeta(tag) {
  const url = tag ? RELEASES_BY_TAG_URL(tag) : RELEASES_LATEST_URL;
  return fetchJsonWithTimeout(url, { headers: ghHeaders() });
}

function versionFromTag(tag) {
  const m = tag.match(/^rust-v(\d+\.\d+\.\d+)$/);
  if (!m) throw new Error(`Unexpected tag format: ${tag} (expected rust-vX.Y.Z)`);
  return m[1];
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

function runtimeAssetPins(meta, version) {
  return Object.fromEntries(PLATFORMS.map(({ key, asset: assetName }) => {
    const asset = (meta.assets || []).find((candidate) => candidate.name === assetName);
    const sha256 = normalizeExpectedSha256(asset?.digest);
    if (!asset || typeof asset.browser_download_url !== 'string' || !sha256) {
      throw new Error(`Cannot pin codex ${version} ${key}: release asset metadata is incomplete`);
    }
    return [key, {
      url: asset.browser_download_url,
      sha256,
      ...(typeof asset.size === 'number' && asset.size > 0 ? { size: asset.size } : {}),
    }];
  }));
}

function saveCache(meta, version) {
  // 缓存结构对齐 claude 的 latest.json：保留 version 字段供下次 readCachedVersion 比对
  const cache = {
    version,
    tag_name: meta.tag_name,
    name: meta.name,
    published_at: meta.published_at,
    runtimeAssets: runtimeAssetPins(meta, version),
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
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

/** 指定版本下，目标平台的 updates/<version>/<platform>/<binFile> 是否都已是可用缓存。 */
function targetsExist(version, targets) {
  return targets.every(({ key, binFile }) => isUsableCache(path.join(UPDATES_DIR, version, key, binFile)));
}

async function extractTarGz(archivePath, destDir) {
  // 把 archive 通过 stdin 喂给 tar，并用 cwd 切到 destDir——避开 GNU tar 在 Windows 上
  // 把含冒号的路径（如 "C:\..."、"E:\..."）误判为远程主机的坑。tar 在 Win10+ / macOS 都自带。
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', '-'], { cwd: destDir, stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
    fs.createReadStream(archivePath).pipe(child.stdin);
  });
}

/**
 * 解压后的目录里只会有一个 codex-* 文件（GitHub release 的 tar.gz 都是单 binary 归档）
 * 找到它并重命名为标准的 codex / codex.exe。
 */
function findAndRenameBinary(extractDir, expectedFinalName) {
  const entries = fs.readdirSync(extractDir);
  const binCandidate = entries.find((name) => name.startsWith('codex-') && !name.endsWith('.tar.gz'));
  if (!binCandidate) {
    throw new Error(`No codex-* binary found after extracting to ${extractDir}; got: ${entries.join(', ')}`);
  }
  const srcPath = path.join(extractDir, binCandidate);
  const destPath = path.join(extractDir, expectedFinalName);
  if (srcPath !== destPath) {
    fs.renameSync(srcPath, destPath);
  }
  return destPath;
}

// throughputGuard：龟速掐断只允许 install 链路（ensurePlatform）开启——那条链有 CDN 兜底；
// update CLI 直连上游无兜底（CDN 不会有比 release 更新的版本），掐断只会把"慢但能成"变成失败。
async function downloadAsset(meta, version, platformKey, assetName, finalBinName, { force = false, throughputGuard = false } = {}) {
  const asset = (meta.assets || []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`Asset not found in release: ${assetName} (tag ${meta.tag_name})`);

  const destDir = path.join(UPDATES_DIR, version, platformKey);
  const finalBinPath = path.join(destDir, finalBinName);

  fs.mkdirSync(destDir, { recursive: true });

  if (!force && isUsableCache(finalBinPath)) {
    const sha256Path = finalBinPath + '.sha256.bin';
    if (fs.existsSync(sha256Path)) {
      const storedHash = fs.readFileSync(sha256Path, 'utf8').trim();
      verifyFileSha256OrRemove(finalBinPath, storedHash, `codex ${platformKey} binary v${version} (cached)`);
      const size = fs.statSync(finalBinPath).size;
      console.log(`  [${platformKey}] skip (cached, sha256 ok, ${formatMB(size)})`);
      return;
    }
    // No sha256 sidecar = pre-hardening cache; fail-closed: delete and re-download with verification
    console.log(`  [${platformKey}] cached binary missing sha256 marker, re-downloading for verification...`);
    try { fs.rmSync(finalBinPath); } catch { /* ignore */ }
  }

  const url = asset.browser_download_url;
  // GitHub 对每个 release asset 计算的内容 digest（"sha256:<hex>"），与下载 URL 出自同一
  // api.github.com 响应、同源 TLS——作为下载校验的可信 sha256 来源。
  const expectedDigest = asset.digest;
  if (!expectedDigest) {
    throw new Error(
      `codex ${platformKey} asset ${assetName}@${version}: digest field absent — ` +
      `GitHub only provides asset digests for releases published after 2025-06-03; ` +
      `this release predates that support. Pin to a newer codex release.`,
    );
  }
  console.log(`  [${platformKey}] ${url}`);

  // 下载到临时 tar.gz（放在 OS tmp，避免 updates 目录里出现归档残留）
  const tmpArchive = path.join(os.tmpdir(), `codex-${version}-${platformKey}-${Date.now()}.tar.gz`);
  const progress = createDownloadProgressLogger(platformKey);
  try {
    await downloadToFileWithTimeout(url, tmpArchive, { headers: ghHeaders() }, {
      onProgress: progress.onProgress,
      minThroughputBytesPerSec: throughputGuard ? undefined : 0, // undefined → env/默认值生效
    });
  } finally {
    progress.finish();
  }

  try {
    // 供应链加固：解压前先校验归档 sha256；不符 / 拿不到 digest → 删归档并抛错（fail-closed，绝不解压）。
    verifyFileSha256OrRemove(tmpArchive, expectedDigest, `codex ${platformKey} asset ${assetName}@${version}`);
    console.log(`    [${platformKey}] sha256 ok`);

    // 解压到 destDir
    await extractTarGz(tmpArchive, destDir);
    findAndRenameBinary(destDir, finalBinName);
    fs.writeFileSync(finalBinPath + '.sha256.bin', sha256File(finalBinPath) + '\n');

    // darwin 需要可执行权限
    if (!finalBinName.endsWith('.exe')) {
      try { fs.chmodSync(finalBinPath, 0o755); } catch { /* ignore */ }
    }

    const size = fs.statSync(finalBinPath).size;
    console.log(`    → ${finalBinPath} (${formatMB(size)})`);
  } finally {
    try { fs.unlinkSync(tmpArchive); } catch { /* ignore */ }
  }
}

/**
 * 把单个平台的 updates/<version>/<platform>/<binary> 拷到 apps/codex-bin/<platform>/。
 * 源文件缺失会 warn 跳过；目标被占用（app 运行中）也 warn 跳过。
 */
function promoteOnePlatform(version, key, binFile) {
  const srcPath = path.join(UPDATES_DIR, version, key, binFile);
  const destDir = path.join(BIN_DIR, key);
  const destPath = path.join(destDir, binFile);

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
  if (!binFile.endsWith('.exe')) {
    try { fs.chmodSync(destPath, 0o755); } catch { /* ignore */ }
  }

  // 写版本标记，供 scripts/ensure-agent-binaries.mjs 判断是否需要随 pin 升级刷新
  try { fs.writeFileSync(path.join(destDir, '.version'), version + '\n'); } catch { /* ignore */ }

  const size = fs.statSync(destPath).size;
  console.log(`  [${key}] → ${destPath} (${formatMB(size)})`);
}

/**
 * 把 updates/<version>/<platform>/<binary> 同步到 apps/codex-bin/<platform>/<binary>。
 * 只有当源文件存在时才覆盖目标——某平台缺失会 warn 跳过。
 */
function promoteToVendorBin(version, platforms = PLATFORMS) {
  console.log('');
  console.log(`==> Promoting to apps/codex-bin/ ...`);
  for (const { key, binFile } of platforms) {
    promoteOnePlatform(version, key, binFile);
  }
}

// ── Programmatic API（供 scripts/ensure-agent-binaries.mjs 复用） ─────────────

/** 读 latest.json 里 pin 的版本号（按需下载以此为准，不取 upstream latest）。 */
export function readPinnedVersion() {
  return readCachedVersion();
}

/**
 * 确保单个平台的二进制就位：解析对应 release tag、下载并 promote 到 apps/codex-bin/<platformKey>/。
 * downloadAsset 对已存在文件会自动跳过（除非 force）。
 */
export async function ensurePlatform({ version, platformKey, force = false }) {
  const entry = PLATFORMS.find((p) => p.key === platformKey);
  if (!entry) throw new Error(`Unknown platform key for codex: ${platformKey}`);
  const meta = await fetchReleaseMeta(`rust-v${version}`);
  // install 链路（ensure-agent-binaries）有 CDN 兜底，开启吞吐守卫尽早切换
  await downloadAsset(meta, version, platformKey, entry.asset, entry.binFile, { force, throughputGuard: true });
  promoteOnePlatform(version, platformKey, entry.binFile);
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
    const tag = `rust-v${requestedVersion}`;
    console.log(`==> Pinning codex to ${requestedVersion} (specified, tag=${tag})...`);
    const meta = await fetchReleaseMeta(tag);
    for (const { key, asset, binFile } of targets) {
      await downloadAsset(meta, requestedVersion, key, asset, binFile, { force });
    }
    promoteToVendorBin(requestedVersion, targets);
    // 指定版本 == bump pin：写回 latest.json，使其成为唯一真相源（install / ensure 据此对齐）。
    saveCache(meta, requestedVersion);
    console.log('');
    console.log('=== Done ===');
    console.log(`Version: ${requestedVersion}`);
    console.log(`Output:  ${path.join(UPDATES_DIR, requestedVersion)}`);
    console.log(`Bin:     ${BIN_DIR}`);
    return;
  }

  console.log('==> Fetching latest release from GitHub (openai/codex)...');
  const meta = await fetchReleaseMeta(null);
  const latestVersion = versionFromTag(meta.tag_name);

  const cachedVersion = readCachedVersion();
  console.log(`    Latest: ${latestVersion} (${meta.tag_name})`);
  console.log(`    Cached: ${cachedVersion ?? '(none)'}`);

  // 仅当目标平台的 updates 文件齐备时才走快捷路径——否则（如 clean checkout：latest.json 已是最新
  // 但 updates/<ver>/<plat> 缺失）必须 fall through 去真正下载，不能只 promote 出一个空 bin 就报成功。
  if (cachedVersion === latestVersion && !force && targetsExist(latestVersion, targets)) {
    saveCache(meta, latestVersion); // 刷新缓存
    promoteToVendorBin(latestVersion, targets); // 即使没下载，也确保 bin 与 updates 一致
    console.log('==> Already up to date.');
    return;
  }

  console.log(`==> New version detected (${cachedVersion ?? 'none'} → ${latestVersion}), downloading...`);
  for (const { key, asset, binFile } of targets) {
    await downloadAsset(meta, latestVersion, key, asset, binFile, { force });
  }

  // 所有平台下载成功后再更新缓存，中途失败下一次会自动重试
  saveCache(meta, latestVersion);
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
