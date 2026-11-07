/**
 * custom/runtime.ts — 自定义渠道的宿主装配。
 *
 * 一个回环端点服务所有自定义连接; 每条连接注册自己的入站目标, token 存在安全存储里。
 * 端点随 IM 连接启动/停止(与其它渠道同一生命周期)。
 */

import { randomBytes } from 'node:crypto';

import type { CustomIM } from '@cindy/im';

import { createLogger } from '../../logger';
import { ownerScopedImUserDataPath, ownerScopedImSecrets } from '../ownerScopedStorage';
import {
  startCustomEndpoint,
  type CustomEndpointHandle,
} from './endpoint';
import { customAttachmentMeta } from './adapter';

const log = createLogger('im:custom');

let endpoint: CustomEndpointHandle | null = null;
let starting: Promise<CustomEndpointHandle> | null = null;
const registered = new Map<string, CustomIM>();

/** 连接 id → token 的存储键(与 botImConnectionRuntime 的 SECRET_KEYS_BY_CHANNEL 对齐)。 */
export function customTokenSecretKey(connectionId: string): string {
  return `bot-im-${connectionId}-custom-channel-token`;
}

export function generateCustomToken(): string {
  return randomBytes(32).toString('hex');
}

export function readCustomToken(connectionId: string): string | null {
  return ownerScopedImSecrets.read(customTokenSecretKey(connectionId))?.trim() || null;
}

export function writeCustomToken(connectionId: string, token: string): void {
  if (!ownerScopedImSecrets.isAvailable()) {
    throw new Error('SECURE_STORAGE_UNAVAILABLE: cannot persist custom channel token');
  }
  if (!ownerScopedImSecrets.write(customTokenSecretKey(connectionId), token)) {
    throw new Error('SECURE_STORAGE_WRITE_FAILED: cannot persist custom channel token');
  }
}

export function removeCustomToken(connectionId: string): void {
  ownerScopedImSecrets.remove(customTokenSecretKey(connectionId));
}

/** 启动回环端点(幂等)。 */
export async function ensureCustomEndpoint(): Promise<CustomEndpointHandle> {
  if (endpoint) return endpoint;
  // 多条连接同时恢复会并发调用; 共用同一次启动, 避免第二次 listen 抢同一个路径。
  if (!starting) {
    // socket 路径固定(Unix domain socket / Windows named pipe), 不占端口;
    // 外部系统的接入地址重启后不变。
    starting = startCustomEndpoint({
      discoveryDir: ownerScopedImUserDataPath('im-custom'),
      log,
    }).then(
      (handle) => {
        endpoint = handle;
        starting = null;
        return handle;
      },
      (err: unknown) => {
        starting = null;
        throw err;
      },
    );
  }
  return starting;
}

export async function stopCustomEndpoint(): Promise<void> {
  const current = endpoint;
  endpoint = null;
  starting = null;
  registered.clear();
  if (current) await current.shutdown();
}

/** 把一条连接的传输层注册到端点, 返回它的入站 URL。 */
export async function registerCustomConnection(
  connectionId: string,
  im: CustomIM,
): Promise<string> {
  const handle = await ensureCustomEndpoint();
  registered.set(connectionId, im);
  return handle.register(connectionId, {
    token: im.getToken(),
    handle: (payload) => im.handleInbound(im.getToken(), payload),
  });
}

export function unregisterCustomConnection(connectionId: string): void {
  registered.delete(connectionId);
  endpoint?.unregister(connectionId);
}

/** 当前端点的 socket 路径(给 UI 展示); 端点没起时 null。 */
export function customEndpointSocketPath(): string | null {
  return endpoint?.socketPath ?? null;
}

export { customAttachmentMeta };
