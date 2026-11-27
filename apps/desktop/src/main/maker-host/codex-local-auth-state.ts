import path from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import type { AuthState } from '@cindy/maker-core';
import { shouldSuppressLocalCodexAuth } from './codex-auth-invalidation.js';
import { parseCodexAccountIdentity } from './codex-auth-identity.js';

/** Read only the explicitly selected Cindy home, including durable logout markers. */
export async function readCodexLocalAuthState(codexHome: string, detached = false): Promise<AuthState> {
    if (detached) return { authenticated: false };
    const authPath = path.join(codexHome, 'auth.json');
    if (!existsSync(authPath)) return { authenticated: false };
    // logout 的 marker 先于 unlink 落盘；崩溃 / 文件锁导致旧 auth 残留时也不能复活账号。
    // 新一次显式 OAuth 会写入不同 fingerprint，因此不会被这条规则误伤。
    if (shouldSuppressLocalCodexAuth(codexHome, authPath)) {
      return { authenticated: false };
    }
    try {
      const raw = await fsp.readFile(authPath, 'utf-8');
      const obj = JSON.parse(raw) as {
        account?: { email?: unknown };
        expires_at?: unknown;
        tokens?: { access_token?: unknown };
      };
      // Display metadata only: use the same token claims as independently added accounts.
      // Parsing a label must not change the authentication decision below.
      const identity = typeof obj.account?.email === 'string' && obj.account.email.trim()
        ? obj.account.email
        : parseCodexAccountIdentity(raw)?.label;
      const expiresAt = typeof obj.expires_at === 'number' ? obj.expires_at : undefined;
      // authSource='oauth' 必须与 spawn fallback 的判定同源(hasCodexOAuthLogin =
      // auth.json 含 access_token,见下方 getAccessToken 的字段路径)。`codex login
      // --api-key` 产生的 auth.json 没有 tokens —— 若仅凭"能解析"就标 oauth,
      // maker-core 会把隐式会话归一成 oauth-bearer,而 spawn fallback 实际走
      // gateway key,共享 host 被登记错形态 → 后续显式 oauth 会话静默复用网关
      // key 进程(review P1)。tokens 缺失时不标 authSource,归一化解析不出
      // 即回退保守的"重建"语义,登录门禁(authenticated)不受影响。
      const hasOAuthToken =
        typeof obj.tokens?.access_token === 'string' && obj.tokens.access_token.length > 0;
      return hasOAuthToken
        ? { authenticated: true, identity, expiresAt, authSource: 'oauth' }
        : { authenticated: true, identity, expiresAt };
    } catch {
      // JSON.parse 失败 / IO 错 → 降级为未登录 + errorReason, 不抛
      return { authenticated: false, errorReason: 'auth_parse_failed' };
    }
  }
