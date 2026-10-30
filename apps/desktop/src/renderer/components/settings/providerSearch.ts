import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../../shared/llamaCpp';
import { PROVIDER_MEDIA_FIELDS, presetDisplayName, providerPresetOAuth, type ProviderPreset, type ProviderView } from '@cindy/model-providers';
import { isBuiltinApiKeyProviderId } from '../../../shared/providerSecrets';
import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime';

export type ProviderSearchTarget =
  | { kind: 'builtin'; providerId: string }
  | { kind: 'preset'; presetId: string; speechOnly?: boolean }
  | { kind: 'ollama' }
  | { kind: 'llamacpp' };

export function hasRetainedBuiltinConnection(provider: ProviderView): boolean {
  return !provider.removed && (provider.connected || provider.removed === false);
}
export function isWizardOAuthChoice(p: ProviderView): boolean {
  return p.id !== 'xd' && p.source === 'builtin' &&
    (!hasRetainedBuiltinConnection(p) || ['anthropic', 'openai', 'xai'].includes(p.id)) &&
    (['anthropic', 'openai', 'xai'].includes(p.id) || (p.auth.method === 'oauth' && !!p.auth.oauth));
}
export function isWizardApiKeyChoice(p: ProviderView): boolean {
  return p.source === 'builtin' && p.auth.method === 'apiKey' &&
    isBuiltinApiKeyProviderId(p.id) && !hasRetainedBuiltinConnection(p) &&
    PROVIDER_MEDIA_FIELDS.some(field => (p[field]?.length ?? 0) > 0);
}
export interface ProviderSearchResult {
  key: string;
  id: string;
  name: string;
  names: string[];
  metaKey: string;
  target: ProviderSearchTarget;
}
export function providerSearchChoices(providers: ProviderView[], presets: ProviderPreset[], locale: string, ollamaName: string, llamaCppName = 'llama.cpp'): ProviderSearchResult[] {
  const results: ProviderSearchResult[] = [];
  for (const p of providers) {
    if (!isWizardOAuthChoice(p) && !isWizardApiKeyChoice(p)) continue;
    results.push({ key: `builtin:${p.id}`, id: p.id, name: p.name, names: [p.name],
      metaKey: isWizardApiKeyChoice(p) ? 'metaApiKey' : 'metaLoginOrApi', target: { kind: 'builtin', providerId: p.id } });
  }
  for (const p of presets) {
    results.push({ key: `preset:${p.id}`, id: p.id, name: presetDisplayName(p, locale),
      names: [p.name, p.nameEn, p.nameZhTW].filter((n): n is string => !!n),
      metaKey: providerPresetOAuth(p.id) ? 'metaLoginOrApi' : p.authMethod === 'none' ? 'metaNoAuth' : 'metaApiKey',
      target: { kind: 'preset', presetId: p.id } });
  }
  if (!providers.some(p => p.id === MANAGED_OLLAMA_PROVIDER_ID)) {
    results.push({ key: 'ollama', id: 'ollama', name: ollamaName, names: [ollamaName, 'Ollama'], metaKey: 'metaLocalConnect', target: { kind: 'ollama' } });
  }
  if (!providers.some(p => p.id === MANAGED_LLAMACPP_PROVIDER_ID)) {
    results.push({ key: 'llamacpp', id: 'llamacpp', name: llamaCppName, names: [llamaCppName, 'llama.cpp'], metaKey: 'metaLocalConnect', target: { kind: 'llamacpp' } });
  }
  return [...new Map(results.map(p => [p.key, p])).values()];
}
export function matchProviderChoices(choices: ProviderSearchResult[], query: string): ProviderSearchResult[] {
  const q = query.trim().toLowerCase();
  return q ? choices.filter(p => [p.name, ...p.names].some(n => n.toLowerCase().includes(q))) : [];
}
