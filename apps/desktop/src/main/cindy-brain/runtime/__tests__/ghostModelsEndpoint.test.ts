import { describe, expect, it, vi } from 'vitest';

import { handleGhostModelsRequest } from '../ghostModelsEndpoint.js';

const models = [{ id: 'auto', name: 'Auto', target: { type: 'route' } }];

const declared = { types: ['route'] };

function setup(needs: { types: string[] } | undefined | null) {
  let stored: Record<string, unknown> = {};
  const store = { read: () => stored, write: vi.fn((_id: string, value: Record<string, unknown>) => { stored = value; }) };
  const onChanged = vi.fn();
  const call = (method: string, body = '', current = true) => handleGhostModelsRequest({
    ghostId: 'gate', method, readBodyText: async () => body, isCurrent: () => current, needs: () => needs, store, onChanged,
  });
  return { store, onChanged, call, stored: () => stored };
}

// Rule: /models is how a plugin changes what the picker shows, so only a declared capability and a
// valid list may change it, and republishing the same list must not refresh every open picker.
describe('handleGhostModelsRequest', () => {
  it('stores a valid list, reads it back, and notifies only when it changes', async () => {
    const { call, onChanged, store } = setup(declared);
    expect((await call('PUT', JSON.stringify({ models }))).status).toBe(200);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await call('GET')).body!)).toEqual({ models });
    await call('PUT', JSON.stringify({ models }));
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('leaves the list alone when the request is rejected', async () => {
    const undeclared = setup(undefined);
    expect((await undeclared.call('PUT', JSON.stringify({ models }))).status).toBe(403);
    const { call, store } = setup(declared);
    expect((await call('PUT', 'not json')).status).toBe(400);
    const invalid = await call('PUT', JSON.stringify({ models: [{ id: 'auto' }] }));
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body!).error).toContain('name');
    expect((await call('PUT', JSON.stringify({ models }), false)).status).toBe(403);
    expect((await call('DELETE')).status).toBe(405);
    expect(store.write).not.toHaveBeenCalled();
  });

  it('answers 404 for a plugin that is not installed', async () => {
    expect((await setup(null).call('GET')).status).toBe(404);
  });
});
