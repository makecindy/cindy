import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeModelConfig } from '@cindy/model-providers';
import { modelsAfterProviderEndpointEdit } from '../customProviderEndpointEdit';

describe('editing a custom provider endpoint', () => {
  const oldBase = 'https://old.example.test/v1';
  const models: ProviderRuntimeModelConfig[] = [
    { id: 'inherited', name: 'Inherited' },
    { id: 'responses', name: 'Responses', contextWindow: 64000, defaultEnabled: false,
      route: { baseUrl: oldBase, wireProtocol: 'openai-responses', requestPath: '/responses' } },
    { id: 'independent', name: 'Independent', piApi: 'anthropic-messages',
      route: { baseUrl: 'https://old.example.test/anthropic?version=1',
        wireProtocol: 'anthropic-messages', requestPath: '/messages' } },
  ];

  it.each([
    'http://127.0.0.1:1234/v2', 'http://192.168.1.12:8000/v1',
    'https://new.example.test/v1', 'http://old.example.test/v1',
    'https://old.example.test:8443/v1', 'http://[::1]:8000/v1',
    'https://old.example.test/v2',
  ])('moves routes to %s while preserving model protocol and independent paths', nextBase => {
    const original = structuredClone(models);
    const result = modelsAfterProviderEndpointEdit(models, oldBase, nextBase);
    expect(result[0]).toBe(models[0]);
    expect(result[1]).toEqual({ ...models[1], route: { ...models[1].route, baseUrl: nextBase } });
    expect(result[2]).toEqual({ ...models[2], route: {
      ...models[2].route, baseUrl: new URL(nextBase).origin + '/anthropic?version=1',
    } });
    expect(models).toEqual(original);
  });

  it('treats a trailing slash as the same base when the connection path changes', () => {
    const model = { ...models[1], route: { ...models[1].route!, baseUrl: oldBase + '/' } };
    expect(modelsAfterProviderEndpointEdit([model], oldBase, 'https://old.example.test/proxy')[0].route)
      .toEqual({ ...model.route, baseUrl: 'https://old.example.test/proxy' });
  });

  it('preserves unchanged/reverted configurations and newly discovered routes', () => {
    expect(modelsAfterProviderEndpointEdit(models, oldBase, oldBase)).toBe(models);
    expect(modelsAfterProviderEndpointEdit(models, undefined, 'http://localhost:1234')).toBe(models);
    const newModel = { ...models[1], route: { ...models[1].route!, baseUrl: 'http://localhost:1234/new' } };
    expect(modelsAfterProviderEndpointEdit([newModel], oldBase, 'http://localhost:1234')[0]).toBe(newModel);
  });

  it.each(['', 'http://', 'ftp://old.example.test/v1', 'https://user:secret@old.example.test/v1'])(
    'leaves invalid endpoints for the existing validation: %s', endpoint => {
      expect(modelsAfterProviderEndpointEdit(models, oldBase, endpoint)).toBe(models);
      expect(modelsAfterProviderEndpointEdit(models, endpoint, oldBase)).toBe(models);
    },
  );

  it.each(['https://unrelated.example/v1', 'https://user:secret@old.example.test/v1', 'invalid', 'ftp://old.example.test/v1'])(
    'does not launder an unrelated or invalid route: %s', baseUrl => {
      const model = { ...models[1], route: { ...models[1].route!, baseUrl } };
      expect(modelsAfterProviderEndpointEdit([model], oldBase, 'http://localhost:1234')[0]).toBe(model);
    },
  );
});
