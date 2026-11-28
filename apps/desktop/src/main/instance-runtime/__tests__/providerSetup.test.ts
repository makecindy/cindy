// Unit: staged cloud provider setup. Secrets only arrive with the ticket, every stage runs once
// for its owner, and each kind reaches the exact native handler.
import { describe, expect, it, vi } from 'vitest';
import { createProviderSetup, hasRuntimeHeaders } from '../providerSetup';
import type { ManagementExecution } from '../../host-settings/management';

const OWNER = 'owner-1:7';
const execution: ManagementExecution = {
  signal: new AbortController().signal,
  assertCurrent: () => undefined,
  prompt: () => undefined,
  onCancel: () => undefined,
};

function setup(result: unknown = { ok: true }) {
  const call = vi.fn(async (channel: string) =>
    channel === 'builtin-api-key-has' ? true : result,
  );
  return { call, setup: createProviderSetup(call) };
}

describe('cloud provider setup stages', () => {
  it('stages only secret-free requests', () => {
    const h = setup();
    expect(() =>
      h.setup.stage(OWNER, 'models-fetch', { baseUrl: 'https://x.test', apiKey: 'typed' }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      h.setup.stage(OWNER, 'detect', { baseUrl: 'https://x.test', headers: { a: 'b' } }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      h.setup.stage(OWNER, 'custom-create', {
        config: { runtimes: { codex: { baseUrl: 'https://x.test', headers: { a: 'b' } } } },
      }),
    ).toThrow('[INVALID_PARAMS]');
    expect(hasRuntimeHeaders({ runtimes: { codex: { headers: {} } } })).toBe(false);
  });

  it('applies a probe with the ticket key and returns its result once', async () => {
    const h = setup({ ok: true, models: [{ id: 'm' }] });
    const id = h.setup.stage(OWNER, 'models-fetch', {
      agent: 'codex',
      baseUrl: 'https://x.test/v1',
      authMethod: 'apiKey',
    });
    expect(h.setup.result(OWNER, id)).toEqual({ status: 'pending' });
    await h.setup.apply(OWNER, id, JSON.stringify({ apiKey: 'typed-key' }), execution);
    expect(h.call).toHaveBeenCalledWith(
      'maker:provider:models-fetch',
      [{ agent: 'codex', baseUrl: 'https://x.test/v1', authMethod: 'apiKey', apiKey: 'typed-key' }],
      execution,
    );
    expect(h.setup.result(OWNER, id)).toEqual({
      status: 'done',
      value: { ok: true, models: [{ id: 'm' }] },
    });
    expect(() => h.setup.result(OWNER, id)).toThrow('[NOT_FOUND]');
  });

  it('binds a stage to its owner and runs it at most once', async () => {
    const h = setup();
    const id = h.setup.stage(OWNER, 'oauth-login', { providerId: 'web-1' });
    await expect(h.setup.apply('other:1', id, undefined, execution)).rejects.toThrow('[NOT_FOUND]');
    expect(() => h.setup.result('other:1', id)).toThrow('[NOT_FOUND]');
    await h.setup.apply(OWNER, id, undefined, execution);
    await expect(h.setup.apply(OWNER, id, undefined, execution)).rejects.toThrow('[NOT_FOUND]');
    expect(h.call).toHaveBeenCalledWith('maker:provider:oauth:login', ['web-1'], execution);
  });

  it('puts keys and request headers back into a new connection on the instance', async () => {
    const h = setup();
    const id = h.setup.stage(OWNER, 'custom-create', {
      config: {
        id: 'web-1',
        name: 'Gateway',
        runtimes: { codex: { baseUrl: 'https://x.test/v1', models: [] } },
      },
      options: { source: 'manual-settings' },
    });
    await h.setup.apply(
      OWNER,
      id,
      JSON.stringify({ keys: { codex: 'k-1' }, runtimeHeaders: { codex: { 'X-Org': 'o-1' } } }),
      execution,
    );
    expect(h.call).toHaveBeenCalledWith(
      'maker:provider:custom:create',
      [
        {
          id: 'web-1',
          name: 'Gateway',
          runtimes: {
            codex: { baseUrl: 'https://x.test/v1', models: [], headers: { 'X-Org': 'o-1' } },
          },
        },
        { codex: 'k-1' },
        { source: 'manual-settings' },
      ],
      execution,
    );
  });

  it('rejects headers for an engine the connection does not have', async () => {
    const h = setup();
    const id = h.setup.stage(OWNER, 'custom-update', {
      config: { id: 'web-1', runtimes: { codex: { baseUrl: 'https://x.test', models: [] } } },
    });
    await expect(
      h.setup.apply(OWNER, id, JSON.stringify({ runtimeHeaders: { pi: { a: 'b' } } }), execution),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(h.setup.result(OWNER, id)).toEqual({ status: 'failed' });
  });

  it('stores a built-in key and confirms it was saved', async () => {
    const h = setup();
    const id = h.setup.stage(OWNER, 'builtin-key', { providerId: 'gemini' });
    await h.setup.apply(OWNER, id, JSON.stringify({ apiKey: ' g-key ' }), execution);
    expect(h.call).toHaveBeenCalledWith('builtin-api-key-store', ['gemini', 'g-key'], execution);
    expect(h.call).toHaveBeenCalledWith('builtin-api-key-has', ['gemini'], execution);
  });

  it("signs in the instance's own CLIs with a remote-friendly flow", async () => {
    const h = setup();
    for (const [agent, method] of [
      ['codex', undefined],
      ['claude', undefined],
      ['xai', 'device'],
    ] as const) {
      const id = h.setup.stage(OWNER, 'native-login', { agent, ...(method ? { method } : {}) });
      await h.setup.apply(OWNER, id, undefined, execution);
    }
    expect(h.call).toHaveBeenCalledWith(
      'maker:auth:trigger-login',
      ['codex', { mode: 'device-code' }],
      execution,
    );
    expect(h.call).toHaveBeenCalledWith('maker:claude-oauth:login', [], execution);
    expect(h.call).toHaveBeenCalledWith('maker:xai-oauth:login', ['device'], execution);
  });

  it('refuses malformed secrets', async () => {
    const h = setup();
    const id = h.setup.stage(OWNER, 'builtin-key', { providerId: 'gemini' });
    await expect(h.setup.apply(OWNER, id, '{not json', execution)).rejects.toThrow(
      '[INVALID_PARAMS]',
    );
  });
});
