/**
 * Packaged Linux runtime fallback for Claude Code / Codex binaries.
 *
 * Linux manifests intentionally do not publish agent assets. The packaged app
 * first reuses a compatible system CLI, then migrates the legacy Cindy-managed
 * cache, and finally downloads the pinned official binary with SHA-256
 * verification. No system Node/npm/curl installation is required.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { app } from 'electron';

import claudeLatest from '../../../../../tools/claude/latest.json';
import codexLatest from '../../../../../tools/codex/latest.json';
import { download, type ProgressEvent } from '../downloader/index.js';

export type LinuxRuntimeFallbackKind = 'claude-code' | 'codex';

interface RuntimeConfig {
  commandName: string;
  version: string;
}

interface OfficialAssetDescriptor {
  url: string;
  sha256: string;
  size?: number;
}

const CONFIG: Record<LinuxRuntimeFallbackKind, RuntimeConfig> = {
  'claude-code': {
    commandName: 'claude',
    version: (claudeLatest as { version: string }).version,
  },
  codex: {
    commandName: 'codex',
    version: (codexLatest as { version: string }).version,
  },
};

const STARTUP_INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 15_000;
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * pin 文件(`tools/{claude,codex}/latest.json`)里 `runtimeAssets` 的键,同时也是
 * Claude 官方下载 URL 的平台段。必须跟随宿主 arch:aarch64 机器上写死 linux-x64
 * 会下到一个根本执行不了的二进制,而下载本身(SHA-256 匹配 x64 资产)是"成功"的,
 * 故障只会推迟到 readExecutableVersion 才暴露。
 */
function linuxPlatformKey(arch: string = process.arch): string {
  return `linux-${arch}`;
}

/**
 * Codex 官方 release 的资产名——只发 musl 静态包,按 Rust target triple 命名。
 * 未知 arch 原样拼进 URL,与 pin 里的 url 必然不等,由
 * pinnedOfficialAssetDescriptor 抛错拦下(fail closed,绝不下错架构的包)。
 */
