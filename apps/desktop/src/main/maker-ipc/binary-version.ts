/**
 * apps/desktop/src/main/maker-ipc/binary-version.ts
 *
 * maker:agent:binary-version IPC handler —— spawn 当前应用使用的 agent 二进制 `--version`,
 * 把首行输出回给 renderer 的 About 面板。
 *
 * 设计:
 *   - Claude/Codex 在 prepare 成功后优先读 getReadyBinaryPath(),必要时可读受管缓存；
 *     Pi 是可选资产，只允许使用本次 prepare 成功的路径，失败时不能复用旧缓存。
 *   - Claude/Codex 按 binaryPath 缓存结果；Pi 现读，以反映受管／原生更新。
 *   - 5s 超时, 失败时返回 { error }。
 *   - checkLatest 时再比较当前通道 manifest；普通调用不等网络。
 */

import { registerPiKernelIpc } from './pi-kernel.js';
import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';

import { createLogger } from '../logger.js';
import {
  getReadyBinaryPath,
  getCachedBinaryStatus,
  isVettedAgentBinaryPath,
  type AgentBinaryKind,
} from '../agent-binaries/index.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import {
  isBinaryVersionNotOlder,
  normalizeBinaryVersion,
  parseBinaryVersionOutput,
} from '../agent-binaries/binary-version-probe.js';
import { getVendorAsset, vendorAssetMatchesPlatform } from '../agent-binaries/manifest.js';
import { fetchManifest, getPlatformKey, type Manifest } from '../manifestService.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc:binary-version');

export interface AgentBinaryVersionResult {
  kind: AgentBinaryKind;
  binaryPath: string | null;
  version: string | null;
  /** Latest version on the active update channel; only filled for `checkLatest`. */
  latestVersion: string | null;
  /** The channel version is strictly newer than the local one (Claude/Codex only). */
  updateAvailable: boolean;
  error?: string;
}

interface AgentBinaryVersionOptions {
  checkLatest?: boolean;
}

const versionCache = new Map<string, string>();

// About renders one request per managed agent. Share only the in-flight manifest
// lookup so opening the page does not issue identical requests, while a later
// About visit (or a channel switch) always gets a fresh online comparison.
let latestManifestPromise: Promise<Manifest | null> | null = null;

function getLatestManifest(): Promise<Manifest | null> {
  if (latestManifestPromise) return latestManifestPromise;
  const request = fetchManifest(8_000).catch(() => null);
  latestManifestPromise = request;
  void request.then(
    () => {
      if (latestManifestPromise === request) latestManifestPromise = null;
    },
    () => {
      if (latestManifestPromise === request) latestManifestPromise = null;
    },
  );
  return latestManifestPromise;
}

// Same fields as agent-binaries CONFIG. Only an asset the installer can
// actually consume (complete metadata, this platform) may advertise an update.
const MANIFEST_FIELD: Record<AgentBinaryKind, string> = {
  'claude-code': 'claudeCode',
  codex: 'codexPackage',
  pi: 'pi',
};

// downloader/index.ts rejects anything that is not exactly 64 hex chars.
const DOWNLOAD_SHA256 = /^[0-9a-fA-F]{64}$/;

function latestVersionFor(kind: AgentBinaryKind, manifest: Manifest | null): string | null {
  if (!manifest) return null;
  const asset = getVendorAsset(manifest, MANIFEST_FIELD[kind]);
  if (!asset || !vendorAssetMatchesPlatform(asset, getPlatformKey())) return null;
  if (!DOWNLOAD_SHA256.test(asset.sha256)) return null;
  return asset.version;
}

// Same ordering the startup installer uses to keep a local runtime that is not
// older than the manifest, so the About action never offers a no-op relaunch.
function isUpdateAvailable(kind: AgentBinaryKind, version: string | null, latestVersion: string | null): boolean {
  if (kind === 'pi' || !version || !latestVersion) return false;
  const current = parseBinaryVersionOutput(version, '');
  const latest = normalizeBinaryVersion(latestVersion);
  return !!current && !!latest && !isBinaryVersionNotOlder(current, latest);
}

