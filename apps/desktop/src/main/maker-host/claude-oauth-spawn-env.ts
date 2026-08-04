/**
 * claude-oauth-spawn-env —— 订阅 OAuth 凭证 → cc 子进程 env 字段的唯一翻译点。
 *
 * token + 身份元数据(scopes / subscriptionType / rateLimitTier)必须一起递:cc
 * env-token 分支默认 scopes 只有 user:inference,不递会丢订阅身份细节(feature
 * gate / beta header 判定用)。本地 oauth-spawn(auth-adapters getAuthEnv)与远端
 * 路由 materialization(remote-claude-route)共用本函数 —— 两处各写一份时,新增
 * 身份字段会静默漂移。
 *
 * 纯函数、无 electron / fs 依赖:remote-claude-route 的单测 mock 掉了
 * auth-adapters / claude-credentials-store,本模块保持真实实现参与测试。
 */

import type { ClaudeAiOAuth } from './claude-credentials-store.js';

export function claudeOAuthSpawnEnv(oauth: ClaudeAiOAuth): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken };
  if (Array.isArray(oauth.scopes) && oauth.scopes.length > 0) {
    env.CLAUDE_CODE_OAUTH_SCOPES = oauth.scopes.join(' ');
  }
  if (typeof oauth.subscriptionType === 'string' && oauth.subscriptionType) {
    env.CLAUDE_CODE_SUBSCRIPTION_TYPE = oauth.subscriptionType;
  }
  if (typeof oauth.rateLimitTier === 'string' && oauth.rateLimitTier) {
    env.CLAUDE_CODE_RATE_LIMIT_TIER = oauth.rateLimitTier;
  }
  return env;
}
