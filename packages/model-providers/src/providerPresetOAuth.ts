import type { OAuthProviderDescriptor, ProviderPreset } from './types.js';
import { sourceProviderForPreset } from './providerPresetIdentity.js';

// Public-client contracts from Pi 0.85.1 and Nous Hermes auth_constants/auth_device_flow.
// Empty scopes mean the provider chooses its defaults; do not invent permissions.
export function providerPresetOAuth(id: string): OAuthProviderDescriptor | undefined {
  switch (sourceProviderForPreset(id)) {
    case 'openrouter': return {
      authorizeUrl: 'https://openrouter.ai/auth', tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
      clientId: 'cindy', scopes: '', modelsDiscoveryUrl: 'https://openrouter.ai/api/v1/models',
    };
    case 'minimax':
    case 'minimax-cn': {
      const host = sourceProviderForPreset(id) === 'minimax-cn' ? 'https://api.minimaxi.com' : 'https://api.minimax.io';
      return { flow: 'device-code', deviceAuthorizationUrl: `${host}/oauth/code`, tokenUrl: `${host}/oauth/token`,
        clientId: '78257093-7e40-4613-99e0-527b14b39113', scopes: 'group_id profile model.completion' };
    }
    case 'nous': return {
      flow: 'device-code', deviceAuthorizationUrl: 'https://portal.nousresearch.com/api/oauth/device/code',
      tokenUrl: 'https://portal.nousresearch.com/api/oauth/token', clientId: 'hermes-cli', scopes: 'inference:invoke',
      modelsDiscoveryUrl: 'https://inference-api.nousresearch.com/v1/models',
    };
    case 'github-copilot': return {
      flow: 'device-code', deviceAuthorizationUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token', clientId: 'Iv1.b507a08c87ecfe98', scopes: 'read:user',
    };
    case 'kimi-coding': return {
      flow: 'device-code', deviceAuthorizationUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
      tokenUrl: 'https://auth.kimi.com/api/oauth/token', clientId: '17e5f671-d194-4dfb-9706-5516cb48c098', scopes: '',
    };
    default: return undefined;
  }
}

export function providerOAuthContract(oauth: OAuthProviderDescriptor): 'openrouter' | 'copilot' | 'nous' | 'minimax' | undefined {
  if (oauth.flow !== 'device-code' && oauth.authorizeUrl === 'https://openrouter.ai/auth'
    && oauth.tokenUrl === 'https://openrouter.ai/api/v1/auth/keys') return 'openrouter';
  if (oauth.flow === 'device-code' && oauth.deviceAuthorizationUrl === 'https://github.com/login/device/code'
    && oauth.tokenUrl === 'https://github.com/login/oauth/access_token') return 'copilot';
  if (oauth.flow === 'device-code' && oauth.deviceAuthorizationUrl === 'https://portal.nousresearch.com/api/oauth/device/code'
    && oauth.tokenUrl === 'https://portal.nousresearch.com/api/oauth/token') return 'nous';
  if (oauth.flow === 'device-code' && ['https://api.minimax.io', 'https://api.minimaxi.com'].some(host =>
    oauth.deviceAuthorizationUrl === `${host}/oauth/code` && oauth.tokenUrl === `${host}/oauth/token`)) return 'minimax';
  return undefined;
}

/** Subscription login may have a different endpoint from a provider's API-key product. */
export function providerPresetOAuthRuntimes(preset: ProviderPreset): ProviderPreset['runtimes'] {
  const source = sourceProviderForPreset(preset.id);
  if (source !== 'minimax' && source !== 'minimax-cn') return Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, runtime && { ...runtime, catalogPresetId: preset.id }]));
  const baseUrl = source === 'minimax-cn' ? 'https://api.minimaxi.com/anthropic' : 'https://api.minimax.io/anthropic';
  return Object.fromEntries(Object.entries(preset.runtimes).map(([agent, runtime]) => [agent, runtime && {
    ...runtime, catalogPresetId: preset.id, baseUrl, wireProtocol: 'anthropic-messages', modelsUrl: `${baseUrl}/v1/models`,
    models: runtime.models.map(({ route: _route, ...model }) => ({ ...model, api: 'anthropic-messages',
      ...(agent === 'pi' ? { piApi: 'anthropic-messages' } : {}) })),
  }]));
}
