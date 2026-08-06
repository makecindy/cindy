import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/unused' },
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => 'https://models.example.test',
}));
vi.mock('../../serverApiClient.js', () => ({
  serverApiFetch: vi.fn(),
}));

import { toModelResolveRequestModels } from '../modelResolve.js';
import { parseModelsListResponseDetailed } from '../../maker-host/generic-oauth.js';

describe('model resolve mode projection', () => {
  it('keeps explicit non-chat provider models out of chat resolve requests', () => {
    const discovered = parseModelsListResponseDetailed({
      data: [
        { id: 'chat', mode: 'chat', type: 'model' },
        { id: 'responses', mode: 'responses' },
        { id: 'unspecified', type: 'model' },
        { id: 'embedding', mode: 'embedding', type: 'embedding' },
      ],
    });
    expect(discovered).not.toBeNull();
    expect(
      toModelResolveRequestModels(discovered ?? []),
    ).toEqual([
      { id: 'chat', name: 'chat', providerReported: { mode: 'chat', type: 'model' } },
      { id: 'responses', name: 'responses', providerReported: { mode: 'responses' } },
      { id: 'unspecified', name: 'unspecified', providerReported: { type: 'model' } },
    ]);
  });
});
