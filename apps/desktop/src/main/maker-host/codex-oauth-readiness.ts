import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { shouldSuppressLocalCodexAuth } from './codex-auth-invalidation.js';
import { isNativeProviderAuthBound } from './nativeProviderAuthBinding.js';

/**
 * 同步、只读地判断当前 owner 是否有可用的 Codex OAuth 登录态。
 *
 * 独立于 auth-adapters 的完整运行时依赖图，供模型目录 / 媒体通道做同步 ready 判定；
 * 真正派发仍必须走 getChatgptBridgeAuth()，以刷新临期 token 并返回同一份 account id。
 */
export function hasCodexOAuthLoginReadOnly(): boolean {
  if (!isNativeProviderAuthBound('openai')) return false;
  const codexHome = path.join(app.getPath('userData'), 'codex-home');
  const authPath = path.join(codexHome, 'auth.json');
  if (shouldSuppressLocalCodexAuth(codexHome, authPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      tokens?: { access_token?: unknown };
    };
    return typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0;
  } catch {
    return false;
  }
}
