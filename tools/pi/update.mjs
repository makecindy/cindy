#!/usr/bin/env node

/**
 * update.mjs — 下载 earendil-works/pi GitHub Release 各平台产物
 *
 * 用法：
 *   node tools/pi/update.mjs            # 拉最新版
 *   node tools/pi/update.mjs 0.82.1     # 指定版本（裸版本号，内部拼 v 前缀）
 *
 * 与 claude / codex 的关键差异：pi 的 release 归档不是单文件二进制，而是一个
 * `pi/` 目录（bun compile 主执行文件 + theme / docs / native prebuilds / wasm 等
 * 运行时资产；实测缺 theme/ 时 RPC 模式启动即崩）。因此：
 *   - updates/<version>/<platform>/ 与 apps/pi-bin/<platform>/ 存放的是**整目录内容**，
 *     主执行文件为其中的 pi(.exe)，binaryPath 语义与单文件 kind 一致（指向可执行文件）。
 *   - promote 是目录同步（先清目标再拷贝，避免升级残留旧资产）。
 *   - scripts/ensure-agent-binaries.mjs 对 dirDist kind 跳过 sibling-worktree 单文件复用。
 *
 * 供应链加固：与 codex 同策略——解压前用 GitHub Release asset 元数据的 digest
 * (sha256:<hex>) 校验归档，不符 / 拿不到一律删归档 exit 1（fail-closed）。
 *
 * win32 说明：pi 的 windows 产物是 .zip；本脚本用 `tar -xf` 解压（macOS / Win10+
 * 自带 bsdtar 支持 zip；GNU tar 不支持——在 Linux 上解 win32 产物会失败，目前
 * 没有这条路径的需求）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchJsonWithTimeout, downloadToFileWithTimeout, createDownloadProgressLogger } from '../shared/fetch-with-timeout.mjs';
import { normalizeExpectedSha256, verifyFileSha256OrRemove, sha256File } from '../shared/verify-sha256.mjs';
import { writeDirDistManifest, verifyDirDistManifest } from '../shared/dir-dist-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const RELEASES_LATEST_URL = 'https://api.github.com/repos/earendil-works/pi/releases/latest';
const RELEASES_BY_TAG_URL = (tag) => `https://api.github.com/repos/earendil-works/pi/releases/tags/${tag}`;
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'pi-bin');

// 每个平台缓存目录记录“产出该缓存的归档 digest”(归一 64-hex)。上游若在同一 tag 下替换
// 资产(digest 变、版本号不变),快速路径与 downloadAsset 跳过分支据此重新核验并重下 ——
// 否则会 promote 出与随后写入的 digest pin 不一致的旧缓存(codex review)。缺该标记(旧
// 缓存)按“需重新核验”处理,重下一次即自愈。随 .sha256.bin 一起进目录清单。
const ASSET_DIGEST_FILE = '.asset-digest.bin';

// 平台 → GitHub Release 资产文件名 + 归档内主执行文件名
const PLATFORMS = [
  { key: 'darwin-arm64', asset: 'pi-darwin-arm64.tar.gz', binFile: 'pi' },
  { key: 'darwin-x64', asset: 'pi-darwin-x64.tar.gz', binFile: 'pi' },
  { key: 'linux-x64', asset: 'pi-linux-x64.tar.gz', binFile: 'pi' },
  { key: 'linux-arm64', asset: 'pi-linux-arm64.tar.gz', binFile: 'pi' },
  { key: 'win32-x64', asset: 'pi-windows-x64.zip', binFile: 'pi.exe' },
  { key: 'win32-arm64', asset: 'pi-windows-arm64.zip', binFile: 'pi.exe' },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function ghHeaders() {
  const headers = { 'User-Agent': 'cindy-pi-update' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchReleaseMeta(tag) {
  const url = tag ? RELEASES_BY_TAG_URL(tag) : RELEASES_LATEST_URL;
  return fetchJsonWithTimeout(url, { headers: ghHeaders() });
}

function versionFromTag(tag) {
  const m = tag.match(/^v(\d+\.\d+\.\d+)$/);
  if (!m) throw new Error(`Unexpected tag format: ${tag} (expected vX.Y.Z)`);
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

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Fail closed when mutable GitHub release metadata no longer matches the reviewed pin. */
export function assertPinnedRuntimeAsset(cache, meta, version, platformKey, assetName) {
  if (!cache || cache.version !== version) {
    throw new Error(`Pi runtime pin missing for ${platformKey}@${version}`);
  }
  const pin = cache.runtimeAssets?.[platformKey];
  const asset = (meta.assets || []).find((candidate) => candidate.name === assetName);
  const liveSha256 = normalizeExpectedSha256(asset?.digest);
  if (!pin || !asset || !liveSha256 || liveSha256 !== pin.sha256) {
    throw new Error(`Pi runtime asset digest does not match pin for ${platformKey}@${version}`);
  }
  if (asset.browser_download_url !== pin.url) {
    throw new Error(`Pi runtime asset URL does not match pin for ${platformKey}@${version}`);
  }
  return asset;
}

