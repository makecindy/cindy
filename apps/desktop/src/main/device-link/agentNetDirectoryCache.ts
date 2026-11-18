/**
 * 本账号 Agent-Net 名册的本地缓存（Desktop 与 Node Host 共用，不依赖 Electron）。内容是名册里各设备的公开证书与在线状态，
 * 节点用之前按根公钥重新校验签名；官方 Agent-Net 服务出故障、刚启动连不上中转时，节点照样能起来，直连的设备照常可用，
 * 中转恢复后换成新名册。2026-11-17：原来只有 Desktop 有这份缓存，Node Host 在服务出故障时重启就一直连不上 Agent-Net。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CERT_LIFETIME_MS, type DeviceView } from '@cindy/agent-net-protocol';

/** 缓存文件最大这么大，再大按坏文件处理（名册最多 256 台）。 */
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_DEVICES = 256;

export interface AgentNetDirectoryCache {
  devices: DeviceView[];
  /** 这份缓存到什么时候还能用（收到时刻加证书有效期）；没有缓存为 0。 */
  expiresAt: number;
}

/**
 * 读缓存。没有、坏了、时间不对都当作没有；读的过程中账号换了由 `assertCurrent` 抛出。旧版缓存（整个文件是数组）按文件修改时间
 * 认一次，不延长它原来的收到时刻。
 */
export async function readAgentNetDirectoryCache(file: string, assertCurrent: () => void = () => undefined): Promise<AgentNetDirectoryCache> {
  try {
    const stat = await fs.promises.stat(file); assertCurrent();
    if (stat.size > MAX_CACHE_BYTES) return { devices: [], expiresAt: 0 };
    const value: unknown = JSON.parse(await fs.promises.readFile(file, 'utf8')); assertCurrent();
    const cached = value as { version?: unknown; receivedAt?: unknown; devices?: unknown };
    const receivedAt = Array.isArray(value) ? stat.mtimeMs : cached?.version === 1 ? cached.receivedAt : null;
    const devices = Array.isArray(value) ? value : cached?.devices;
    if (typeof receivedAt === 'number' && Number.isFinite(receivedAt) && receivedAt <= Date.now() + 30_000 && Array.isArray(devices)) {
      return { devices: devices.slice(0, MAX_CACHED_DEVICES) as DeviceView[], expiresAt: receivedAt + CERT_LIFETIME_MS };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { devices: [], expiresAt: 0 };
}

/**
 * 写缓存：先写临时文件再改名，只有这个用户能读。写不了（只读、满了）不影响已经连上的连接，临时文件尽量删掉
 * （里面只有公开证书）。
 */
export function writeAgentNetDirectoryCache(file: string, devices: readonly DeviceView[]): void {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, receivedAt: Date.now(), devices }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* A leftover contains public certificates only. */ }
  }
}
