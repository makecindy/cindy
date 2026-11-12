import type { ByokCache } from './byokCache.js';
import { isDeepStrictEqual } from 'node:util';
import {
  BYOK_CREDENTIALS_PATH,
  BYOK_PROVIDERS_PATH,
  parseByokCredentialsResponse,
  parseByokProvidersResponse,
  type ByokCredential,
  type ByokProvider,
  type ByokProvidersResponse,
} from '@cindy/model-providers';

export interface ByokOwner {
  /** Include the auth generation and region, not just a membership ID. */
  scope: string;
  /** Stable identity + region for encrypted restart snapshots, excluding the process generation. */
  cacheScope?: string;
  organizationId: string;
}
type ReadyCredential = Extract<ByokCredential, { status: 'ready' }>;
export interface ByokConnection {
  provider: ByokProvider;
  credential: ReadyCredential;
}
export interface ByokSyncDependencies {
  cache?: ByokCache;
  fetch(path: string, options: { method: 'GET'; cache: 'no-store' }): Promise<unknown>;
  /** Synchronous, Main-only transaction: stage secrets, then publish matching routes.
   * On failure leave no partially updated route/secret pair; never forward this payload to IPC.
   */
  replace(
    owner: ByokOwner | null,
    connections: readonly ByokConnection[],
    directory?: readonly ByokProvider[],
  ): void;
}
import type { ByokStatus as ByokSyncStatus } from '../../shared/modelAccess.js';

const TIMEOUT_MS = 20_000;
/**
 * `pending` 是服务端明确表示的中间态(旧 Key 已撤销、新 Key 尚未签发,见
 * MAS byok/credentials.ts 的 revoke / recover 分支),不是失败。这一轮不会安装路由,
 * 所以需要一个有界的自愈重试把连接补回来。
 *
 * 间隔取 30 秒:大于服务端签发宽限期 `ISSUE_RECOVERY_GRACE_MS`(默认
 * `MODEL_GATEWAY_TIMEOUT_MS × 2` = 20 秒),所以每次重试都已越过宽限期,不会被
 * 宽限期空转掉。recover 分支需要「先撤销再签发」两次请求才能收敛,3 次预算足够。
 * 重试有上限,不构成常驻轮询;定时器 unref,不阻止进程退出。
 *
 * 重试只重读凭据端点:目录此时已发布且未变,重拉目录只会多占一次
 * `byok-member-access` 限流额度(默认 60 秒 10 次,含用户手动刷新)。
 */
