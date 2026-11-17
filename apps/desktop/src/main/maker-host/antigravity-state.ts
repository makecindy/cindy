import type { Provider } from '@cindy/model-providers';
import type { AntigravityHost } from '@cindy/maker-core/agents/antigravity';
export const ANTIGRAVITY_PROVIDER_ID = 'google-antigravity-subscription';
let snapshot: { isCurrent?: () => boolean; connected: boolean; tier?: { id: string; name: string }; models: Parameters<AntigravityHost['modelsChanged']>[0] } | null = null;
export function setAntigravityState(next: typeof snapshot): void { snapshot = next; }
export function antigravityConnected(): boolean { return snapshot?.isCurrent?.() !== false && snapshot?.connected === true; }
export function antigravityProvider(): Provider | null {
  if (!snapshot || snapshot.isCurrent?.() === false) return null;
  return {
    id: ANTIGRAVITY_PROVIDER_ID, name: 'Google AI · Antigravity', source: 'builtin',
    agents: ['antigravity'], auth: { method: 'oauth' }, access: { kind: 'subscription', product: snapshot.tier?.name ?? 'Google AI' },
    // ACP owns transport and authentication. This descriptor is never an HTTP model endpoint.
    routing: { antigravity: { transport: 'acp', upstream: '', authStrategy: 'oauth-passthrough' } },
    models: { antigravity: snapshot.models.map(m => ({ id: m.id, name: m.name, contextWindow: 0, contextWindowVerified: false, defaultEnabled: true,
      defaultEffort: m.defaultEffort ?? null, efforts: [...(m.efforts ?? [])],
      ...(m.effortDisplayNames ? { effortDisplayNames: m.effortDisplayNames } : {}), supportsFastMode: false, supportsImageInput: false })) },
  };
}
