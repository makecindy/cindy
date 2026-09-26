import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { projectGhostAgentModels } from '../ghostAgentModels.js';

const provider = (id: string, efforts: string[]) =>
  ({
    id,
    name: id,
    source: 'user',
    connected: true,
    agents: ['codex'],
    routing: { codex: { enabled: true } },
    models: {
      codex: [
        { id: 'model', name: 'Model', mode: 'chat', efforts, defaultEffort: efforts[0] ?? null },
      ],
    },
    auth: { apiKey: 'secret' },
    endpoint: 'private',
    subscriptionAccount: { identity: 'private' },
  }) as unknown as ProviderView;

describe('plugin model projection', () => {
  it('uses per-route user visibility before catalog defaults without removing hidden models', () => {
    const a = provider('a', ['high']);
    a.models.codex![0]!.defaultEnabled = false;
    const b = provider('b', ['high']);
    const result = projectGhostAgentModels([a,b], (_, id) => id === 'a' ? true : false);
    expect(result.ok && result.models.map(m => m.visible)).toEqual([true,false]);
    const defaults = projectGhostAgentModels([a,b]);
    expect(defaults.ok && defaults.models.map(m => m.visible)).toEqual([false,true]);
  });
  it('preserves per-provider efforts and exposes only explicit metadata fields', () => {
    const result = projectGhostAgentModels([
      provider('a', ['low', 'high']),
      provider('b', ['medium']),
    ]);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'a',
          providerName: 'a',
          efforts: ['low', 'high'],
          defaultEffort: 'low',
        },
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'b',
          providerName: 'b',
          efforts: ['medium'],
          defaultEffort: 'medium',
        },
      ],
    });
  });
  it('excludes disconnected, suspended, disabled, retired, paid-locked and non-chat routes', () => {
    const a = provider('a', []);
    a.models.codex!.push(
      ...['disabled', 'retired', 'locked', 'image'].map((id) => ({
        ...a.models.codex![0]!,
        id,
        disabled: id === 'disabled',
        status: id === 'retired' ? ('retired' as const) : undefined,
        availability: id === 'locked' ? ('requires_payment' as const) : undefined,
        mode: id === 'image' ? 'image' : 'chat',
      })),
    );
    const result = projectGhostAgentModels([
      a,
      { ...provider('offline', []), connected: false },
      { ...provider('paused', []), suspended: true },
    ]);
    expect(result).toEqual({
      ok: true,
      models: [
        {
          visible: true,
          id: 'model',
          name: 'Model',
          agent: 'codex',
          providerId: 'a',
          providerName: 'a',
          efforts: [],
          defaultEffort: null,
        },
      ],
    });
  });
});
