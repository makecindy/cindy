/**
 * Grok Build binary + ACP probe.
 *
 * PATH walk only — never reads ~/.grok/auth.json. Auth is inferred from ACP
 * `initialize.authMethods` (empty = logged in) or from `XAI_API_KEY` in env.
 *
 * `buildGrokBuildAgent` must stay PATH-only so a missing/slow grok cannot delay
 * Cindy startup. ACP initialize lives in AuthAdapter.getState.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

import type { Logger } from '../../interfaces/logger.js';
import { ACP_PROTOCOL_VERSION } from './types.js';
import { AcpClient, AcpRequestTimeoutError } from './acp-client.js';
import { createGrokStdioTransport, type GrokSpawnFn } from './stdio-transport.js';

export type GrokBuildDetectStatus =
  | 'uninstalled'
  | 'logged-out'
  | 'unsupported-version'
  | 'acp-fail'
  | 'ready';

export interface GrokBuildProbeResult {
  status: GrokBuildDetectStatus;
  binaryPath: string | null;
  identity?: string;
  agentVersion?: string;
  errorReason?: string;
}

export interface ResolveGrokBinaryOptions {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  existsSyncImpl?: (candidate: string) => boolean;
  pathSep?: string;
}

export function resolveGrokBinaryFromPath(options: ResolveGrokBinaryOptions = {}): string | null {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const platform = options.platform ?? process.platform;
  const exists = options.existsSyncImpl ?? existsSync;
  // 分隔符与拼接必须同属一个 platform:注入 platform 做跨平台用例时,若这里还用宿主的
  // path.join,在 Windows 上跑 posix 用例会拼出 `\opt\xai\bin\grok`,反之亦然。
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delim = options.pathSep ?? pathApi.delimiter;
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delim)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = pathApi.join(dir, `grok${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

export interface ProbeGrokBuildOptions {
  binaryPath: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: GrokSpawnFn;
  logger?: Logger;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export async function probeGrokBuildAcp(options: ProbeGrokBuildOptions): Promise<GrokBuildProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const logger = options.logger;
  let transport: ReturnType<typeof createGrokStdioTransport> | undefined;
  let client: AcpClient | undefined;
  try {
    transport = createGrokStdioTransport({
      binaryPath: options.binaryPath,
      args: ['agent', 'stdio'],
      env: options.env,
      spawnImpl: options.spawnImpl,
    });
    client = new AcpClient({
      transport,
      logger,
      defaultTimeoutMs: timeoutMs,
    });
    client.start();
    const init = await client.initialize({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: 'cindy', version: '0.0.0' },
    }, timeoutMs);
    if (typeof init.protocolVersion === 'number' && init.protocolVersion > ACP_PROTOCOL_VERSION) {
      return {
        status: 'unsupported-version',
        binaryPath: options.binaryPath,
        agentVersion: init.agentInfo?.version,
        errorReason: `unsupported ACP protocolVersion ${init.protocolVersion}`,
      };
    }
    const methods = init.authMethods ?? [];
    if (methods.length > 0) {
      return {
        status: 'logged-out',
        binaryPath: options.binaryPath,
        agentVersion: init.agentInfo?.version,
        errorReason: 'logged-out',
      };
    }
    return {
      status: 'ready',
      binaryPath: options.binaryPath,
      identity: init.agentInfo?.name ?? 'grok',
      agentVersion: init.agentInfo?.version,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: GrokBuildDetectStatus =
      err instanceof AcpRequestTimeoutError ? 'acp-fail' : 'acp-fail';
    logger?.warn('grok-build ACP probe failed', { message });
    return {
      status,
      binaryPath: options.binaryPath,
      errorReason: message,
    };
  } finally {
    await client?.close('probe complete').catch(() => undefined);
  }
}

export function detectGrokBuildOnPath(options: ResolveGrokBinaryOptions = {}): GrokBuildProbeResult {
  const binaryPath = resolveGrokBinaryFromPath(options);
  if (!binaryPath) {
    return { status: 'uninstalled', binaryPath: null, errorReason: 'uninstalled' };
  }
  return { status: 'ready', binaryPath };
}
