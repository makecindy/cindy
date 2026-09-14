/**
 * Custom-provider runtime headers are credential-bearing by design. Keep every
 * value in owner-scoped Electron safeStorage and persist only the remaining
 * provider configuration in SQLite. Encrypting the complete map avoids a
 * brittle allow/deny list for vendor-specific auth header names.
 */

import type { AgentKind, CustomProviderConfig } from '@cindy/model-providers';

import {
  readCustomProviderHeadersForMutation,
  removeCustomProviderHeaders,
  storeCustomProviderHeaders,
  UNRECOVERABLE_PROVIDER_CREDENTIAL,
} from '../secrets/providerSecretStore.js';
import {
  listCustomProviders,
  updateCustomProvider,
} from './custom-provider-store.js';
import { getCurrentDbClientUserId } from '../localDb/client/current.js';

export const CUSTOM_PROVIDER_RUNTIME_AGENTS: readonly AgentKind[] = [
  'claude-code',
  'codex',
  'pi',
];

export type CustomProviderHeaderSecrets = Partial<
  Record<AgentKind, Record<string, string>>
>;

/** Return a clone safe to persist plus the header values that must be encrypted. */
export function splitCustomProviderHeaders(config: CustomProviderConfig): {
  config: CustomProviderConfig;
  headers: CustomProviderHeaderSecrets;
} {
  const runtimes = { ...config.runtimes };
  const headers: CustomProviderHeaderSecrets = {};
  for (const agent of CUSTOM_PROVIDER_RUNTIME_AGENTS) {
    const runtime = runtimes[agent];
    if (!runtime) continue;
    const values = runtime.headers && Object.keys(runtime.headers).length > 0
      ? { ...runtime.headers }
      : undefined;
    if (values) headers[agent] = values;
    const { headers: _removed, ...persistedRuntime } = runtime;
    runtimes[agent] = persistedRuntime;
  }
  return { config: { ...config, runtimes }, headers };
}

/** Hydrate safeStorage-only runtime headers into a config used by routing/UI/Pi. */
export function hydrateCustomProviderHeaders(
  config: CustomProviderConfig,
): CustomProviderConfig {
  const runtimes = { ...config.runtimes };
  for (const agent of CUSTOM_PROVIDER_RUNTIME_AGENTS) {
    const runtime = runtimes[agent];
    if (!runtime) continue;
    try {
      const headers = readCustomProviderHeadersForMutation(config.id, agent);
      if (headers === UNRECOVERABLE_PROVIDER_CREDENTIAL) {
        // 密文头存在但解不开：与读失败同样标为 unknown，由用户重填后覆盖。
        runtimes[agent] = { ...runtime, headersState: 'unknown' };
      } else if (headers && Object.keys(headers).length > 0) {
        runtimes[agent] = { ...runtime, headers, headersState: 'configured' };
      }
    } catch {
      runtimes[agent] = { ...runtime, headersState: 'unknown' };
    }
  }
  return { ...config, runtimes };
}

type HeaderSnapshot = {
  agent: AgentKind;
  previous: Record<string, string> | null;
};

function restoreHeaderSnapshots(
  providerId: string,
  snapshots: readonly HeaderSnapshot[],
): boolean {
  let restored = true;
  for (const { agent, previous } of [...snapshots].reverse()) {
    if (previous) {
      if (!storeCustomProviderHeaders(providerId, agent, previous)) restored = false;
    } else if (!removeCustomProviderHeaders(providerId, agent).success) {
      restored = false;
    }
  }
  return restored;
}

/**
 * Load runtime-ready configs and lazily migrate legacy plaintext headers.
 * The encrypted write happens before the SQLite scrub; any scrub failure rolls
 * safeStorage back so the next load can retry without losing credentials.
 */
export async function listCustomProvidersWithSecureHeaders(): Promise<CustomProviderConfig[]> {
  // 把整段迁移(读 → 写密文头 → scrub 明文)绑定到发起时的数据 owner。configs 读自 owner A
  // 的库;若迁移期间用户切到账号 B,storeCustomProviderHeaders / updateCustomProvider 会按
  // **调用时**的当前 owner 解析,可能把 A 的 Authorization 头写进 B 的 safe-storage 命名空间、
  // 或改到 B 的库(codex review P1)。故任一写入前复核 owner 未变,变了即 abort 整个流程
  // (下次在稳定 owner 下重试;已在 A 下写入的密文头位于 A 命名空间、正确且幂等,无需——也
  // 不能——在 B 上回滚)。
  const ownerAtStart = getCurrentDbClientUserId();
  const ownerChanged = (): boolean => getCurrentDbClientUserId() !== ownerAtStart;
  const assertSameOwner = (stage: string): void => {
    if (ownerChanged()) {
      throw new Error(
        `custom provider header migration aborted: data owner changed during ${stage} ` +
          `(was ${ownerAtStart ?? 'none'}, now ${getCurrentDbClientUserId() ?? 'none'})`,
      );
    }
  };
  const configs = await listCustomProviders();
  assertSameOwner('provider load');
  const result: CustomProviderConfig[] = [];
  for (const original of configs) {
    const split = splitCustomProviderHeaders(original);
    const legacyAgents = CUSTOM_PROVIDER_RUNTIME_AGENTS.filter(
      (agent) => split.headers[agent] && Object.keys(split.headers[agent]!).length > 0,
    );
    let persisted = split.config;
    if (legacyAgents.length > 0) {
      const snapshots: HeaderSnapshot[] = [];
      try {
        assertSameOwner('header encryption');
        for (const agent of legacyAgents) {
          const previous = readCustomProviderHeadersForMutation(original.id, agent);
          // 解不开的旧密文头没有可回滚的快照：保持此前抛错中止迁移的语义，不覆盖它。
          if (previous === UNRECOVERABLE_PROVIDER_CREDENTIAL) {
            throw new Error(`existing ${agent} custom provider headers are unreadable`);
          }
          snapshots.push({ agent, previous });
          if (!storeCustomProviderHeaders(original.id, agent, split.headers[agent]!)) {
            throw new Error(`failed to encrypt ${agent} custom provider headers`);
          }
        }
        assertSameOwner('config scrub');
        const updated = await updateCustomProvider(original.id, split.config);
        if (!updated) throw new Error(`custom provider '${original.id}' disappeared during migration`);
        persisted = updated;
      } catch (err) {
        // owner 已切换:不能在 B 上回滚(会污染 B 命名空间);A 下已写入的密文头正确且幂等,
        // 留待下次稳定 owner 重迁。仅在 owner 未变时才回滚部分写入。
        if (!ownerChanged() && !restoreHeaderSnapshots(original.id, snapshots)) {
          throw new Error(
            `custom provider '${original.id}' header migration failed and could not be rolled back`,
            { cause: err },
          );
        }
        throw err;
      }
    }
    result.push(hydrateCustomProviderHeaders(persisted));
  }
  return result;
}
