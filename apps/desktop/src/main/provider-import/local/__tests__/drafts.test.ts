import { afterEach, describe, expect, it } from 'vitest';
import { validateCustomProviderConfig } from '../../../maker-host/custom-provider-store.js';
import {
  beginProviderImportConfirm,
  cancelProviderImport,
  checkLocalProviderImportSource,
  clearProviderImportDraftsForTest,
  createLocalProviderImport,
  editLocalProviderImport,
  equivalentLocalProvider,
  finishProviderImportConfirm,
  localProviderImportDraft,
  localProviderImportItem,
  previewProviderImport,
} from '../../providerImport.js';
import type { LocalSourceEntry } from '../sources.js';

const owner = { dataOwnerId: 'fake-owner', generation: 1 };
const entry = (): LocalSourceEntry => ({
  ref: 'one',
  name: 'Relay',
  endpoints: [
    {
      agent: 'claude-code',
      protocol: 'anthropic-messages',
      baseUrl: 'https://relay.test/prefix',
      apiKey: 'FAKE-LOCAL-KEY',
      headers: { 'X-Tenant': 'FAKE-TENANT' },
      models: [],
    },
  ],
});
const register = (value = entry(), reload = async () => value) =>
  createLocalProviderImport('claude-code', value, owner, reload);
afterEach(clearProviderImportDraftsForTest);