function parseOptions(value: unknown): AgentBinaryVersionOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object') {
    throwIpcError('INVALID_PARAMS', 'options must be an object');
  }
  const { checkLatest } = value as { checkLatest?: unknown };
  if (checkLatest !== undefined && typeof checkLatest !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'checkLatest must be a boolean');
  }
  return { checkLatest };
}

async function probeLocalVersion(
  agentKind: AgentBinaryKind,
  options?: { bypassCache?: boolean },
): Promise<Omit<AgentBinaryVersionResult, 'latestVersion' | 'updateAvailable'>> {
  const binaryPath = resolveBinaryPath(agentKind);
  // 执行前复核路径确为受管二进制(CodeQL js/command-line-injection 防御纵深)
  if (!binaryPath || !isVettedAgentBinaryPath(agentKind, binaryPath)) {
    return { kind: agentKind, binaryPath: null, version: null, error: 'binary_not_ready' };
  }

  // Pi is always live. checkLatest also skips the process cache so an in-place
  // self-update is compared against the manifest instead of a stale --version.
  const cached = agentKind === 'pi' || options?.bypassCache ? undefined : versionCache.get(binaryPath);
  if (cached) {
    return { kind: agentKind, binaryPath, version: cached };
  }

  try {
    const version = await spawnVersion(binaryPath);
    if (agentKind !== 'pi') versionCache.set(binaryPath, version);
    return { kind: agentKind, binaryPath, version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${agentKind} --version failed: ${message}`);
    return { kind: agentKind, binaryPath, version: null, error: message };
  }
}

function isAgentBinaryKind(value: unknown): value is AgentBinaryKind {
  return value === 'claude-code' || value === 'codex' || value === 'pi';
}

function resolveBinaryPath(kind: AgentBinaryKind): string | null {
  const ready = getReadyBinaryPath(kind);
  if (ready) return ready;
  if (kind === 'pi') return null;
  const cached = getCachedBinaryStatus(kind);
  return cached.binaryReady && cached.binaryPath ? cached.binaryPath : null;
}

function spawnVersion(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ['--version'],
      { timeout: 5000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        const out = (stdout || stderr || '').toString().trim();
        const firstLine = out.split(/\r?\n/)[0]?.trim() ?? '';
        if (!firstLine) {
          reject(new Error('empty --version output'));
          return;
        }
        resolve(firstLine);
      },
    );
  });
}

export function registerMakerBinaryVersionIpc(): void {
  registerPiKernelIpc();
  log.info('registering maker:agent:binary-version IPC handler');

  ipcMain.handle(
    MAKER_INVOKE.AGENT_BINARY_VERSION,
    async (event, agentKind: unknown, rawOptions: unknown): Promise<AgentBinaryVersionResult> => {
      // Auxiliary preload windows must not spawn managed binaries or hit the
      // update CDN. Device-link reuses this handler with a synthetic event after
      // its own allowlist, so that path keeps the remote version read.
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      if (!isAgentBinaryKind(agentKind)) {
        throwIpcError('INVALID_PARAMS', 'agentKind required (claude-code | codex | pi)');
      }
      const { checkLatest } = parseOptions(rawOptions);

      // The plain call never waits on the network, so About shows the local
      // version immediately even offline; the online comparison is a second call.
      if (!checkLatest) {
        return { ...(await probeLocalVersion(agentKind)), latestVersion: null, updateAvailable: false };
      }
      // Start before probing so concurrent About rows join one in-flight lookup.
      const onlineManifest = getLatestManifest();
      const local = await probeLocalVersion(agentKind, { bypassCache: true });
      const latestVersion = latestVersionFor(agentKind, await onlineManifest);
      return { ...local, latestVersion, updateAvailable: isUpdateAvailable(agentKind, local.version, latestVersion) };
    },
  );

  log.info('maker:agent:binary-version registered');
}
