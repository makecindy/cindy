/**
 * authTokenClaims — access token JWT payload 的只读解码(不验签)。
 *
 * auth-server 在 ctx=org 的 access token 里注入 orgSlug claim(组织稳定标识,
 * 由已验证域名派生、全局唯一,见 auth-server lib/jwt.ts)。membership 响应不含
 * slug,客户端需要它做企业功能分流(如 Skill Hub 市场可见性)时从 token 解码。
 * 只做 base64url 解码——token 来自可信 TLS 通道,此值仅用于 UI 级分流,
 * 真正的授权仍由服务端校验。独立成模块以便脱离 Electron 依赖做单测。
 */

/** 解出 access token 的 orgSlug claim;个人身份、旧 token 或解码失败为 null。 */
export function decodeAccessTokenOrgSlug(token: string | null): string | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      orgSlug?: unknown;
    };
    return typeof claims.orgSlug === 'string' && claims.orgSlug.length > 0 ? claims.orgSlug : null;
  } catch {
    return null;
  }
}

/**
 * How long until the runtime refresh of this access token is due, in ms from `nowMs`: its `exp`
 * minus 300 seconds. ≤ 0 means due now. Throws on a token whose payload is not JSON, and gives
 * NaN for one without a numeric `exp`, exactly as the desktop's scheduleRefresh computed it
 * (authManager.ts), which now calls this; the Node Host schedules with the same function.
 */
export function accessTokenRefreshDelayMs(token: string, nowMs: number): number {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'));
  return (payload.exp - 300) * 1000 - nowMs;
}
