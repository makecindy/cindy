import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GhostManifest } from '../../../shared/ghost.js';
import { GhostSetupChangeBus } from '../ghostSetupChangeBus.js';
import { GhostSetupInteractionBridge } from '../ghostSetupInteractionBridge.js';
import { requestNodeSecretSetup } from '../nodeSecretSetup.js';

const aborts: AbortController[] = [];
afterEach(() => {
  aborts.splice(0).forEach((controller) => controller.abort());
});

function harness(force = false, saved?: string) {
  const values = new Map<string, string>(saved ? [['manual_token', saved]] : []);
  const broadcast = vi.fn();
  const bridge = new GhostSetupInteractionBridge({ broadcast });
  const changeBus = new GhostSetupChangeBus();
  const abort = new AbortController();
  aborts.push(abort);
  let current = true;
  const manifest: GhostManifest = {
    schemaVersion: 3,
    kind: 'chip',
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    entry: 'main.js',
    settingsHtml: 'settings.html',
    setup: { requires: [] },
    node: {
      entry: 'node/main.cjs',
      entries: ['node/account.cjs'],
      protocol: 'json-rpc-stdio',
      secretBindings: [
        {
          key: 'manual_token',
          label: 'Manual Token',
          entry: 'node/account.cjs',
          methods: ['account/import'],
          hint: 'Create a Token on the website, then fill this protected field.',
          url: 'https://accounts.example.com/tokens',
        },
        { key: 'unrelated', label: 'Other key', methods: ['other/action'] },
      ],
    },
  };
  const store = vi.fn((_: string, key: string, value: string) => {
    values.set(key, value);
    return true;
  });
  const deps = {
    bridge,
    changeBus,
    getManifest: () => manifest,
    secretSaved: (_: string, key: string) => values.has(key),
    storeSecret: store,
  };
  const input = {
    ghostId: 'demo',
    entry: 'node/account.cjs',
    method: 'account/import',
    sessionId: 'task',
    signal: abort.signal,
    force,
    assertCurrent: () => {
      if (!current) throw new Error('STALE');
    },
  };
  const start = () => requestNodeSecretSetup(deps, input);
  const pending = async () => {
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));
    return bridge.pendingSnapshots()[0].request;
  };
  const submit = async (value: string) => {
    const p = await pending();
    return bridge.submitInline(p.requestId, {
      expectedRevision: p.revision,
      actionId: p.steps[0].action!.id,
      value,
    });
  };
  return {
    values,
    bridge,
    broadcast,
    changeBus,
    abort,
    store,
    manifest,
    input,
    start,
    pending,
    submit,
    invalidate: () => {
      current = false;
    },
  };
}

describe('on-demand Node credential card', () => {
  it('uses the exact method/entry declaration while keeping ordinary setup and history unchanged', async () => {
    const h = harness();
    const waiting = h.start();
    const p = await h.pending();
    expect(p.remoteSecret).toBe(true);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].action).toMatchObject({
      kind: 'inline_form',
      form: {
        fields: [
          {
            type: 'secret',
            label: 'Manual Token',
            externalLink: { url: 'https://accounts.example.com/tokens' },
          },
        ],
      },
    });
    await h.submit('synthetic-private-token');
    await expect(waiting).resolves.toBe(true);
    expect(h.store).toHaveBeenCalledWith('demo', 'manual_token', 'synthetic-private-token');
    expect(h.manifest.setup).toEqual({ requires: [] });
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain('synthetic-private-token');
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain('unrelated');
  });

  it('reuses a saved credential without a card unless replacement is explicit', async () => {
    const h = harness(false, 'existing-secret');
    await expect(h.start()).resolves.toBe(true);
    expect(h.bridge.pendingSnapshots()).toHaveLength(0);
    expect(h.store).not.toHaveBeenCalled();
  });

  it('can replace a saved value, including submitting the same value again', async () => {
    const h = harness(true, 'existing-secret');
    const waiting = h.start();
    await h.submit('existing-secret');
    await expect(waiting).resolves.toBe(true);
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain('existing-secret');
  });

  it('cancels without clearing the previous value or committing a late input', async () => {
    const h = harness(true, 'old-secret');
    const waiting = h.start();
    const p = await h.pending();
    h.abort.abort();
    await expect(waiting).resolves.toBe(false);
    expect(
      h.bridge.submitInline(p.requestId, {
        expectedRevision: p.revision,
        actionId: p.steps[0].action!.id,
        value: 'late-secret',
      }),
    ).toBe(false);
    expect(h.values.get('manual_token')).toBe('old-secret');
    expect(h.store).not.toHaveBeenCalled();
  });

  it('rejects another call owner at commit time', async () => {
    const h = harness();
    const waiting = h.start();
    await h.pending();
    h.invalidate();
    await h.submit('must-not-be-written');
    await expect(waiting).resolves.toBe(false);
    expect(h.store).not.toHaveBeenCalled();
  });

  it('rejects an action after its declaration changes instead of writing a different key', async () => {
    const h = harness();
    const waiting = h.start();
    const p = await h.pending();
    h.manifest.node!.secretBindings![0].key = 'replacement';
    h.bridge.submitInline(p.requestId, {
      expectedRevision: p.revision,
      actionId: p.steps[0].action!.id,
      value: 'rejected-secret',
    });
    await vi.waitFor(() =>
      expect(h.bridge.pendingSnapshots()[0].request.steps[0].phase).toBe('failed'),
    );
    expect(h.store).not.toHaveBeenCalled();
    h.abort.abort();
    await waiting;
  });

  it.each(['other/action', 'initialize'])(
    'does not request a key for unbound method %s',
    async (method) => {
      const h = harness();
      h.input.method = method;
      await expect(h.start()).resolves.toBe(false);
      expect(h.bridge.pendingSnapshots()).toHaveLength(0);
      expect(h.store).not.toHaveBeenCalled();
    },
  );

  it('leaves a failed write retryable and retains the previous credential', async () => {
    const h = harness(true, 'old-secret');
    h.store.mockImplementationOnce(() => false);
    const waiting = h.start();
    await h.submit('new-secret');
    await vi.waitFor(() =>
      expect(h.bridge.pendingSnapshots()[0].request.steps[0].phase).toBe('failed'),
    );
    expect(h.values.get('manual_token')).toBe('old-secret');
    await h.submit('new-secret');
    await expect(waiting).resolves.toBe(true);
    expect(h.values.get('manual_token')).toBe('new-secret');
  });
});
