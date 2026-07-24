#!/usr/bin/env node

/**
 * Download official ripgrep release binaries from BurntSushi/ripgrep.
 *
 * Usage:
 *   node tools/ripgrep/update.mjs
 *   node tools/ripgrep/update.mjs 15.1.0
 *   node tools/ripgrep/update.mjs --version=15.1.0 --force
 *
 * The script intentionally uses only the official GitHub release assets and
 * verifies each archive against the matching official .sha256 asset.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const REPO = 'BurntSushi/ripgrep';
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_BY_TAG_URL = (tag) => `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
const CACHE_FILE = path.join(__dirname, 'latest.json');
const UPDATES_DIR = path.join(__dirname, 'updates');
const BIN_DIR = path.join(PROJECT_ROOT, 'apps', 'ripgrep-bin');

const PLATFORMS = [
  {
    key: 'darwin-arm64',
    triple: 'aarch64-apple-darwin',
    archiveExt: 'tar.gz',
    binFile: 'rg',
  },
  {
    key: 'darwin-x64',
    triple: 'x86_64-apple-darwin',
    archiveExt: 'tar.gz',
    binFile: 'rg',
  },
  {
    key: 'linux-x64',
    // Verified 2026-06-17 from the official BurntSushi/ripgrep release asset
    // list: x86_64 Linux includes a musl tarball and not a gnu/glibc tarball.
    triple: 'x86_64-unknown-linux-musl',
    archiveExt: 'tar.gz',
    binFile: 'rg',
  },
  {
    key: 'linux-arm64',
    // Verified 2026-07-24 from the official BurntSushi/ripgrep release asset
    // list: aarch64 Linux only ships a gnu/glibc tarball (no musl variant).
    triple: 'aarch64-unknown-linux-gnu',
    archiveExt: 'tar.gz',
    binFile: 'rg',
  },
  {
    key: 'win32-x64',
    triple: 'x86_64-pc-windows-msvc',
    archiveExt: 'zip',
    binFile: 'rg.exe',
  },
];

function ghHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'cindy-ripgrep-update',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

function usage() {
  console.log(`Usage:
  pnpm update:ripgrep
  pnpm update:ripgrep 15.1.0
  pnpm update:ripgrep --version=15.1.0 --force

Downloads official stable ripgrep binaries from https://github.com/${REPO}/releases
and verifies every archive with the matching official .sha256 asset.`);
}

function parseArgs(argv) {
  const args = { version: null, force: false, help: false, platform: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--force' || a === '-f') args.force = true;
    else if (a.startsWith('--platform=')) args.platform = a.slice('--platform='.length);
    else if (a.startsWith('--version=')) args.version = a.slice('--version='.length);
    else if (!a.startsWith('-')) args.version = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function resolvePlatforms(platformKey) {
  if (!platformKey) return PLATFORMS;
  const platform = PLATFORMS.find((p) => p.key === platformKey);
  if (!platform) throw new Error(`Unknown --platform=${platformKey} (known: ${PLATFORMS.map((p) => p.key).join(', ')})`);
  return [platform];
}

function normalizeVersion(version) {
  const v = version.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`Invalid ripgrep version: ${version} (expected X.Y.Z)`);
  }
  return v;
}

function versionFromTag(tag) {
  return normalizeVersion(String(tag));
}

function assertStableRelease(meta) {
  if (!meta || typeof meta !== 'object') throw new Error('Malformed GitHub release metadata');
  if (meta.draft) throw new Error(`Refusing draft release: ${meta.tag_name}`);
  if (meta.prerelease) throw new Error(`Refusing prerelease: ${meta.tag_name}`);
  if (!Array.isArray(meta.assets)) throw new Error(`Release ${meta.tag_name} has no assets array`);
}

async function fetchReleaseMeta(tag) {
  const url = tag ? RELEASES_BY_TAG_URL(tag) : RELEASES_LATEST_URL;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub releases ${res.status}: ${url}`);
  const meta = await res.json();
  assertStableRelease(meta);
  return meta;
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

function saveCache(meta, version) {
  const cache = {
    version,
    tag_name: meta.tag_name,
    name: meta.name,
    html_url: meta.html_url,
    prerelease: meta.prerelease,
    draft: meta.draft,
    published_at: meta.published_at,
  };
  fs.mkdirSync(__dirname, { recursive: true });
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

function archiveName(version, platform) {
  return `ripgrep-${version}-${platform.triple}.${platform.archiveExt}`;
}

function findAsset(meta, name) {
  const asset = meta.assets.find((a) => a.name === name);
  if (!asset?.browser_download_url) {
    throw new Error(`Asset not found in ${meta.tag_name}: ${name}`);
  }
  return asset;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  return await res.text();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Download returned no body: ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const bytes = fs.readFileSync(filePath);
  hash.update(bytes);
  return hash.digest('hex');
}

function parseSha256(text, name) {
  const match = text.match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) throw new Error(`No SHA256 hash found in ${name}`);
  return match[0].toLowerCase();
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...opts,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : '';
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}${suffix}`));
    });
  });
}

async function extractTarGz(archivePath, destDir) {
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', '-'], {
      cwd: destDir,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = stderr.trim() ? `\n${stderr.trim()}` : '';
      reject(new Error(`tar exited with code ${code}${suffix}`));
    });
    fs.createReadStream(archivePath).pipe(child.stdin);
  });
}

async function extractZip(archivePath, destDir) {
  const errors = [];

  try {
    await runCommand('tar', ['-xf', archivePath, '-C', destDir]);
    return;
  } catch (err) {
    errors.push(`tar: ${err.message}`);
  }

  if (process.platform === 'win32') {
    try {
      await runCommand('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath,
        destDir,
      ]);
      return;
    } catch (err) {
      errors.push(`powershell Expand-Archive: ${err.message}`);
    }
  }

  try {
    await runCommand('unzip', ['-q', archivePath, '-d', destDir]);
    return;
  } catch (err) {
    errors.push(`unzip: ${err.message}`);
  }

  throw new Error(`Failed to extract zip archive ${archivePath}\n${errors.join('\n')}`);
}

async function extractArchive(archivePath, archiveExt, destDir) {
  if (archiveExt === 'tar.gz') {
    await extractTarGz(archivePath, destDir);
    return;
  }
  if (archiveExt === 'zip') {
    await extractZip(archivePath, destDir);
    return;
  }
  throw new Error(`Unsupported archive extension: ${archiveExt}`);
}

function findFileRecursive(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return p;
    if (entry.isDirectory()) {
      const nested = findFileRecursive(p, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

function allUpdateBinariesExist(version) {
  return PLATFORMS.every((platform) => (
    isUsableCache(path.join(UPDATES_DIR, version, platform.key, platform.binFile))
  ));
}

async function downloadPlatform(meta, version, platform, { force = false } = {}) {
  const name = archiveName(version, platform);
  const shaName = `${name}.sha256`;
  const archiveAsset = findAsset(meta, name);
  const shaAsset = findAsset(meta, shaName);
  const destDir = path.join(UPDATES_DIR, version, platform.key);
  const finalBinPath = path.join(destDir, platform.binFile);

  fs.mkdirSync(destDir, { recursive: true });
  if (!force && isUsableCache(finalBinPath)) {
    const size = fs.statSync(finalBinPath).size;
    console.log(`  [${platform.key}] skip (already exists, ${formatMB(size)})`);
    return;
  }

  console.log(`  [${platform.key}] ${archiveAsset.browser_download_url}`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ripgrep-${version}-${platform.key}-`));
  const tmpArchive = path.join(tmpRoot, name);
  const extractDir = path.join(tmpRoot, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const shaText = await fetchText(shaAsset.browser_download_url);
    const expectedHash = parseSha256(shaText, shaName);

    await downloadFile(archiveAsset.browser_download_url, tmpArchive);
    const actualHash = sha256File(tmpArchive);
    if (actualHash !== expectedHash) {
      throw new Error(`SHA256 mismatch for ${name}: expected ${expectedHash}, got ${actualHash}`);
    }

    await extractArchive(tmpArchive, platform.archiveExt, extractDir);
    const extractedBin = findFileRecursive(extractDir, platform.binFile);
    if (!extractedBin) {
      throw new Error(`No ${platform.binFile} found in ${name}`);
    }

    fs.copyFileSync(extractedBin, finalBinPath);
    if (!platform.binFile.endsWith('.exe')) {
      try { fs.chmodSync(finalBinPath, 0o755); } catch { /* ignore */ }
    }

    const size = fs.statSync(finalBinPath).size;
    console.log(`    -> ${finalBinPath} (${formatMB(size)}, sha256 ok)`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function promoteOnePlatform(version, platform) {
  const srcPath = path.join(UPDATES_DIR, version, platform.key, platform.binFile);
  const destDir = path.join(BIN_DIR, platform.key);
  const destPath = path.join(destDir, platform.binFile);

  if (!fs.existsSync(srcPath)) {
    console.warn(`  [${platform.key}] WARN: source missing, skipping (${srcPath})`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.copyFileSync(srcPath, destPath);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'ETXTBSY') {
      console.warn(`  [${platform.key}] WARN: target locked (probably running). Close the app and re-run, or copy manually:`);
      console.warn(`         cp "${srcPath}" "${destPath}"`);
      return;
    }
    throw err;
  }
  if (!platform.binFile.endsWith('.exe')) {
    try { fs.chmodSync(destPath, 0o755); } catch { /* ignore */ }
  }

  // 写版本标记，供 scripts/ensure-agent-binaries.mjs 判断是否需要随 pin 升级刷新
  try { fs.writeFileSync(path.join(destDir, '.version'), version + '\n'); } catch { /* ignore */ }

  const size = fs.statSync(destPath).size;
  console.log(`  [${platform.key}] -> ${destPath} (${formatMB(size)})`);
}

function promoteToVendorBin(version, platforms = PLATFORMS) {
  console.log('');
  console.log('==> Promoting to apps/ripgrep-bin/ ...');
  for (const platform of platforms) {
    promoteOnePlatform(version, platform);
  }
}

async function downloadAll(meta, version, force, platforms = PLATFORMS) {
  for (const platform of platforms) {
    await downloadPlatform(meta, version, platform, { force });
  }
}

// ── Programmatic API（供 scripts/ensure-agent-binaries.mjs 复用） ─────────────

/** 读 latest.json 里 pin 的版本号（按需下载以此为准，不取 upstream latest）。 */
export function readPinnedVersion() {
  return readCachedVersion();
}

/**
 * 确保单个平台的二进制就位：解析对应 release、校验 SHA256、下载并 promote 到 apps/ripgrep-bin/<platformKey>/。
 * downloadPlatform 对已存在文件会自动跳过（除非 force）。
 */
export async function ensurePlatform({ version, platformKey, force = false }) {
  const v = normalizeVersion(version);
  const platform = PLATFORMS.find((p) => p.key === platformKey);
  if (!platform) throw new Error(`Unknown platform key for ripgrep: ${platformKey}`);
  const meta = await fetchReleaseMeta(v);
  await downloadPlatform(meta, v, platform, { force });
  promoteOnePlatform(v, platform);
}

async function main() {
  const { version: requestedVersion, force, help, platform } = parseArgs(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }
  const targets = resolvePlatforms(platform);

  if (requestedVersion) {
    const version = normalizeVersion(requestedVersion);
    console.log(`==> Pinning ripgrep to ${version} (specified)...`);
    const meta = await fetchReleaseMeta(version);
    const releaseVersion = versionFromTag(meta.tag_name);
    if (releaseVersion !== version) {
      throw new Error(`Release tag mismatch: requested ${version}, got ${meta.tag_name}`);
    }
    await downloadAll(meta, version, force, targets);
    promoteToVendorBin(version, targets);
    // 指定版本 == bump pin：写回 latest.json，使其成为唯一真相源（install / ensure 据此对齐）。
    saveCache(meta, version);
    console.log('');
    console.log('=== Done ===');
    console.log(`Version: ${version}`);
    console.log(`Output:  ${path.join(UPDATES_DIR, version)}`);
    console.log(`Bin:     ${BIN_DIR}`);
    return;
  }

  console.log(`==> Fetching latest stable release from GitHub (${REPO})...`);
  const meta = await fetchReleaseMeta(null);
  const latestVersion = versionFromTag(meta.tag_name);
  const cachedVersion = readCachedVersion();
  console.log(`    Latest: ${latestVersion} (${meta.tag_name})`);
  console.log(`    Stable: prerelease=${meta.prerelease}, draft=${meta.draft}`);
  console.log(`    Cached: ${cachedVersion ?? '(none)'}`);

  if (cachedVersion === latestVersion && !force && allUpdateBinariesExist(latestVersion)) {
    saveCache(meta, latestVersion);
    promoteToVendorBin(latestVersion, targets);
    console.log('==> Already up to date.');
    return;
  }

  console.log(`==> Downloading ${latestVersion}...`);
  await downloadAll(meta, latestVersion, force, targets);
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
