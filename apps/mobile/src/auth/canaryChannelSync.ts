/** 登录态 feature-flags 请求与本地 canary 快照之间的竞态安全协调器。 */

export interface CanarySyncRequest {
  token: string;
  expectedAuthGeneration: number;
}

export interface CanarySyncDeps {
  fetchFeatureFlags(token: string): Promise<unknown>;
  readCurrentAuthGeneration(): number;
  persistFlag(isCanary: boolean): Promise<void> | void;
}

export type CanarySyncOutcome =
  | { kind: 'synced'; isCanary: boolean; defaultEnableBeta?: boolean }
  | {
      kind: 'preserved';
      reason:
        'request-failed' | 'invalid-response' | 'stale-auth' | 'persist-failed';
      defaultEnableBeta?: boolean;
    };

/** 请求失败/非法时保留旧值；登出或换账号后的迟到响应不得覆盖新身份。 */
export async function syncCanaryChannelAfterAuth(
  request: CanarySyncRequest,
  deps: CanarySyncDeps,
): Promise<CanarySyncOutcome> {
  let value: unknown;
  try {
    value = await deps.fetchFeatureFlags(request.token);
  } catch {
    return { kind: 'preserved', reason: 'request-failed' };
  }
  const flags =
    value && typeof value === 'object'
      ? (value as { isCanary?: unknown; defaultEnableBeta?: unknown })
      : undefined;
  const isCanary = flags?.isCanary;
  const defaultEnableBeta = readOptionalDefaultEnableBeta(flags?.defaultEnableBeta);
  if (typeof isCanary !== 'boolean') {
    return {
      kind: 'preserved',
      reason: 'invalid-response',
      ...defaultEnableBeta,
    };
  }
  if (deps.readCurrentAuthGeneration() !== request.expectedAuthGeneration) {
    return { kind: 'preserved', reason: 'stale-auth', ...defaultEnableBeta };
  }
  try {
    await deps.persistFlag(isCanary);
  } catch {
    return { kind: 'preserved', reason: 'persist-failed', ...defaultEnableBeta };
  }
  return { kind: 'synced', isCanary, ...defaultEnableBeta };
}

function readOptionalDefaultEnableBeta(
  value: unknown,
): { defaultEnableBeta: true } | Record<string, never> {
  return value === true ? { defaultEnableBeta: true } : {};
}
