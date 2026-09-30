import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateGhostManifest } from '../../../shared/ghost.js';
import { GhostSetupChangeBus } from '../ghostSetupChangeBus.js';
import { GhostSetupCoordinator, type GhostSetupInlineActionInput } from '../ghostSetupCoordinator.js';
import { GhostSetupInteractionBridge } from '../ghostSetupInteractionBridge.js';
import { executeGhostSetupInlineSubmission } from '../ghostSetupInlineExecutor.js';
import { evaluateGhostSetupAssessment } from '../ghostSetupStatus.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

function harness(options: { saved?: boolean; hold?: boolean; fail?: boolean } = {}) {
  const parsed = validateGhostManifest({
    schemaVersion: 2, id: 'demo', name: 'Demo', version: '1.0.0',
    entry: 'main.js', settingsHtml: 'settings.html', slots: ['tool', 'network'],
    tools: [{ name: 'check', description: 'Check' }],
    network: { hosts: ['service.example.test'], secrets: [
      { key: 'api_key', label: 'API Key', source: 'user',
        inject: { header: 'Authorization', format: 'Bearer {value}' } },
    ] },
  });
  if (!parsed.ok) throw new Error('Invalid test manifest');
  let manifest = parsed.manifest;
  const values = new Map(options.saved ? [['api_key', 'synthetic-old']] : []);
  const changes = new GhostSetupChangeBus();
  const broadcast = vi.fn();
  const bridge = new GhostSetupInteractionBridge({ broadcast });
  const assess = () => evaluateGhostSetupAssessment(manifest, {
    secretSaved: key => values.has(key),
    oauthStatus: () => ({ clientConfigured: false, connected: 0, expired: 0 }),
    connectionCount: () => 0, kvValue: () => undefined,
  }, { revision: changes.currentRevision('demo') });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fail = options.fail ?? false, available = true;
  let submitted: GhostSetupInlineActionInput | undefined;
  const storeSecret = vi.fn((_ghost: string, key: string, value: string) => {
    if (fail) return false;
    values.set(key, value);
    return true;
  });
  const execute = (args: GhostSetupInlineActionInput) => executeGhostSetupInlineSubmission({
    getAssessment: assess, getManifest: () => manifest, storeSecret,
    emitChange: () => changes.emit('demo', { source: 'secret', ref: 'api_key' }),
  }, args);
  const coordinator = new GhostSetupCoordinator({
    bridge, changeBus: changes, assess,
    validateTarget: () => available ? { ok: true } :
      { ok: false, errorCode: 'GHOST_DISABLED_IN_WORKDIR', message: 'Unavailable' },
    getGhostIdentity: () => ({ id: 'demo', name: 'Demo' }),
    executeAction: async () => ({ ok: false, errorCode: 'ACTION_STALE' }),
    executeInlineAction: async args => {
      submitted = args;
      if (options.hold) await gate;
      return execute(args);
    },
    terminalGraceMs: 0,
  });
  const abort = new AbortController();
  cleanups.push(() => { abort.abort(); release(); });
  const start = (reauthorize = true) => coordinator.ensureReady({
    sessionId: 'task', ghostId: 'demo', workingDir: '/fixture',
    reauthorize, signal: abort.signal,
  });
  const card = () => bridge.pendingSnapshots()[0].request;
  const submit = (overrides: Record<string, unknown> = {}) => bridge.submitInline(card().requestId, {
    actionId: card().steps[0].action!.id, expectedRevision: card().revision,
    value: 'synthetic-new', ...overrides,
  });
  return { start, card, submit, bridge, values, storeSecret, changes, execute,
    submitted: () => submitted, broadcast, abort, release,
    fail: (value: boolean) => { fail = value; },
    disable: () => { available = false; },
    changeDeclaration: () => { manifest = { ...manifest, network: { ...manifest.network!, secrets: [] } }; },
  };
}

describe('saved user Secret reconfiguration', () => {
  it.each([false, true])('stores the current card once (previous value: %s)', async saved => {
    const h = harness({ saved });
    const ready = h.start();
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const original = h.card();
    // Even a settings event for this key is not this card's commit receipt.
    h.changes.emit('demo', { source: 'secret', ref: 'api_key' });
    await vi.waitFor(() => expect(h.card().revision).toBeGreaterThan(original.revision));
    expect(h.values.get('api_key')).toBe(saved ? 'synthetic-old' : undefined);
    h.submit();
    await expect(ready).resolves.toMatchObject({ ok: true });
    expect(h.values.get('api_key')).toBe('synthetic-new');
    expect(h.storeSecret).toHaveBeenCalledTimes(1);
    expect(h.bridge.submitInline(original.requestId, {
      actionId: original.steps[0].action!.id, expectedRevision: original.revision, value: 'replay',
    })).toBe(false);
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain('synthetic-');
  });

  it('keeps ordinary ready checks noninteractive', async () => {
    const h = harness({ saved: true });
    await expect(h.start(false)).resolves.toMatchObject({ ok: true });
    expect(h.bridge.pendingSnapshots()).toHaveLength(0);
    expect(h.storeSecret).not.toHaveBeenCalled();
  });

  it('retains the previous value on failure and accepts a retry on the new revision', async () => {
    const h = harness({ saved: true, fail: true });
    const ready = h.start();
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    h.submit();
    await vi.waitFor(() => expect(h.card().steps[0].errorCode).toBe('SAVE_FAILED'));
    expect(h.values.get('api_key')).toBe('synthetic-old');
    h.fail(false);
    h.submit();
    await expect(ready).resolves.toMatchObject({ ok: true });
    expect(h.values.get('api_key')).toBe('synthetic-new');
  });

  it.each(['cancel', 'workdir', 'declaration'] as const)('rejects a delayed local write after %s', async reason => {
    const h = harness({ saved: true, hold: true });
    const ready = h.start();
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    h.submit();
    await vi.waitFor(() => expect(h.submitted()).toBeDefined());
    if (reason === 'cancel') h.abort.abort();
    if (reason === 'workdir') h.disable();
    if (reason === 'declaration') h.changeDeclaration();
    h.release();
    if (reason === 'cancel') await expect(ready).resolves.toMatchObject({ errorCode: 'SETUP_CANCELLED' });
    else await vi.waitFor(() => expect(h.card().steps[0].phase).toBe('failed'));
    expect(h.values.get('api_key')).toBe('synthetic-old');
    expect(h.storeSecret).not.toHaveBeenCalled();
  });

  it('rejects stale revisions, another action and reuse of the Main-only commit capability', async () => {
    const h = harness({ saved: true, hold: true });
    const ready = h.start();
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    h.submit({ expectedRevision: -1 });
    h.submit({ actionId: 'inline_form:another-key' });
    await vi.waitFor(() => expect(h.card().steps[0].phase).toBe('pending'));
    expect(h.submitted()).toBeUndefined();
    h.submit();
    await vi.waitFor(() => expect(h.submitted()).toBeDefined());
    const args = h.submitted()!;
    expect(() => h.execute({ ...args, ghostId: 'another-plugin' })).toThrow('PLUGIN_SETUP_INLINE_STALE');
    expect(() => args.commit!.assertCurrent('demo', args.action.id, 'secret:another-key')).toThrow();
    expect(h.storeSecret).not.toHaveBeenCalled();
    h.release();
    await expect(ready).resolves.toMatchObject({ ok: true });
    expect(() => h.execute(args)).toThrow('PLUGIN_SETUP_INLINE_STALE');
    expect(h.storeSecret).toHaveBeenCalledTimes(1);
  });
});
