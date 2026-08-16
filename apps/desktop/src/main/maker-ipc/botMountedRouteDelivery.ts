import type { BotRouteDeliveryInput, BotRouteDeliveryResult } from '../im/index.js';
import type { BotDeliveryAttemptResult, BotDeliveryRow } from './botDeliveryOutboxService.js';

export interface MountedBotRouteSnapshot {
  botId: string;
  channelId: string;
  currentSessionId: string | null;
  ownerGeneration: number;
  principalKey: string;
  threadKey: string | null;
  capabilitiesJson: string;
  routeStatus: string;
  channelKind: string;
  channelEnabled: boolean;
  channelConfigJson: string;
}

export interface MountedBotRouteDeliveryDeps {
  loadWorkingDir(sessionId: string): Promise<string | null>;
  loadRoute(routeId: string): Promise<MountedBotRouteSnapshot | null>;
  deliver?(input: BotRouteDeliveryInput): Promise<BotRouteDeliveryResult>;
}

export interface MountedBotRouteDeliveryAttempt {
  recordExternalDispatch(input: { retrySafe: boolean; transport: string }): Promise<void>;
  recordProgress(receipt: Record<string, unknown>): Promise<void>;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function deliverMountedBotRoute(
  input: {
    row: BotDeliveryRow;
    persistedContent: string;
    mediaAbsPaths?: readonly string[];
    targetSessionId?: string | null;
    requireCurrentSessionMatch?: boolean;
    attempt: MountedBotRouteDeliveryAttempt;
  },
  deps: MountedBotRouteDeliveryDeps,
): Promise<BotDeliveryAttemptResult> {
  if (!input.row.routeId) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'ROUTE_REQUIRED',
      message: 'Direct Bot Channel recovery requires an active Route.',
    };
  }
  const targetSessionId = input.targetSessionId === undefined
    ? input.row.sessionId
    : input.targetSessionId;
  const [route, workingDir] = await Promise.all([
    deps.loadRoute(input.row.routeId),
    targetSessionId ? deps.loadWorkingDir(targetSessionId) : Promise.resolve(null),
  ]);
  if (!route || route.botId !== input.row.botId || route.channelId !== input.row.channelId) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'ROUTE_OWNERSHIP_MISMATCH',
      message: 'Bot delivery route no longer belongs to the mounted Channel.',
    };
  }
  if (route.ownerGeneration !== input.row.ownerGeneration) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'STALE_ROUTE_OWNER',
      message: 'Bot delivery route ownership changed before Channel dispatch.',
    };
  }
  if (
    input.requireCurrentSessionMatch
    && targetSessionId
    && route.currentSessionId !== targetSessionId
  ) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'STALE_ROUTE_TASK',
      message: 'Bot delivery route now points to a different task.',
    };
  }
  if (route.routeStatus !== 'active' || !route.channelEnabled) {
    return {
      ok: false,
      retryable: true,
      errorCode: 'ROUTE_UNAVAILABLE',
      message: `Bot delivery route is ${route.routeStatus}.`,
    };
  }
  const channelConfig = parseRecord(route.channelConfigJson);
  const routeCapabilities = parseRecord(route.capabilitiesJson);
  const ownership = channelConfig.ownership;
  const accountKey = typeof channelConfig.accountKey === 'string'
    ? channelConfig.accountKey.trim()
    : '';
  if ((ownership !== 'local-adapter' && ownership !== 'server-relay') || !accountKey) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'INVALID_CHANNEL_CONFIG',
      message: 'Bot Channel delivery identity is incomplete.',
    };
  }
  if (!deps.deliver) {
    return {
      ok: false,
      retryable: true,
      errorCode: 'CHANNEL_DELIVERY_NOT_READY',
      message: 'Bot Channel delivery is not initialized.',
    };
  }
  await input.attempt.recordExternalDispatch({
    retrySafe: ownership === 'server-relay' || route.channelKind === 'wechat',
    transport: ownership,
  });
  const delivered = await deps.deliver({
    channel: route.channelKind,
    ownership,
    accountKey,
    principalKey: route.principalKey,
    threadKey: route.threadKey,
    deliveryKey:
      typeof routeCapabilities.deliveryKey === 'string'
        ? routeCapabilities.deliveryKey
        : null,
    idempotencyKey: input.row.idempotencyKey,
    text: input.persistedContent,
    sessionId: targetSessionId,
    workingDir,
    onProgress: input.attempt.recordProgress,
    mediaAbsPaths: input.mediaAbsPaths ?? [],
  });
  return delivered.ok
    ? { ok: true, receipt: delivered.receipt }
    : {
        ok: false,
        retryable: delivered.retryable,
        errorCode: delivered.errorCode,
        message: delivered.message,
      };
}