describe('local sources use the existing secret draft lifecycle', () => {
  it('redacts secrets, preserves only the configured engine, and produces a valid ordinary config', () => {
    const item = register();
    const view = previewProviderImport(item.importId, owner, []);
    expect(view.runtimes).toMatchObject([
      { agent: 'claude-code', baseUrl: 'https://relay.test/prefix', headerNames: ['X-Tenant'] },
    ]);
    expect(JSON.stringify([item, view])).not.toContain('FAKE-LOCAL-KEY');
    expect(JSON.stringify([item, view])).not.toContain('FAKE-TENANT');
    const { draft } = beginProviderImportConfirm(item.importId, owner, []);
    if (draft.kind !== 'custom') throw new Error('expected custom');
    expect(validateCustomProviderConfig(draft.config)).toMatchObject({ ok: true });
    expect(Object.keys(draft.config.runtimes)).toEqual(['claude-code']);
  });
  it('binds owner at scan time, before any preview', () => {
    const item = register();
    expect(() => previewProviderImport(item.importId, { ...owner, generation: 2 }, [])).toThrow(
      /account/,
    );
    expect(() =>
      editLocalProviderImport(item.importId, {}, { ...owner, dataOwnerId: 'other' }),
    ).toThrow(/owner/);
  });
  it('detects source changes before using the snapshot and invalidates its preview', async () => {
    let current = entry();
    const item = register(current, async () => current);
    previewProviderImport(item.importId, owner, []);
    current = { ...current, endpoints: [{ ...current.endpoints[0], apiKey: 'FAKE-NEW' }] };
    await expect(checkLocalProviderImportSource(item.importId, owner)).rejects.toThrow(/changed/);
    expect(localProviderImportItem(item.importId, owner).issue).toBe('changed');
    expect(() => beginProviderImportConfirm(item.importId, owner, [])).toThrow(/preview/);
  });
  it('keeps unreadable/incomplete candidates editable without revealing invalid URL credentials', () => {
    const value = entry();
    value.endpoints[0].baseUrl = 'https://user:FAKE-PASSWORD@relay.test/?key=FAKE-QUERY';
    const item = register(value);
    expect(item.issue).toBe('invalid');
    expect(item.endpoints[0].baseUrl).toBe('');
    expect(JSON.stringify(item)).not.toContain('FAKE');
  });
  it('changing a destination clears both the key and all custom headers; new key restores readiness', () => {
    const item = register();
    const update = {
      name: 'Relay',
      endpoints: [{ baseUrl: 'https://another.test', protocol: 'anthropic-messages' }],
    };
    expect(editLocalProviderImport(item.importId, update, owner).issue).toBe('needsInput');
    expect(() => previewProviderImport(item.importId, owner, [])).toThrow(/requires input/);
    const next = editLocalProviderImport(
      item.importId,
      { ...update, endpoints: [{ ...update.endpoints[0], apiKey: 'FAKE-REPLACEMENT' }] },
      owner,
    );
    expect(next.issue).toBeUndefined();
    const draft = localProviderImportDraft(item.importId, owner);
    if (draft.kind !== 'custom') throw new Error('expected custom');
    expect(draft.keys['claude-code']).toBe('FAKE-REPLACEMENT');
    expect(draft.config.runtimes['claude-code']?.headers).toBeUndefined();
  });
  it('renaming keeps credentials but invalidates the old review; replacing a key keeps non-auth headers', () => {
    const item = register();
    previewProviderImport(item.importId, owner, []);
    editLocalProviderImport(
      item.importId,
      {
        name: 'Renamed',
        endpoints: [
          {
            baseUrl: 'https://relay.test/prefix',
            protocol: 'anthropic-messages',
            apiKey: 'FAKE-REPLACEMENT',
          },
        ],
      },
      owner,
    );
    expect(() => beginProviderImportConfirm(item.importId, owner, [])).toThrow(/preview/);
    const draft = localProviderImportDraft(item.importId, owner);
    if (draft.kind !== 'custom') throw new Error('expected custom');
    expect(draft.keys['claude-code']).toBe('FAKE-REPLACEMENT');
    expect(draft.config.runtimes['claude-code']?.headers).toEqual({ 'X-Tenant': 'FAKE-TENANT' });
  });
  it('editing cannot inject file paths, extra endpoints or arbitrary config fields', () => {
    const item = register();
    expect(() =>
      editLocalProviderImport(
        item.importId,
        { name: 'x', endpoints: [], path: '/fake/file' },
        owner,
      ),
    ).toThrow();
    expect(() =>
      editLocalProviderImport(item.importId, { name: 'x', endpoints: [] }, owner),
    ).toThrow();
  });
  it('replacing a Claude bearer token preserves its authentication scheme', () => {
    const value = entry();
    delete value.endpoints[0].apiKey;
    value.endpoints[0].headers = {
      Authorization: 'Bearer FAKE-ORIGINAL',
      'X-Tenant': 'FAKE-TENANT',
    };
    const item = register(value);
    editLocalProviderImport(
      item.importId,
      {
        name: 'Relay',
        endpoints: [
          {
            baseUrl: 'https://relay.test/prefix',
            protocol: 'anthropic-messages',
            apiKey: 'FAKE-REPLACEMENT',
          },
        ],
      },
      owner,
    );
    const draft = localProviderImportDraft(item.importId, owner);
    if (draft.kind !== 'custom') throw new Error('expected custom');
    expect(draft.keys['claude-code']).toBeUndefined();
    expect(draft.config.runtimes['claude-code']?.headers).toEqual({
      Authorization: 'Bearer FAKE-REPLACEMENT',
      'X-Tenant': 'FAKE-TENANT',
    });
  });
  it('completed local imports keep only an idempotent receipt and release secrets', async () => {
    const item = register();
    const view = previewProviderImport(item.importId, owner, []);
    beginProviderImportConfirm(item.importId, owner, []);
    // Cancellation cannot erase an in-flight write.
    cancelProviderImport(item.importId);
    finishProviderImportConfirm(item.importId, true);
    await expect(checkLocalProviderImportSource(item.importId, owner)).resolves.toBe(
      view.providerId,
    );
    expect(localProviderImportItem(item.importId, owner).endpoints).toEqual([]);
    cancelProviderImport(item.importId);
    await expect(checkLocalProviderImportSource(item.importId, owner)).resolves.toBeUndefined();
  });
  it('does not equate different keys, paths, headers or explicit model selections', () => {
    const item = register();
    const draft = localProviderImportDraft(item.importId, owner);
    if (draft.kind !== 'custom') throw new Error('expected custom');
    expect(equivalentLocalProvider(draft, draft.config, draft.keys)).toBe(true);
    expect(equivalentLocalProvider(draft, draft.config, { 'claude-code': 'DIFFERENT' })).toBe(
      false,
    );
    for (const patch of [
      { baseUrl: 'https://relay.test/prefix/' },
      { headers: { 'X-Tenant': 'OTHER' } },
    ]) {
      const config = structuredClone(draft.config);
      Object.assign(config.runtimes['claude-code']!, patch);
      expect(equivalentLocalProvider(draft, config, draft.keys)).toBe(false);
    }
    const discovered = structuredClone(draft.config);
    discovered.runtimes['claude-code']!.models = [{ id: 'new', name: 'New' }];
    expect(equivalentLocalProvider(draft, discovered, draft.keys)).toBe(true);
    draft.config.runtimes['claude-code']!.models = [{ id: 'explicit', name: 'Explicit' }];
    expect(equivalentLocalProvider(draft, discovered, draft.keys)).toBe(false);
  });
});