function runtimeAssetPins(meta, version) {
  return Object.fromEntries(PLATFORMS.map(({ key, asset: assetName }) => {
    const asset = (meta.assets || []).find((candidate) => candidate.name === assetName);
    const sha256 = normalizeExpectedSha256(asset?.digest);
    if (!asset || typeof asset.browser_download_url !== 'string' || !sha256) {
      throw new Error(`Cannot pin pi ${version} ${key}: release asset metadata is incomplete`);
    }
    return [key, {
      url: asset.browser_download_url,
      sha256,
      ...(typeof asset.size === 'number' && asset.size > 0 ? { size: asset.size } : {}),
    }];
  }));
}

function saveCache(meta, version) {
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

/** 读取平台缓存目录记录的归档 digest(归一 64-hex);缺失/非法 → null。 */
export function readCachedAssetDigest(destDir) {
  try {
    return normalizeExpectedSha256(fs.readFileSync(path.join(destDir, ASSET_DIGEST_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** 纯比较:缓存记录的归档 digest 是否与上游 release 资产 digest 一致(任一缺失即 false)。 */
export function assetDigestMatchesUpstream(recordedDigest, asset) {
  const upstream = normalizeExpectedSha256(asset?.digest);
  const recorded = normalizeExpectedSha256(recordedDigest);
  return !!upstream && !!recorded && recorded === upstream;
}

/** 所有目标平台缓存记录的归档 digest 都与上游一致(同 tag 资产被替换时会不一致)。 */
function targetsMatchUpstreamDigest(meta, version, targets) {
  return targets.every(({ key, asset: assetName }) => {
    const asset = (meta.assets || []).find((candidate) => candidate.name === assetName);
    return assetDigestMatchesUpstream(
      readCachedAssetDigest(path.join(UPDATES_DIR, version, key)),
      asset,
    );
  });
}

const LFS_POINTER_HEADER = 'version https://git-lfs.github.com/spec/v1';

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

/**
 * 指定版本下，目标平台的 updates/<version>/<platform>/ 是否都已是可用缓存。
 * 目录分发必须连同旁侧资产一并校验:主二进制在、但 theme / native prebuild 等被删时,
 * 「已是最新」的外层 early-return 会直接 promote 残缺目录(绕过 downloadAsset 的提取期
 * 清单校验),事后再生成的自洽 manifest 也拦不住(codex review)。此处按提取期写入的清单
 * 校验整目录,任一平台不完整即返回 false,让 main() 落到 downloadAsset 重下补齐。
 */
function targetsExist(version, targets) {
  return targets.every(({ key, binFile }) => {
    const dir = path.join(UPDATES_DIR, version, key);
    return isUsableCache(path.join(dir, binFile)) && verifyDirDistManifest(dir);
  });
}

/** 用 tar 解压归档到 destDir；GNU tar 从 stdin 读取 gzip 时必须显式传 -z。 */
export async function extractArchive(archivePath, destDir) {
  const args = archivePath.endsWith('.tar.gz') ? ['-xzf', '-'] : ['-xf', '-'];
  const child = spawn('tar', args, { cwd: destDir, stdio: ['pipe', 'inherit', 'inherit'] });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`))));
  });
  const input = pipeline(fs.createReadStream(archivePath), child.stdin);
  try {
    await Promise.all([input, exit]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled([input, exit]);
    throw error;
  }
}

/**
 * pi 归档解压出唯一的 `pi/` 目录；把其内容上移到 extractDir 本级并删除空壳，
 * 使 updates/<version>/<platform>/ 直接就是可运行的产物目录。
 */
export function flattenExtractedDir(extractDir, expectedBinName) {
  // 新版 Windows zip(v0.83+)已直接把完整 dist 平铺在归档根；Unix tar 仍包在
  // pi/ 目录。两种都是官方布局，先接受已平铺且主程序存在的形态。
  const alreadyFlatBin = path.join(extractDir, expectedBinName);
  if (fs.existsSync(alreadyFlatBin) && fs.statSync(alreadyFlatBin).isFile()) {
    return alreadyFlatBin;
  }
  const innerOriginal = path.join(extractDir, 'pi');
  if (!fs.existsSync(innerOriginal) || !fs.statSync(innerOriginal).isDirectory()) {
    const entries = fs.readdirSync(extractDir);
    throw new Error(`No pi/ directory found after extracting to ${extractDir}; got: ${entries.join(', ')}`);
  }
  // 归档内目录名 pi/ 与其中的主二进制 pi 同名——直接上移会撞名（EISDIR），
  // 先把内层目录改成临时名再逐个上移。
  const inner = path.join(extractDir, '.pi-extract-tmp');
  fs.renameSync(innerOriginal, inner);
  for (const name of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, name), path.join(extractDir, name));
  }
  fs.rmdirSync(inner);
  const binPath = path.join(extractDir, expectedBinName);
  if (!fs.existsSync(binPath)) {
    throw new Error(`Extracted pi dist missing main executable: ${binPath}`);
  }
  return binPath;
}

async function downloadAsset(meta, version, platformKey, assetName, finalBinName, { force = false, throughputGuard = false } = {}) {
  const asset = (meta.assets || []).find((a) => a.name === assetName);
  if (!asset) throw new Error(`Asset not found in release: ${assetName} (tag ${meta.tag_name})`);

  const destDir = path.join(UPDATES_DIR, version, platformKey);
  const finalBinPath = path.join(destDir, finalBinName);

  if (!force && isUsableCache(finalBinPath)) {
    const sha256Path = finalBinPath + '.sha256.bin';
    // 目录分发的“缓存可用”不能只看主二进制 + 其 sha256:缓存目录若丢了 theme /
    // native prebuild 等旁侧资产(磁盘损坏/被误删),主二进制仍在也不能跳过 —— 否则
    // promote 会把残缺目录打进安装包,且事后从残缺目录生成的 manifest 反而“自洽通过”
    // (codex review)。这里对提取期写入的完整清单校验整目录,任一资产缺失即重下。
    // 除主二进制自哈希 + 目录清单外,还须核验缓存记录的归档 digest 与当前上游一致:同 tag
    // 资产被替换(digest 变、版本号不变)时,缓存对自身自洽却与上游 pin 不符,不能跳过。
    if (
      fs.existsSync(sha256Path)
      && verifyDirDistManifest(destDir)
      && assetDigestMatchesUpstream(readCachedAssetDigest(destDir), asset)
    ) {
      const storedHash = fs.readFileSync(sha256Path, 'utf8').trim();
      verifyFileSha256OrRemove(finalBinPath, storedHash, `pi ${platformKey} binary v${version} (cached)`);
      const size = fs.statSync(finalBinPath).size;
      console.log(`  [${platformKey}] skip (cached, sha256 ok, manifest complete, digest pinned, ${formatMB(size)})`);
      return;
    }
    console.log(`  [${platformKey}] cache stale (missing sha256 marker / incomplete manifest / upstream digest changed), re-downloading for verification...`);
  }

  // 目录形态：重下前清空平台目录，避免旧版本资产残留混入新版本。
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const url = asset.browser_download_url;
  const expectedDigest = asset.digest;
  if (!expectedDigest) {
    throw new Error(
      `pi ${platformKey} asset ${assetName}@${version}: digest field absent — ` +
      `GitHub only provides asset digests for releases published after 2025-06-03.`,
    );
  }
  console.log(`  [${platformKey}] ${url}`);

  const archiveExt = assetName.endsWith('.zip') ? 'zip' : 'tar.gz';
  const tmpArchive = path.join(os.tmpdir(), `pi-${version}-${platformKey}-${Date.now()}.${archiveExt}`);
  const progress = createDownloadProgressLogger(platformKey);
  try {
    await downloadToFileWithTimeout(url, tmpArchive, { headers: ghHeaders() }, {
      onProgress: progress.onProgress,
      minThroughputBytesPerSec: throughputGuard ? undefined : 0,
    });
  } finally {
    progress.finish();
  }

  try {
    const verifiedDigest = verifyFileSha256OrRemove(
      tmpArchive,
      expectedDigest,
      `pi ${platformKey} asset ${assetName}@${version}`,
    );
    console.log(`    [${platformKey}] sha256 ok`);

    await extractArchive(tmpArchive, destDir);
    flattenExtractedDir(destDir, finalBinName);
    fs.writeFileSync(finalBinPath + '.sha256.bin', sha256File(finalBinPath) + '\n');
    // 记录产出该缓存的归档 digest,供后续快速路径 / 跳过分支对上游同 tag 资产替换做核验。
    fs.writeFileSync(path.join(destDir, ASSET_DIGEST_FILE), verifiedDigest + '\n');
    // 提取期(刚从已校验 digest 的归档解出、目录必然完整)写入清单,作为后续“缓存
    // 是否完整”的权威基线;事后 promote 从残缺缓存再生成的清单不能当完整性依据。
    writeDirDistManifest(destDir);

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
 * 把 updates/<version>/<platform>/（整目录）同步到 apps/pi-bin/<platform>/。
 * 先清目标目录再拷贝（升级不留旧资产）；目标被占用（app 运行中）warn 跳过。
 */
function promoteOnePlatform(version, key, binFile) {
  const srcDir = path.join(UPDATES_DIR, version, key);
  const srcBin = path.join(srcDir, binFile);
  const destDir = path.join(BIN_DIR, key);
  const destBin = path.join(destDir, binFile);

  if (!fs.existsSync(srcBin)) {
    console.warn(`  [${key}] WARN: source missing, skipping (${srcBin})`);
    return;
  }

  try {
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'ETXTBSY' || err.code === 'EPERM') {
      console.warn(`  [${key}] WARN: target locked (probably running). Close the app and re-run, or copy manually:`);
      console.warn(`         cp -R "${srcDir}/" "${destDir}/"`);
      return;
    }
    throw err;
  }
  if (!binFile.endsWith('.exe')) {
    try { fs.chmodSync(destBin, 0o755); } catch { /* ignore */ }
  }

  // 安装清单先于版本标记写入(标记是提交点):ensure-agent-binaries 的 skip 判定用
  // 清单校验旁侧资产完整性,只验主执行文件会把 theme/ 等被删的残缺目录当"已就位"。
  writeDirDistManifest(destDir);
  // 写版本标记，供 scripts/ensure-agent-binaries.mjs 判断是否需要随 pin 升级刷新
  try { fs.writeFileSync(path.join(destDir, '.version'), version + '\n'); } catch { /* ignore */ }

  const size = fs.statSync(destBin).size;
  console.log(`  [${key}] → ${destBin} (${formatMB(size)})`);
}

function promoteToVendorBin(version, platforms = PLATFORMS) {
  console.log('');
  console.log(`==> Promoting to apps/pi-bin/ ...`);
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
 * 确保单个平台的产物就位：解析对应 release tag、下载并 promote 到 apps/pi-bin/<platformKey>/。
 */
export async function ensurePlatform({ version, platformKey, force = false }) {
  const entry = PLATFORMS.find((p) => p.key === platformKey);
  if (!entry) throw new Error(`Unknown platform key for pi: ${platformKey}`);
  const meta = await fetchReleaseMeta(`v${version}`);
  assertPinnedRuntimeAsset(readCache(), meta, version, platformKey, entry.asset);
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
    const tag = `v${requestedVersion}`;
    console.log(`==> Pinning pi to ${requestedVersion} (specified, tag=${tag})...`);
    const meta = await fetchReleaseMeta(tag);
    for (const { key, asset, binFile } of targets) {
      await downloadAsset(meta, requestedVersion, key, asset, binFile, { force });
    }
    promoteToVendorBin(requestedVersion, targets);
    saveCache(meta, requestedVersion);
    console.log('');
    console.log('=== Done ===');
    console.log(`Version: ${requestedVersion}`);
    console.log(`Output:  ${path.join(UPDATES_DIR, requestedVersion)}`);
    console.log(`Bin:     ${BIN_DIR}`);
    return;
  }

  console.log('==> Fetching latest release from GitHub (earendil-works/pi)...');
  const meta = await fetchReleaseMeta(null);
  const latestVersion = versionFromTag(meta.tag_name);

  const cachedVersion = readCachedVersion();
  console.log(`    Latest: ${latestVersion} (${meta.tag_name})`);
  console.log(`    Cached: ${cachedVersion ?? '(none)'}`);

  // 版本号相同还不够:同 tag 资产被替换(digest 变)时,缓存对自身自洽却与上游 pin 不符,
  // 直接 promote 会打进与随后写入的 digest pin 不一致的旧 runtime。故快速路径额外要求每个
  // 平台缓存记录的归档 digest 与当前上游一致,否则落到下载分支按新 digest 重下。
  if (
    cachedVersion === latestVersion
    && !force
    && targetsExist(latestVersion, targets)
    && targetsMatchUpstreamDigest(meta, latestVersion, targets)
  ) {
    saveCache(meta, latestVersion);
    promoteToVendorBin(latestVersion, targets);
    console.log('==> Already up to date.');
    return;
  }

  console.log(`==> New version detected (${cachedVersion ?? 'none'} → ${latestVersion}), downloading...`);
  for (const { key, asset, binFile } of targets) {
    await downloadAsset(meta, latestVersion, key, asset, binFile, { force });
  }

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