export const PENDING_RETRY_DELAY_MS = 30_000;
export const PENDING_RETRY_LIMIT = 3;
function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('BYOK_SYNC_TIMEOUT')), TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Identity-scoped synchronization. The caller owns persistence and active-catalog publication. */
export function createByokSync(deps: ByokSyncDependencies) {
  let owner: ByokOwner | null = null;
  let epoch = 0;
  let catalog: ByokProvidersResponse | null = null;
  let connections: ByokConnection[] = [];
  let status: ByokSyncStatus = { state: 'idle', providers: [] };
  let queue = Promise.resolve();
  let inflight: Promise<void> | null = null;
  let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRetryAttempts = 0;

  function current(generation: number) {
    return generation === epoch && owner !== null;
  }
  function publish(next: ByokConnection[], directory = catalog?.providers ?? [], persist = true) {
    try {
      deps.replace(owner, next, directory);
    } catch (error) {
      connections = [];
      throw error;
    }
    connections = next;
    if (persist && owner && catalog)
      deps.cache?.save(owner, { ...catalog, providers: [...directory] }, next);
  }
  function updateStatus(state: ByokSyncStatus['state']) {
    status = {
      state,
      providers: (catalog?.providers ?? []).map((provider) => ({
        providerId: provider.id,
        state: connections.some((entry) => entry.provider.id === provider.id)
          ? 'ready'
          : 'unavailable',
      })),
    };
  }
  function enqueue(operation: () => Promise<void>) {
    const run = queue.then(operation);
    queue = run.catch(() => undefined);
    return run;
  }
  function clearPendingRetry() {
    if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
  }
  /** 只在服务端明确返回 pending 时排自愈重试;其他状态(含 failed)都不排。 */
  function hasPendingProvider(): boolean {
    return status.providers.some((item) => item.state === 'pending');
  }
  /**
   * 重试只重读凭据端点:目录已发布且未变,重拉目录既无意义也会多占限流额度。
   * 预算由最近一次 sync 重置,重试自身递增,所以每轮最多补 3 次,
   * 既不会累积成无限轮询,也不会把不同一轮的 pending 累加成一个上限。
   */
  function schedulePendingRetry(generation: number) {
    clearPendingRetry();
    if (
      !current(generation) ||
      !hasPendingProvider() ||
      pendingRetryAttempts >= PENDING_RETRY_LIMIT
    )
      return;
    pendingRetryTimer = setTimeout(() => {
      pendingRetryTimer = null;
      if (!current(generation)) return;
      pendingRetryAttempts++;
      void enqueue(async () => {
        if (!current(generation) || !hasPendingProvider()) return;
        try {
          const raw = await deadline(
            deps.fetch(BYOK_CREDENTIALS_PATH, { method: 'GET', cache: 'no-store' }),
          );
          if (!current(generation)) return;
          applyCredentials(raw);
          // 仍然 pending 就继续用剩余预算补;已收敛则不再排。
          if (hasPendingProvider()) schedulePendingRetry(generation);
        } catch {
          // 瞬时失败不能走 updateStatus('failed'):它只重建 ready|unavailable,
          // 会把 pending 叠层抹掉,hasPendingProvider() 变 false,剩余预算作废。
          // 已有可用连接这条路径本来就不会被 publish 掉。
          if (current(generation) && hasPendingProvider()) schedulePendingRetry(generation);
        }
      }).catch(() => undefined);
    }, PENDING_RETRY_DELAY_MS);
    pendingRetryTimer.unref?.();
  }
  async function refresh(generation: number) {
    if (!current(generation)) return;
    status = { ...status, state: 'syncing' };
    try {
      const raw = await deadline(
        deps.fetch(BYOK_PROVIDERS_PATH, { method: 'GET', cache: 'no-store' }),
      );
      if (!current(generation)) return;
      const parsed = parseByokProvidersResponse(raw);
      if (!parsed.ok || parsed.value.organizationId !== owner!.organizationId)
        throw new Error('BYOK_INVALID_DIRECTORY');
      if (
        catalog?.revision === parsed.value.revision &&
        !isDeepStrictEqual(catalog, parsed.value)
      ) {
        throw new Error('BYOK_DIRECTORY_REVISION_CONFLICT');
      }
      const nextCatalog = parsed.value;
      // Revoke removed routes and invalidate changed connections before fetching any new key.
      const retained = nextCatalog.providers.flatMap((provider) => {
        const existing = connections.find(
          (entry) =>
            entry.provider.id === provider.id &&
            entry.provider.connectionRevision === provider.connectionRevision,
        );
        return existing ? [{ provider, credential: existing.credential }] : [];
      });
      // Publish the new directory atomically, then persist it after `catalog` points at the same
      // snapshot. Otherwise `publish` briefly writes the old revision with the new provider list.
      publish(retained, nextCatalog.providers, false);
      catalog = nextCatalog;
      if (owner) deps.cache?.save(owner, catalog, connections);
      if (catalog.providers.length === 0) {
        updateStatus('ready');
        return;
      }
      const rawCredentials = await deadline(
        deps.fetch(BYOK_CREDENTIALS_PATH, { method: 'GET', cache: 'no-store' }),
      );
      if (!current(generation)) return;
      applyCredentials(rawCredentials);
      schedulePendingRetry(generation);
    } catch {
      if (current(generation)) updateStatus('failed');
    }
  }
  function applyCredentials(raw: unknown) {
    const parsed = parseByokCredentialsResponse(raw);
    if (!parsed.ok || parsed.value.organizationId !== owner!.organizationId)
      throw new Error('BYOK_INVALID_CREDENTIALS');
    const next: ByokConnection[] = [];
    for (const provider of catalog!.providers) {
      const credential = parsed.value.credentials.find((entry) => entry.providerId === provider.id);
      if (credential?.connectionRevision !== provider.connectionRevision) continue;
      if (credential.status === 'ready') next.push({ provider, credential });
      // A declared failure or missing item is not permission to keep using an old key.
    }
    publish(next);
    updateStatus('ready');
    status.providers = status.providers.map((item) => {
      const credential = parsed.value.credentials.find(
        (entry) => entry.providerId === item.providerId,
      );
      return item.state !== 'ready' && credential?.status === 'pending'
        ? { ...item, state: 'pending' }
        : item;
    });
  }

  return {
    /** Call on logout/account/region generation changes before any new network request. */
    setOwner(next: ByokOwner | null) {
      if (owner?.scope === next?.scope && owner?.organizationId === next?.organizationId) return;
      epoch++;
      // Clear the old routes while the old owner is still installed.
      deps.replace(owner, []);
      owner = next;
      catalog = null;
      connections = [];
      status = { state: 'idle', providers: [] };
      queue = Promise.resolve();
      inflight = null;
      // 旧身份的 pending 重试预算不能带到新身份;定时器也必须停掉。
      clearPendingRetry();
      pendingRetryAttempts = 0;
      if (next) {
        const cached = deps.cache?.load(next);
        if (cached) {
          catalog = cached.catalog;
          try {
            publish(cached.connections, cached.catalog.providers, false);
            updateStatus('idle');
          } catch {
            catalog = null;
            connections = [];
            updateStatus('failed');
          }
        }
      }
    },
    sync(): Promise<void> {
      if (!owner) return Promise.resolve();
      if (inflight) return inflight;
      const generation = epoch;
      // 每次显式同步重置 pending 重试预算,并作废上一轮尚未触发的重试。
      clearPendingRetry();
      pendingRetryAttempts = 0;
      const run = enqueue(() => refresh(generation));
      inflight = run;
      void run
        .finally(() => {
          if (inflight === run) inflight = null;
        })
        .catch(() => undefined);
      return run;
    },
    getStatus(): ByokSyncStatus {
      return structuredClone(status);
    },
  };
}
