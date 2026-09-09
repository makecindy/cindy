/**
 * oneshotProviderUsability.ts — 快问快答钉档的「已配置凭证」同步探测。
 *
 * 钉档清单只应列出**当下真能跑**的 (供应商 × agent):用户没配 key / 没登录的
 * 供应商,钉上只会在执行期 fail-closed(NO_CANDIDATE)——给一个选了就没用的
 * 选项是清单的失职。这里全部走同步缓存态(cindy-prefs 读 handler 是 sendSync,
 * 不能 async);它是展示层过滤,不是安全边界——执行侧仍逐候选现查现验。
 */
import { storedCustomProviderId, type AgentKind, type Provider } from '@cindy/model-providers';

import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getClaudeAiOAuthForSpawn } from '../maker-host/claude-oauth-refresh.js';
import { hasChatgptOneshotReadiness } from '../maker-host/codex-oauth-readiness.js';
import { readCachedGenericOAuthAccessToken } from '../maker-host/generic-oauth.js';
import { hasGrokOAuthLogin } from '../maker-host/grok-oauth-login.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';

/**
 * 该 (供应商, agent) 组合此刻是否有可用凭证。与执行侧(requestBuiltinProviderText /
 * 自定义供应商分支)的凭证判读逐一对应;内置只认执行侧可执行的四家。
 */
export function hasOneshotProviderCredential(provider: Provider, agentKind: AgentKind): boolean {
  if (provider.source === 'builtin') {
    switch (provider.id) {
      case 'xd':
        return Boolean(readClaudeApiKey()) && effectiveXdGatewayBaseUrl().trim().length > 0;
      case 'anthropic':
        return getClaudeAiOAuthForSpawn() !== null;
      case 'openai':
        return hasChatgptOneshotReadiness();
      case 'xai':
        return hasGrokOAuthLogin();
      default:
        return false;
    }
  }
  const routing = provider.routing[agentKind];
  if (!routing) return false;
  if (routing.authStrategy === 'none') return true;
  if (routing.authStrategy === 'oauth-token') {
    return readCachedGenericOAuthAccessToken(
      storedCustomProviderId(provider.id),
      provider.auth?.oauth,
    ) != null;
  }
  if (routing.authStrategy === 'api-key-header') {
    if (readCustomProviderKey(provider.id, agentKind)) return true;
    // 旧版 header-only 配置(凭证直接写在 headerOverride;执行侧同样认)。
    return Object.entries(routing.headerOverride ?? {}).some(([key, value]) => {
      const normalized = key.toLowerCase();
      return (
        (normalized === 'authorization' || normalized === 'x-api-key')
        && value.trim().length > 0
      );
    });
  }
  return false;
}
