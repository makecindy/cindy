import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import type { ModelAccessCredentialSource } from '../../shared/modelAccess.js';

const log = createLogger('modelAccessStore');

/**
 * credentialsStore.ts — XD 网关凭据的「endpoint + 来源标记」持久化(main only)。
 * ---------------------------------------------------------------------------
 * key 本身仍存 safeStorage(providerSecretStore 'xd',与手填链路同一份 .enc);
 * 本 store 只管两个非敏感元数据,落 userData JSON:
 *  - source:'server'(登录自动下发)| 'manual'(用户手填);
 *  - endpoint:source='server' 时服务端下发的推理入口。
 *
 * 核心不变量:**endpoint 与 key 同源**——server 下发的 key 配 server 下发的
 * endpoint;无 server 标记(存量手填 key / 从未同步)时 effectiveEndpoint 返回
 * 空串 = 网关不可用(2026-07-17 定案,端点清单的 xdGatewayBaseUrl 已退役)。
 * 杜绝「手填旧 key + 新 endpoint」的撕裂组合。
 *
 * 账号切换:key 由 providerSecretStore.reconcileOwner 负责清理;本 store 的
 * endpoint 残留在无 key 时是惰性数据(所有消费都要求 key 存在),新账号登录后
 * 首次同步成功即覆盖,无需参与账号清理链。
 */

interface PersistedState {
  source: ModelAccessCredentialSource;
  /** 仅 source='server' 时有值。 */
  endpoint?: string;
}

export type { ModelAccessCredentialsStore } from '@cindy/model-providers/model-access/credentialsStore';
import type { ModelAccessCredentialsStore } from '@cindy/model-providers/model-access/credentialsStore';

/** 低层文件 IO,抽出以便注入测试(规则 14)。 */
export interface CredentialsStoreIo {
  read(): string | null;
  write(text: string): void;
  remove(): void;
}

function defaultIo(): CredentialsStoreIo {
  const file = () => ownerScopedUserDataPath('model-access-credentials.json');
  return {
    read() {
      try {
        return fs.readFileSync(file(), 'utf-8');
      } catch {
        return null;
      }
    },
    write(text) {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), text, 'utf-8');
    },
    remove() {
      try {
        fs.unlinkSync(file());
      } catch {
        /* 不存在即幂等 */
      }
    },
  };
}

export function createModelAccessCredentialsStore(
  io?: CredentialsStoreIo,
  ownerIdProvider?: () => string | null,
): ModelAccessCredentialsStore {
  const resolvedIo = io ?? defaultIo();
  const resolveOwnerId =
    ownerIdProvider ?? (io ? () => null : () => getActiveAppSession().dataOwnerId);
  // 内存缓存:读路径(每次会话 spawn / 路由决策都会读 endpoint)零磁盘 IO(规则 10)。
  let cached: PersistedState | null | undefined; // undefined = 尚未加载

  let cachedOwnerId: string | null | undefined;

  const load = (): PersistedState | null => {
    const ownerId = resolveOwnerId();
    if (cachedOwnerId !== ownerId) {
      cached = undefined;
      cachedOwnerId = ownerId;
    }
    if (cached !== undefined) return cached;
    const raw = resolvedIo.read();
    if (!raw) {
      cached = null;
      return cached;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.source === 'server' && typeof parsed.endpoint === 'string' && parsed.endpoint) {
        cached = {
          source: 'server',
          endpoint: parsed.endpoint.replace(/\/+$/, ''),
        };
      } else if (parsed.source === 'manual') {
        cached = { source: 'manual' };
      } else {
        cached = null;
      }
    } catch {
      log.warn('model-access credentials meta file corrupted, ignoring');
      cached = null;
    }
    return cached;
  };

  const persist = (state: PersistedState | null): void => {
    cachedOwnerId = resolveOwnerId();
    cached = state;
    try {
      if (state === null) resolvedIo.remove();
      else resolvedIo.write(JSON.stringify(state));
    } catch (err) {
      // 落盘失败只影响下次冷启动的 endpoint 记忆(冷启动首轮同步前网关暂不可用),不阻断主流程。
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'persist model-access credentials meta failed',
      );
    }
  };

  return {
    getSource() {
      return load()?.source ?? null;
    },
    getServerEndpoint() {
      const state = load();
      return state?.source === 'server' ? (state.endpoint ?? null) : null;
    },
    setServerCredentials(endpoint) {
      persist({
        source: 'server',
        endpoint: endpoint.replace(/\/+$/, ''),
      });
    },
    setManualSource() {
      persist({ source: 'manual' });
    },
    clear() {
      persist(null);
    },
  };
}

let singleton: ModelAccessCredentialsStore | null = null;

/** 进程内单例(默认 userData 文件 IO)。 */
export function getModelAccessCredentialsStore(): ModelAccessCredentialsStore {
  if (!singleton) singleton = createModelAccessCredentialsStore();
  return singleton;
}
