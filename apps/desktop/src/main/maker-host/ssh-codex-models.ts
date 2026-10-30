import type { CodexModelListItem } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { mapCodexAppServerModelsToCatalog } from './codex-model-discovery.js';

/** Remote native identity. `openai` retains the existing SSH session wire contract;
 * no controller account, override, gateway route or credential enters this view. */
export function remoteCodexProvider(models: readonly CodexModelListItem[]): ProviderView {
  const preferred = models.find((model) => model.isDefault && !model.hidden)?.model;
  const mapped = mapCodexAppServerModelsToCatalog(models).map((model) => ({
    ...model, defaultEnabled: true,
  }));
  mapped.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
  mapped.forEach((model, index) => { model.sortOrder = index; });
  return {
    id: 'openai', name: 'Codex', source: 'builtin', connected: true,
    agents: ['codex'], auth: { method: 'oauth', native: 'codex' },
    routing: { codex: { upstream: 'https://chatgpt.com/backend-api/codex', authStrategy: 'oauth-passthrough' } },
    models: { codex: mapped },
  };
}
