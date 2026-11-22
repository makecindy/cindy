import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeishuLocalHostSetupAdapter } from '../setupAdapter.ts';

function fakePort(overrides = {}) {
  return {
    readAuth: async () => ({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'NOT_AUTHORIZED' }),
    connect: async () => ({ ok: true }),
    ...overrides,
  };
}

function setup(options = {}) {
  const bodies = [];
  const confirmations = {
    confirm: async payload => { bodies.push(payload.body); return true; },
  };
  const state = { owner: 'owner-a:1', current: true, connectCalls: [] };
  const adapter = createFeishuLocalHostSetupAdapter({
    port: fakePort({
      connect: async input => { state.connectCalls.push(input); return { ok: true }; },
    }),
    confirmations,
    current: () => state.current,
    ownerScope: () => state.owner,
    t: key => key,
    ...options,
  });
  return { adapter, bodies, state };
}

test('imports an existing terminal login through one owner-bound confirmation', async () => {
  const { adapter, bodies, state } = setup({
    port: fakePort({
      readAuth: async () => ({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_REQUIRED' }),
      connect: async input => { state.connectCalls.push(input); return { ok: true }; },
    }),
  });
  const result = await adapter({});
  assert.equal(result.ok, true);
  assert.equal(state.connectCalls.length, 1);
  assert.equal(state.connectCalls[0].mode, 'import-terminal');
  assert.match(bodies[0], /terminal Feishu CLI login/);
  assert.equal(JSON.stringify(result).includes('device_code'), false);
});

test('waits for native login completion and returns the final result', async () => {
  const url = 'https://open.feishu.cn/verify?user_code=ABC';
  const { adapter, bodies, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl(url);
        return { ok: true };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.ok, true);
  assert.equal(state.connectCalls.length, 1);
  assert.equal(state.connectCalls[0].mode, 'login');
  assert.ok(bodies[0].includes(url));
  assert.equal(JSON.stringify(result).includes(url), false);
  assert.equal(JSON.stringify(result).includes('device_code'), false);
});

test('returns the final login failure reason instead of leaving setup pending', async () => {
  const { adapter, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl('https://open.feishu.cn/verify?user_code=ABC');
        return { ok: false, reasonCode: 'NOT_AUTHORIZED', message: 'Authorization failed.' };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, 'NOT_AUTHORIZED');
  assert.equal(state.connectCalls.length, 1);
});

test('rejects unsafe verification URLs before showing a card', async () => {
  const { adapter, bodies, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl('https://example.com/verify?device_code=fixture-secret');
        return { ok: true };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.reasonCode, 'SETUP_UNAVAILABLE');
  assert.equal(bodies.length, 0);
});

test('rejects off-origin verification URLs with a clean query before showing a card', async () => {
  const { adapter, bodies, state } = setup({
    port: fakePort({
      connect: async input => {
        state.connectCalls.push(input);
        await input.onAuthorizationUrl('https://attacker.example/verify?user_code=ABC');
        return { ok: true };
      },
    }),
  });
  const result = await adapter({});
  assert.equal(result.reasonCode, 'SETUP_UNAVAILABLE');
  assert.equal(bodies.length, 0);
});

test('aborts setup when the owner changes during confirmation', async () => {
  const { adapter, state } = setup({
    confirmations: {
      confirm: async () => { state.owner = 'owner-b:2'; return true; },
    },
    port: fakePort({
      readAuth: async () => ({ state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_REQUIRED' }),
      connect: async input => { state.connectCalls.push(input); return { ok: true }; },
    }),
  });
  const result = await adapter({});
  assert.equal(result.reasonCode, 'SETUP_UNAVAILABLE');
  assert.equal(state.connectCalls.length, 0);
});
