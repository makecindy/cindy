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

/**
 * 同步、只读地判断 OpenAI(Codex)是否可作快问快答的显式路由。
 *
 * 与 hasCodexOAuthLoginReadOnly 的区别:执行侧(getChatgptBridgeAuth → 请求
 * /responses)要求能解析出非空 accountId —— 只有 access_token 还不够(单账号
 * Codex 登录可能 account_id 缺省,但 id_token 可回落解析)。清单侧若只看
 * access_token,会把「清单显示可用、钉了却 NO_CANDIDATE」的条目露给用户
 * (Codex 2026-08-06 P2)。
 *
 * 同步判定:account_id 非空,或 id_token 非空(执行侧 accountIdFrom 回落
 * 解 id_token,同步层不重复解析 JWT,只要求原料存在)。二者都没有 = 无法
 * 解析 accountId,执行侧必拒。
 */
export function hasChatgptOneshotReadiness(): boolean {
  if (!isNativeProviderAuthBound('openai')) return false;
  const codexHome = path.join(app.getPath('userData'), 'codex-home');
  const authPath = path.join(codexHome, 'auth.json');
  if (shouldSuppressLocalCodexAuth(codexHome, authPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
      tokens?: { access_token?: unknown; account_id?: unknown; id_token?: unknown };
    };
    if (typeof parsed.tokens?.access_token !== 'string' || parsed.tokens.access_token.length === 0) {
      return false;
    }
    return (
      (typeof parsed.tokens?.account_id === 'string' && parsed.tokens.account_id.length > 0)
      || (typeof parsed.tokens?.id_token === 'string' && parsed.tokens.id_token.length > 0)
    );
  } catch {
    return false;
  }
}
