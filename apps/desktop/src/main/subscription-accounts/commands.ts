import { throwIpcError } from '../utils/ipcValidate.js';
import {
  isSubscriptionPoolProviderIdShape,
  isSubscriptionProvider,
  type SubscriptionAccountCommand,
  type SubscriptionSessionAccountQuery,
} from '../../shared/subscriptionAccounts.js';
import { PROVIDER_GROUP_STRATEGIES } from '../../shared/providerGroup.js';
import { accountIdValid } from './store.js';

/** null when `raw` is not a session read; it never reaches the management command executor. */
export function parseSubscriptionSessionAccountQuery(
  raw: unknown,
): SubscriptionSessionAccountQuery | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.action !== 'session') return null;
  if (!isSubscriptionProvider(value.providerId))
    throwIpcError('INVALID_PARAMS', 'Invalid subscription provider');
  const id = (key: 'sessionId' | 'nativeSessionId') => {
    const item = value[key];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== 'string' || !item || item.length > 256)
      throwIpcError('INVALID_PARAMS', 'Invalid subscription session');
    return item;
  };
  const sessionId = id('sessionId');
  const nativeSessionId = id('nativeSessionId');
  const legacyProviderId = value.legacyProviderId;
  const routeProviderId = value.routeProviderId;
  if (routeProviderId !== undefined && (!isSubscriptionPoolProviderIdShape(routeProviderId) || legacyProviderId !== undefined))
    throwIpcError('INVALID_PARAMS', 'Invalid subscription route');
  if (legacyProviderId !== undefined
    && (value.providerId !== 'openai' || typeof legacyProviderId !== 'string'
      || !legacyProviderId.trim() || legacyProviderId.length > 256))
    throwIpcError('INVALID_PARAMS', 'Invalid legacy subscription provider');
  if (!sessionId && !nativeSessionId && !legacyProviderId && !routeProviderId)
    throwIpcError('INVALID_PARAMS', 'Invalid subscription session');
  const model = value.model;
  if (model !== undefined && model !== null
    && (typeof model !== 'string' || !model.trim() || model.length > 512))
    throwIpcError('INVALID_PARAMS', 'Invalid subscription model');
  return {
    action: 'session',
    providerId: value.providerId,
    ...(sessionId ? { sessionId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof legacyProviderId === 'string' ? { legacyProviderId } : {}),
    ...(typeof routeProviderId === 'string' ? { routeProviderId } : {}),
  };
}

export function parseSubscriptionAccountCommand(raw: unknown): SubscriptionAccountCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throwIpcError('INVALID_PARAMS', 'Invalid account command');
  const value = raw as Record<string, unknown>;
  // Built-in providers own the CLI default login; detection, connecting and creating start there.
  // Other commands may name any provider that owns accounts (2026-11-13); the executing host
  // resolves it against its own records and rejects unknown ones.
  const builtinOnly = value.action === 'preview' || value.action === 'connect' || value.action === 'create';
  if (builtinOnly ? !isSubscriptionProvider(value.providerId) : !isSubscriptionPoolProviderIdShape(value.providerId))
    throwIpcError('INVALID_PARAMS', 'Invalid subscription provider');
  const providerId = value.providerId as string;
  const loginKey = value.loginKey;
  const accountId = value.accountId;
  const validLoginKey = typeof loginKey === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(loginKey);
  if (value.action === 'read' && value.taskId !== undefined) {
    if (typeof value.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.taskId))
      throwIpcError('INVALID_PARAMS', 'Invalid task');
    return { action: 'read', providerId, taskId: value.taskId };
  }
  if (value.action === 'read') return { action: 'read', providerId };
  if (value.action === 'preview' && isSubscriptionProvider(providerId)) return { action: 'preview', providerId };
  if (
    value.action === 'connect' &&
    isSubscriptionProvider(providerId) &&
    validLoginKey &&
    (value.target === 'default' || value.target === 'new')
  )
    return { action: 'connect', providerId, loginKey, target: value.target };
  if (value.action === 'create' && isSubscriptionProvider(providerId) && validLoginKey)
    return { action: 'create', providerId, loginKey };
  if (value.action === 'place' && accountIdValid(accountId) && accountId !== 'default'
    && (value.target === null || isSubscriptionPoolProviderIdShape(value.target)))
    return { action: 'place', providerId, accountId, target: value.target };
  if (value.action === 'merge' && isSubscriptionPoolProviderIdShape(value.target) && value.target !== providerId)
    return { action: 'merge', providerId, target: value.target };
  if (value.action === 'remove-provider' && !isSubscriptionProvider(providerId))
    return { action: 'remove-provider', providerId };
  if ((value.action === 'add' || value.action === 'cancel') && validLoginKey)
    return { action: value.action, providerId, loginKey };
  if (value.action === 'login' && accountIdValid(accountId) && validLoginKey)
    return { action: 'login', providerId, accountId, loginKey };
  if (value.action === 'remove' && accountIdValid(accountId))
    return { action: 'remove', providerId, accountId };
  if (value.action === 'configure') {
    if (
      value.strategy !== undefined &&
      !PROVIDER_GROUP_STRATEGIES.includes(value.strategy as never)
    )
      throwIpcError('INVALID_PARAMS', 'Invalid strategy');
    if (accountId !== undefined && !accountIdValid(accountId))
      throwIpcError('INVALID_PARAMS', 'Invalid account');
    if (value.paused !== undefined && typeof value.paused !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'Invalid pause setting');
    for (const [key, max] of [
      ['limit', 16],
      ['weight', 100],
    ] as const) {
      // limit: null clears the setting (unlimited concurrency).
      if (key === 'limit' && value.limit === null) continue;
      if (
        value[key] !== undefined &&
        (!Number.isInteger(value[key]) ||
          (value[key] as number) < 1 ||
          (value[key] as number) > max)
      )
        throwIpcError('INVALID_PARAMS', 'Invalid account setting');
    }
    if (
      accountId === undefined &&
      (value.paused !== undefined || value.limit !== undefined || value.weight !== undefined)
    )
      throwIpcError('INVALID_PARAMS', 'Account required');
    return {
      action: 'configure',
      providerId,
      accountId,
      strategy: value.strategy,
      paused: value.paused,
      limit: value.limit,
      weight: value.weight,
    } as SubscriptionAccountCommand;
  }
  throwIpcError('INVALID_PARAMS', 'Invalid account command');
}
