import { describe, expect, it } from 'vitest';
import { parseModelsListResponse } from '../modelDiscovery.js';
import { mergeDiscoveredRuntimeModels } from '../modelMetadataLayers.js';
import { modelSupplierLabel, validDiscoveredModelSource } from '../modelSource.js';
import { buildUserProvider } from '../user-provider.js';
import { unifiedModelEntries, resolveStoredModelEntry } from '../unifiedSelection.js';

const response = (id: string, source: string, label = `Model · ${source}`) => ({
  id, display_name: 'Model', owned_by: source, magpie_label: label,
});

describe('connection-owned Magpie model sources', () => {
  it('ignores generic OpenAI owned_by and rejects invalid display fields without losing the model', () => {
    const models = parseModelsListResponse({ data: [
      { id: 'generic', owned_by: 'openai' },
      { ...response('invalid', 'A'), magpie_label: '<tag>\ninvalid' },
    ] })!;
    expect(models).toHaveLength(2);
    expect(models.every(model => model.discoveredSource === undefined)).toBe(true);
    expect(validDiscoveredModelSource({ kind: 'magpie', providerId: 'A', label: 3 })).toBe(false);
  });

  it('keeps the full label suffix and falls back to the source ID for free-form labels', () => {
    const models = parseModelsListResponse({ data: [response('a/foo', 'a', 'Model · A · Team'), response('b/foo', 'b', 'renamed')] })!;
    expect(models.map(m => modelSupplierLabel(m.discoveredSource))).toEqual(['A · Team', 'b']);
    expect(modelSupplierLabel(undefined)).toBeUndefined();
  });

  it('replaces successful source snapshots, clears missing fields and retains explicit names', () => {
    const discovered = parseModelsListResponse({ data: [response('a/foo', 'a')] })!;
    const saved = mergeDiscoveredRuntimeModels([], discovered);
    const renamed = [{ ...saved[0], name: 'My model', nameExplicit: true }];
    const updated = mergeDiscoveredRuntimeModels(renamed, parseModelsListResponse({ data: [response('a/foo', 'b')] })!);
    expect(updated[0].name).toBe('My model');
    expect(updated[0].discoveredSource?.providerId).toBe('b');
    const cleared = mergeDiscoveredRuntimeModels(updated, [{ id: 'a/foo', name: 'Model' }])[0].discoveredSource;
    expect(cleared).toBeUndefined();
    expect(modelSupplierLabel(cleared)).toBeUndefined();
    expect(JSON.parse(JSON.stringify(saved))[0].discoveredSource).toEqual(discovered[0].discoveredSource);
  });

  it.each([['chatgpt/foo', 'foo'], ['xai/foo', 'foo']])('preserves %s and %s through discovery, saved config and the final per-engine rows', (a, b) => {
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [response(a, 'A'), response(b, 'B')] })!);
    const provider = buildUserProvider({ id: 'magpie-test', name: 'Magpie', runtimes: {
      'claude-code': { baseUrl: 'http://127.0.0.1:3425/v1', models },
      codex: { baseUrl: 'http://127.0.0.1:3425/v1', models },
      pi: { baseUrl: 'http://127.0.0.1:3425/v1', models },
    } });
    const entries = unifiedModelEntries({ providers: [{ ...provider, connected: true }] });
    expect(entries.map(e => e.modelId)).toEqual([a, b]);
    expect(entries.every(entry => entry.legacyEnginePreferenceId === undefined)).toBe(true);
    expect(new Set(entries.map(entry => entry.enginePreferenceId)).size).toBe(2);
    // #8485 unit: shared shortcut restoration must use full-catalog ambiguity,
    // even when visibility hides the prefixed sibling. Never mutate old records.
    expect(resolveStoredModelEntry(entries, provider.id, 'foo')).toBeUndefined();
    expect(resolveStoredModelEntry([entries[1]], provider.id, 'foo')).toBeUndefined();
    expect(resolveStoredModelEntry(entries, provider.id, a)).toBe(entries[0]);
    for (const entry of entries) {
      expect(resolveStoredModelEntry(entries, provider.id, entry.enginePreferenceId!)).toBe(entry);
    }
    for (const entry of entries) for (const agent of entry.candidates) {
      expect(entry.capabilities[agent]?.wireModelId).toBe(entry.modelId);
      expect(entry.capabilities[agent]?.discoveredSource?.providerId).toBe(entry.modelId === a ? 'A' : 'B');
    }
  });

  it('keeps an unambiguous old engine preference address without renaming the wire ID', () => {
    const models = mergeDiscoveredRuntimeModels([], parseModelsListResponse({ data: [response('chatgpt/foo', 'A')] })!);
    const provider = { ...buildUserProvider({ id: 'unique', name: 'Gateway', runtimes: {
      codex: { baseUrl: 'http://127.0.0.1:3425/v1', models },
    } }), connected: true };
    const entries = unifiedModelEntries({ providers: [provider] });
    expect(resolveStoredModelEntry(entries, provider.id, 'foo')).toBe(entries[0]);
    expect(entries[0]).toMatchObject({
      modelId: 'chatgpt/foo', enginePreferenceId: '["magpie-route","chatgpt/foo"]',
      legacyEnginePreferenceId: 'foo',
    });
  });
});
