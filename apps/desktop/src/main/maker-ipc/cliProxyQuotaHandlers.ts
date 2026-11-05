import { cliProxyManagementBase } from '../../shared/cliProxyQuota.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { fetchCliProxyQuota } from '../usage/cliProxyQuota.js';

export interface CliProxyQuotaHandlerDeps {
  assertTrusted(event: unknown): void;
  scope(): string;
  isBoundaryPending(): boolean;
  baseUrl(providerId: string): Promise<string | null>;
  identity(providerId: string): string;
  readKey(providerId: string): string | null;
  writeKey(providerId: string, key: string): boolean;
  removeKey(providerId: string): boolean;
  fetch: typeof fetch;
}

export function registerCliProxyQuotaHandlers(
  registry: IpcHandlerRegistry,
  deps: CliProxyQuotaHandlerDeps,
): void {
  const pending = new Set<string>();
  const revisions = new Map<string, number>();
  registry.handle('maker:usage:cli-proxy', async (event, rawId, rawKey, rawRefresh) => {
    deps.assertTrusted(event);
    const id = requireString(rawId, 'providerId');
    if (
      !/^[a-z0-9_-]{1,80}$/.test(id) ||
      (rawKey !== undefined && (typeof rawKey !== 'string' || rawKey.length > 4096))
    )
      throwIpcError('INVALID_ARGUMENT', 'Invalid quota request');
    if (rawRefresh !== undefined && typeof rawRefresh !== 'boolean')
      throwIpcError('INVALID_ARGUMENT', 'Invalid refresh');
    const scope = deps.scope();
    const current = () => !deps.isBoundaryPending() && deps.scope() === scope;
    const baseUrl = await deps.baseUrl(id);
    if (!current()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    if (!baseUrl || !cliProxyManagementBase(baseUrl))
      throwIpcError('INVALID_ARGUMENT', 'A local custom provider is required');
    const identity = deps.identity(id);
    const lock = `${scope}:${id}`;
    if (rawKey === '') {
      revisions.set(lock, (revisions.get(lock) ?? 0) + 1);
      if (!deps.removeKey(identity))
        throwIpcError('PRECONDITION_FAILED', 'Could not disconnect quota');
      return { configured: false, accounts: [], observedAt: Date.now() };
    }
    const key = typeof rawKey === 'string' ? rawKey.trim() : deps.readKey(identity);
    if (!key) return { configured: false, accounts: [], observedAt: Date.now() };
    if (rawKey === undefined && rawRefresh !== true)
      return { configured: true, accounts: [], observedAt: 0 };
    if (pending.has(lock)) throwIpcError('PRECONDITION_FAILED', 'Quota refresh in progress');
    pending.add(lock);
    const revision = revisions.get(lock) ?? 0;
    try {
      const snapshot = await fetchCliProxyQuota(baseUrl, key, {
        fetch: deps.fetch,
        isCurrent: current,
      });
      if (
        !current() ||
        (revisions.get(lock) ?? 0) !== revision ||
        (await deps.baseUrl(id)) !== baseUrl ||
        deps.identity(id) !== identity ||
        !current()
      )
        throw new Error('Connection changed');
      if (rawKey !== undefined && !deps.writeKey(identity, key))
        throw new Error('Could not save quota key');
      return snapshot;
    } catch {
      // Never forward provider errors, credential files or request headers.
      throwIpcError('PRECONDITION_FAILED', 'Could not read CLI proxy quota');
    } finally {
      pending.delete(lock);
    }
  });
}
