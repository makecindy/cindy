/** ChatGPT bridge 上游认证失效原因。 */
export type ChatgptBridgeAuthInvalidationReason =
  'app_session_terminated' | 'token_invalidated' | 'token_revoked' | 'refresh_token_reused';

/** 单次 bridge 上游失败与实际请求凭证的关联信息。 */
export interface ChatgptBridgeAuthFailure {
  status: number;
  body: string;
  failedAccessToken: string;
}

/** bridge 认证失效协调器所需的 host 能力。 */
export interface ChatgptBridgeAuthInvalidatorDependencies {
  getCurrentAccessToken: () => Promise<string | null>;
  invalidate: (reason: ChatgptBridgeAuthInvalidationReason) => Promise<void>;
}

/** 只接受上游明确声明的 OAuth 作废信号；普通 401 可能是账号头/权限问题，不能误删凭证。 */
export function detectChatgptBridgeAuthInvalidationReason(
  status: number,
  body: string,
): ChatgptBridgeAuthInvalidationReason | null {
  if (status !== 401 && status !== 403) return null;
  if (/app_session_terminated|Your session has ended/i.test(body)) {
    return 'app_session_terminated';
  }
  if (/token_invalidated|authentication token has been invalidated/i.test(body)) {
    return 'token_invalidated';
  }
  if (/token_revoked|authentication token has been revoked/i.test(body)) {
    return 'token_revoked';
  }
  if (/refresh token was already used|refresh_token.*already used/i.test(body)) {
    return 'refresh_token_reused';
  }
  return null;
}

/** 从 provider headers 读取 Bearer token，仅用于与当前权威凭证做等值关联。 */
export function bearerAccessTokenFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | null {
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1];
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * 创建请求级失效协调器。
 *
 * 同一 token 的并发 401 合并为一次 invalidate；执行前再次读取当前 token，确保旧请求迟到时
 * 不会把用户刚完成重连的新凭证一并注销。
 */
export function createChatgptBridgeAuthInvalidator(
  dependencies: ChatgptBridgeAuthInvalidatorDependencies,
): (failure: ChatgptBridgeAuthFailure) => Promise<boolean> {
  const inFlightByToken = new Map<string, Promise<boolean>>();

  return async (failure) => {
    const reason = detectChatgptBridgeAuthInvalidationReason(failure.status, failure.body);
    if (!reason) return false;

    const existing = inFlightByToken.get(failure.failedAccessToken);
    if (existing) return await existing;

    const run = (async () => {
      const currentAccessToken = await dependencies.getCurrentAccessToken();
      if (currentAccessToken !== failure.failedAccessToken) return false;
      await dependencies.invalidate(reason);
      return true;
    })();
    inFlightByToken.set(failure.failedAccessToken, run);
    try {
      return await run;
    } finally {
      if (inFlightByToken.get(failure.failedAccessToken) === run) {
        inFlightByToken.delete(failure.failedAccessToken);
      }
    }
  };
}
