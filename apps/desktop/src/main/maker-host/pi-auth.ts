import type { AuthAdapter, AuthAdapterOptions, AuthState } from '@cindy/maker-core';
import { storedCustomProviderId } from '@cindy/model-providers';
import { getActiveCatalog } from './active-catalog.js';
import { mergeByokNativeConfigs } from '../model-access/byokProvider.js';
import { createLogger } from '../logger.js';
const log = createLogger('pi-auth');
const PI_API_KEY_ENV = 'CINDY_PI_API_KEY';
const PI_PROVIDER_AUTH_PLACEHOLDER_KEY = 'cindy-pi-provider-auth-placeholder';
const PI_OAUTH_SUBSCRIPTION_PROVIDERS = new Set(['openai']);
/** One auth verdict for Desktop and Node; the launcher owns credential I/O. */
export function createPiAuthAdapter(ports: {
subscriptionAccountKind: typeof import('./subscription-account-auth.js').subscriptionAccountKind;
subscriptionAccountState: typeof import('./subscription-account-auth.js').subscriptionAccountState;
isOpenAiSubscriptionProviderId: typeof import('./codex-account-auth.desktop.js').isOpenAiSubscriptionProviderId;
desktopCodexAuthAdapter: Pick<AuthAdapter, "getState">;
hasGrokOAuthLogin: typeof import('./grok-oauth-login.desktop.js').hasGrokOAuthLogin;
listCustomProvidersWithSecureHeaders: typeof import('./custom-provider-header-secrets.js').listCustomProvidersWithSecureHeaders;
readCustomProviderKey: typeof import('../secrets/providerSecretStore.js').readCustomProviderKey;
readCachedGenericOAuthAccessToken: typeof import('./generic-oauth.desktop.js').readCachedGenericOAuthAccessToken;
readClaudeApiKey: typeof import('./auth-adapters.js').readClaudeApiKey;
}): AuthAdapter {
const { subscriptionAccountKind, subscriptionAccountState, isOpenAiSubscriptionProviderId, desktopCodexAuthAdapter, hasGrokOAuthLogin, listCustomProvidersWithSecureHeaders, readCustomProviderKey, readCachedGenericOAuthAccessToken, readClaudeApiKey } = ports;
class DesktopPiAuthAdapter implements AuthAdapter {
  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    if (options?.nativeSubscriptionAccount && options.providerId === 'openai')
      return options.nativeSubscriptionAccount.readState();
    const providerId = options?.providerId?.trim() || null;
    if (providerId && subscriptionAccountKind(providerId)) return subscriptionAccountState(providerId);
    // Claude 订阅只供内置 Claude Code CLI 使用,Pi 会话不能选它(旧会话在此明确拒绝)。
    if (providerId === 'anthropic') {
      return { authenticated: false, errorReason: 'anthropic_oauth_unavailable' };
    }
    if (providerId && isOpenAiSubscriptionProviderId(providerId)) {
      return desktopCodexAuthAdapter.getState({ credentialMode: 'oauth-bearer', providerId });
    }
    if (providerId === 'xai') {
      return hasGrokOAuthLogin()
        ? { authenticated: true, identity: 'SuperGrok', authSource: 'oauth' }
        : { authenticated: false, errorReason: 'xai_oauth_unavailable' };
    }
    if (providerId) {
      const storageProviderId = storedCustomProviderId(providerId);
      try {
        const custom = mergeByokNativeConfigs(
          await listCustomProvidersWithSecureHeaders(),
          getActiveCatalog().providers,
        ).find(
          (provider) => provider.id === storageProviderId && provider.runtimes.pi,
        );
        if (custom) {
          const method = custom.auth?.method ?? 'apiKey';
          if (method === 'none') {
            // AuthState 只有 oauth/api-key 两种“子进程凭证族”；keyless native provider
            // 归入 provider-key 族即可，实际 models.json 使用固定 dummy key。
            return { authenticated: true, identity: custom.name, authSource: 'api-key' };
          }
          if (method === 'apiKey') {
            const hasHeaderCredential = Object.keys(custom.runtimes.pi?.headers ?? {}).length > 0;
            return readCustomProviderKey(storageProviderId, 'pi') || hasHeaderCredential
              ? { authenticated: true, identity: custom.name, authSource: 'api-key' }
              : { authenticated: false, errorReason: 'pi_native_api_key_unavailable' };
          }
          if (method === 'oauth' && custom.auth?.method === 'oauth' && custom.auth.oauth) {
            return readCachedGenericOAuthAccessToken(storageProviderId, custom.auth.oauth)
              ? { authenticated: true, identity: custom.name, authSource: 'oauth' }
              : { authenticated: false, errorReason: 'pi_native_oauth_unavailable' };
          }
          return { authenticated: false, errorReason: 'pi_native_oauth_unsupported' };
        }
      } catch (err) {
        log.warn('pi auth: custom provider lookup failed', {
          providerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const key = readClaudeApiKey();
    if (!key) {
      return { authenticated: false, errorReason: 'cindy_gateway_key_unavailable' };
    }
    return { authenticated: true, identity: 'Cindy AI', authSource: 'api-key' };
  }

  async triggerLogin(): Promise<AuthState> {
    // pi 无独立登录面;网关 key 随 Cindy 账号凭据同步下发。
    return this.getState();
  }

  async logout(): Promise<void> {
    // 网关 key 生命周期归账号体系管,pi 侧无可清理凭证。
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    options?.nativeSubscriptionAccount?.assertCurrent();
    // 共用 cindy provider 的订阅 OAuth 路由用占位符(真凭证由 compat proxy 注入)。
    if (options?.providerId && (PI_OAUTH_SUBSCRIPTION_PROVIDERS.has(options.providerId)
      || isOpenAiSubscriptionProviderId(options.providerId))) {
      return { [PI_API_KEY_ENV]: PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
    }
    const key = readClaudeApiKey();
    // xAI/BYOM 不依赖 Cindy 登录。models.json 始终包含 gateway `cindy` 块，
    // 有网关 key 就保留给会话内切回 Cindy/XD；无 key 时才用不可用占位值。
    // xAI 原生块自身使用 PI_XAI_PROXY_API_KEY_ENV，不再与网关块争用此变量。
    return { [PI_API_KEY_ENV]: key ?? PI_PROVIDER_AUTH_PLACEHOLDER_KEY };
  }
}

return new DesktopPiAuthAdapter();
}