function codexLinuxAsset(arch: string = process.arch): string {
  const rustArch = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `codex-${rustArch}-unknown-linux-musl.tar.gz`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandLookupScript(commandName: string): string {
  const quotedName = shellQuote(commandName);
  return `
name=${quotedName}
if command -v "$name" >/dev/null 2>&1; then
  command -v "$name"
  exit 0
fi
for dir in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "/usr/local/bin" "/usr/bin"; do
  candidate="$dir/$name"
  if [ -x "$candidate" ]; then
    printf '%s\\n' "$candidate"
    exit 0
  fi
done
exit 1
`.trim();
}

export function runtimeInstallRoot(userDataPath: string, kind: LinuxRuntimeFallbackKind): string {
  return path.join(userDataPath, 'agent-runtime', kind);
}

export function privateBinaryPath(userDataPath: string, kind: LinuxRuntimeFallbackKind): string {
  return path.join(runtimeInstallRoot(userDataPath, kind), 'bin', CONFIG[kind].commandName);
}

function runtimeVersionMarkerPath(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string {
  return path.join(runtimeInstallRoot(userDataPath, kind), '.version');
}

/** Path used by the previous CDN-backed BinaryProvisioner. */
export function legacyManagedBinaryPath(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string {
  return path.join(userDataPath, kind, CONFIG[kind].version, CONFIG[kind].commandName);
}

/** Keep a user-managed npm Claude shim runnable from a desktop-file launch. */
export function claudeLauncherScript(packageBinaryPath: string, nodeBinDir: string): string {
  return `#!/bin/sh
NODE_BIN_DIR=${shellQuote(nodeBinDir)}
export PATH="$NODE_BIN_DIR\${PATH:+:$PATH}"
exec ${shellQuote(packageBinaryPath)} "$@"
`;
}

function materializeSystemClaudeLauncher(candidate: string, nodeBinDir: string): string {
  const destination = privateBinaryPath(app.getPath('userData'), 'claude-code');
  const tempPath = `${destination}.launcher-${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.writeFileSync(tempPath, claudeLauncherScript(candidate, nodeBinDir), {
      encoding: 'utf8',
      mode: 0o755,
    });
    fs.renameSync(tempPath, destination);
    return destination;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
  }
}

function legacyVerifiedMarkerPath(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string {
  return path.join(path.dirname(legacyManagedBinaryPath(userDataPath, kind)), '.verified');
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeRuntimeVersionMarker(userDataPath: string, kind: LinuxRuntimeFallbackKind): void {
  fs.writeFileSync(runtimeVersionMarkerPath(userDataPath, kind), `${CONFIG[kind].version}\n`);
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function parseVersionOutput(versionOutput: string): string | null {
  const match = versionOutput.trim().match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/i);
  return match?.[1] ?? null;
}

/** Cindy-managed binaries must match the repository pin exactly. */
export function runtimeVersionMatchesPin(
  kind: LinuxRuntimeFallbackKind,
  versionOutput: string,
): boolean {
  return parseVersionOutput(versionOutput) === CONFIG[kind].version;
}

/** User-managed runtimes may be newer than the pin, but not older or prerelease-equivalent. */
export function systemRuntimeVersionSupportsPin(
  kind: LinuxRuntimeFallbackKind,
  versionOutput: string,
): boolean {
  const candidate = parseVersionOutput(versionOutput);
  const pinned = parseVersionOutput(CONFIG[kind].version);
  if (!candidate || !pinned) return false;
  if (candidate.includes('-')) return false;
  const candidateCore = candidate.split(/[-+]/, 1)[0].split('.').map(Number);
  const pinnedCore = pinned.split(/[-+]/, 1)[0].split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (candidateCore[index] !== pinnedCore[index]) {
      return candidateCore[index] > pinnedCore[index];
    }
  }
  return true;
}

function probeCancelledError(command: string): Error {
  return new Error(`${path.basename(command)} install cancelled`);
}

/** Run a short CLI probe without blocking Electron's main thread. */
function execProbe(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(probeCancelledError(command));
      return;
    }
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(options.signal?.aborted ? probeCancelledError(command) : error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function findCommandAsync(
  commandName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await execProbe('/bin/sh', ['-c', commandLookupScript(commandName)], {
      signal,
      timeoutMs: LOOKUP_TIMEOUT_MS,
    });
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    if (signal?.aborted) throw probeCancelledError(commandName);
    return null;
  }
}

async function readExecutableVersion(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
    const result = await execProbe(binaryPath, ['--version'], {
      signal,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    return result.stdout || result.stderr;
  } catch {
    if (signal?.aborted) throw probeCancelledError(binaryPath);
    return null;
  }
}

async function findSystemBinaryAsync(
  kind: LinuxRuntimeFallbackKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const candidate = await findCommandAsync(CONFIG[kind].commandName, signal);
  if (!candidate) return null;
  const versionOutput = await readExecutableVersion(candidate, signal);
  if (!versionOutput) return null;
  // Preserve compatible newer user-managed Claude CLIs. Older binaries can
  // reject newly visible models, while Codex's app-server protocol requires
  // an exact repository-pin match.
  if (kind === 'claude-code') {
    if (!systemRuntimeVersionSupportsPin(kind, versionOutput)) return null;
    const nodePath = await findCommandAsync('node', signal);
    if (!nodePath) return candidate;
    try {
      const launcher = materializeSystemClaudeLauncher(candidate, path.dirname(nodePath));
      return await readExecutableVersion(launcher, signal) ? launcher : candidate;
    } catch {
      if (signal?.aborted) throw probeCancelledError(candidate);
      return candidate;
    }
  }
  if (runtimeVersionMatchesPin(kind, versionOutput)) return candidate;
  return null;
}

function privateBinaryCandidates(
  userDataPath: string,
  kind: LinuxRuntimeFallbackKind,
): string[] {
  const canonical = privateBinaryPath(userDataPath, kind);
  if (kind !== 'codex') return [canonical];
  // Compatibility with the first private installer implementation.
  return [
    canonical,
    path.join(
      runtimeInstallRoot(userDataPath, kind),
      'codex-home',
      'packages',
      'standalone',
      'current',
      'codex',
    ),
  ];
}

async function findPrivateBinaryAsync(
  kind: LinuxRuntimeFallbackKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const userDataPath = app.getPath('userData');
  for (const candidate of privateBinaryCandidates(userDataPath, kind)) {
    const versionOutput = await readExecutableVersion(candidate, signal);
    if (versionOutput && runtimeVersionMatchesPin(kind, versionOutput)) {
      writeRuntimeVersionMarker(userDataPath, kind);
      return candidate;
    }
  }
  try { fs.rmSync(runtimeVersionMarkerPath(userDataPath, kind), { force: true }); } catch { /* ignore */ }
  return null;
}

async function migrateLegacyManagedBinary(
  kind: LinuxRuntimeFallbackKind,
  signal?: AbortSignal,
): Promise<string | null> {
  const userDataPath = app.getPath('userData');
  const legacyPath = legacyManagedBinaryPath(userDataPath, kind);
  if (!fs.existsSync(legacyVerifiedMarkerPath(userDataPath, kind))) return null;
  const versionOutput = await readExecutableVersion(legacyPath, signal);
  if (!versionOutput || !runtimeVersionMatchesPin(kind, versionOutput)) return null;

  const destination = privateBinaryPath(userDataPath, kind);
  const tempPath = `${destination}.migrate-${process.pid}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.copyFileSync(legacyPath, tempPath, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(tempPath, 0o755);
    fs.renameSync(tempPath, destination);
    writeRuntimeVersionMarker(userDataPath, kind);
    return destination;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * Synchronous status query: only inspect known paths and version markers. CLI
 * execution and PATH lookup stay on the async startup path.
 */
export function findCachedLinuxRuntimeFallbackBinary(
  kind: LinuxRuntimeFallbackKind,
): string | null {
  if (!app.isPackaged || process.platform !== 'linux') return null;
  const userDataPath = app.getPath('userData');
  if (readText(runtimeVersionMarkerPath(userDataPath, kind)) === CONFIG[kind].version) {
    for (const candidate of privateBinaryCandidates(userDataPath, kind)) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next compatible private layout.
      }
    }
  }

  const legacyPath = legacyManagedBinaryPath(userDataPath, kind);
  try {
    fs.accessSync(legacyPath, fs.constants.X_OK);
    fs.accessSync(legacyVerifiedMarkerPath(userDataPath, kind));
    return legacyPath;
  } catch {
    return null;
  }
}

/**
 * Read an official asset URL and checksum committed alongside the version pin.
 * `arch` 只为测试可注入而暴露,生产调用一律走宿主 arch。
 */
export function pinnedOfficialAssetDescriptor(
  kind: LinuxRuntimeFallbackKind,
  version: string,
  pin: unknown,
  arch: string = process.arch,
): OfficialAssetDescriptor {
  const platformKey = linuxPlatformKey(arch);
  const entry = (pin as {
    runtimeAssets?: Record<string, { url?: unknown; sha256?: unknown; size?: unknown }>;
  })?.runtimeAssets?.[platformKey];
  const sha256 = normalizeSha256(entry?.sha256);
  const expectedUrl = kind === 'claude-code'
    ? `https://downloads.claude.ai/claude-code-releases/${version}/${platformKey}/claude`
    : `https://github.com/openai/codex/releases/download/rust-v${version}/${codexLinuxAsset(arch)}`;
  if (entry?.url !== expectedUrl || !sha256) {
    throw new Error(`${kind} ${version} pin lacks a trusted ${platformKey} asset`);
  }
  const size = typeof entry.size === 'number' && entry.size > 0 ? entry.size : undefined;
  return {
    url: expectedUrl,
    sha256,
    ...(size ? { size } : {}),
  };
}

function parseTarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const sliceEnd = end >= start && end < start + length ? end : start + length;
  return buffer.subarray(start, sliceEnd).toString('utf8').trim();
}

/** Extract the single Codex binary from an already SHA-verified tar.gz. */
export async function extractCodexBinaryFromTarGz(
  archivePath: string,
  destinationPath: string,
  arch: string = process.arch,
): Promise<void> {
  const tarPath = `${archivePath}.tar-${process.pid}`;
  const tempDestination = `${destinationPath}.extract-${process.pid}`;
  // 归档内的二进制与资产同名(去掉 .tar.gz),故同样按 arch 派生。精确匹配是
  // 安全属性:只认这一个名字,tar 里夹带的其它条目一概不落盘。
  const expectedBinaryName = codexLinuxAsset(arch).replace(/\.tar\.gz$/, '');
  try {
    await pipeline(
      fs.createReadStream(archivePath),
      createGunzip(),
      fs.createWriteStream(tarPath, { mode: 0o600 }),
    );
    const tarSize = fs.statSync(tarPath).size;
    const fd = fs.openSync(tarPath, 'r');
    try {
      let offset = 0;
      while (offset + 512 <= tarSize) {
        const header = Buffer.alloc(512);
        if (fs.readSync(fd, header, 0, header.length, offset) !== header.length) break;
        if (header.every((byte) => byte === 0)) break;
        const name = parseTarString(header, 0, 100);
        const prefix = parseTarString(header, 345, 155);
        const fullName = prefix ? `${prefix}/${name}` : name;
        const sizeText = parseTarString(header, 124, 12).replace(/\0/g, '').trim();
        const entrySize = Number.parseInt(sizeText || '0', 8);
        if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
          throw new Error(`invalid tar entry size for ${fullName}`);
        }
        const dataOffset = offset + 512;
        const nextOffset = dataOffset + Math.ceil(entrySize / 512) * 512;
        if (nextOffset > tarSize) throw new Error(`truncated tar entry: ${fullName}`);
        const typeFlag = header[156];
        const isRegularFile = typeFlag === 0 || typeFlag === 48;
        if (isRegularFile && path.basename(fullName) === expectedBinaryName && entrySize > 0) {
          fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
          await pipeline(
            fs.createReadStream(tarPath, { start: dataOffset, end: dataOffset + entrySize - 1 }),
            fs.createWriteStream(tempDestination, { mode: 0o755 }),
          );
          fs.chmodSync(tempDestination, 0o755);
          fs.renameSync(tempDestination, destinationPath);
          return;
        }
        offset = nextOffset;
      }
    } finally {
      fs.closeSync(fd);
    }
    throw new Error(`Codex binary not found in ${archivePath}`);
  } finally {
    try { fs.rmSync(tarPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tempDestination, { force: true }); } catch { /* ignore */ }
  }
}

async function installClaudeFromOfficialAsset(
  signal?: AbortSignal,
  onProgress?: (event: ProgressEvent) => void,
): Promise<string> {
  const version = CONFIG['claude-code'].version;
  const descriptor = pinnedOfficialAssetDescriptor('claude-code', version, claudeLatest);
  const binaryPath = privateBinaryPath(app.getPath('userData'), 'claude-code');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  await download({
    url: descriptor.url,
    targetPath: binaryPath,
    sha256: descriptor.sha256,
    expectedSize: descriptor.size,
    signal,
    onProgress,
  });
  fs.chmodSync(binaryPath, 0o755);
  const versionOutput = await readExecutableVersion(binaryPath, signal);
  if (!versionOutput || !runtimeVersionMatchesPin('claude-code', versionOutput)) {
    throw new Error(`Claude Code ${version} downloaded but failed version verification`);
  }
  writeRuntimeVersionMarker(app.getPath('userData'), 'claude-code');
  return binaryPath;
}

async function installCodexFromOfficialAsset(
  signal?: AbortSignal,
  onProgress?: (event: ProgressEvent) => void,
): Promise<string> {
  const version = CONFIG.codex.version;
  const descriptor = pinnedOfficialAssetDescriptor('codex', version, codexLatest);
  const root = runtimeInstallRoot(app.getPath('userData'), 'codex');
  const archivePath = path.join(root, `${codexLinuxAsset()}.${version}`);
  const binaryPath = privateBinaryPath(app.getPath('userData'), 'codex');
  fs.mkdirSync(root, { recursive: true });
  try {
    await download({
      url: descriptor.url,
      targetPath: archivePath,
      sha256: descriptor.sha256,
      expectedSize: descriptor.size,
      signal,
      onProgress,
    });
    await extractCodexBinaryFromTarGz(archivePath, binaryPath);
  } finally {
    try { fs.rmSync(archivePath, { force: true }); } catch { /* ignore */ }
  }
  const versionOutput = await readExecutableVersion(binaryPath, signal);
  if (!versionOutput || !runtimeVersionMatchesPin('codex', versionOutput)) {
    throw new Error(`Codex ${version} downloaded but failed version verification`);
  }
  writeRuntimeVersionMarker(app.getPath('userData'), 'codex');
  return binaryPath;
}

export async function prepareLinuxRuntimeFallback(
  kind: LinuxRuntimeFallbackKind,
  options: { signal?: AbortSignal; onProgress?: (event: ProgressEvent) => void } = {},
): Promise<{
  ready: boolean;
  binaryPath: string;
  installed: boolean;
  source: 'private' | 'legacy' | 'system' | 'installed';
  error?: string;
}> {
  if (!app.isPackaged || process.platform !== 'linux') {
    return { ready: false, binaryPath: '', installed: false, source: 'system', error: 'not_linux_packaged' };
  }

  const timeoutSignal = AbortSignal.timeout(STARTUP_INSTALL_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const privatePath = await findPrivateBinaryAsync(kind, signal);
  if (privatePath) return { ready: true, binaryPath: privatePath, installed: false, source: 'private' };

  const legacyPath = await migrateLegacyManagedBinary(kind, signal);
  if (legacyPath) return { ready: true, binaryPath: legacyPath, installed: false, source: 'legacy' };

  const systemPath = await findSystemBinaryAsync(kind, signal);
  if (systemPath) return { ready: true, binaryPath: systemPath, installed: false, source: 'system' };

  if (signal.aborted) throw new Error(`${kind} install cancelled`);
  const binaryPath = kind === 'codex'
    ? await installCodexFromOfficialAsset(signal, options.onProgress)
    : await installClaudeFromOfficialAsset(signal, options.onProgress);
  return { ready: true, binaryPath, installed: true, source: 'installed' };
}
