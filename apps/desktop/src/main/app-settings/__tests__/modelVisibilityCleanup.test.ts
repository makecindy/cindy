import { beforeEach, describe, expect, it, vi } from 'vitest';

const manageAppPreferences = vi.hoisted(() => vi.fn());
vi.mock('../preferences.js', () => ({ manageAppPreferences }));

import { configureModelSettingsActions, manageAppModels } from '../models.js';

// #12181: a provider that left the catalog keeps its per-model visibility
// overrides. value=null is documented as "delete the override and follow the
// default", so removing an orphan entry must not require re-adding the provider.
const orphan = { providerId: 'magpie-bac7deb4', agent: 'pi' as const, modelId: 'old-model' };
const live = { providerId: 'relay', agent: 'pi' as const, modelId: 'kept' };

describe('model visibility override cleanup', () => {
  beforeEach(() => {
    manageAppPreferences.mockReset();
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'relay', models: { pi: [{ id: 'kept', defaultEnabled: true }] } }],
        modelVisibilityOverrides: { 'pi:magpie-bac7deb4:old-model': false } }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);
  });

  it('removes an override whose provider is no longer in the catalog', async () => {
    manageAppPreferences.mockResolvedValue({ modelVisibility: { visible: true, customized: false } });

    const result = await manageAppModels({ operation: 'set', target: orphan, change: { setting: 'visible', value: null } },
      async () => {});

    expect(manageAppPreferences).toHaveBeenCalledWith('model-visibility', undefined,
      { target: orphan, visible: null, defaultEnabled: undefined });
    expect(result).toMatchObject({ setting: 'visible', result: { customized: false } });
  });

  // Codex P2: a reset for a key that was never in the catalog or in the overrides is not a
  // no-op — the renderer records it in followCatalogKeys and nothing removes it again, so a
  // mistyped target would pile up permanently. Only a stored orphan override may be cleared.
  it('refuses to reset a key that has neither a catalog entry nor an override', async () => {
    const mistyped = { providerId: 'magpie-bac7deb4', agent: 'pi' as const, modelId: 'old-modle' };

    await expect(manageAppModels({ operation: 'set', target: mistyped, change: { setting: 'visible', value: null } },
      async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  // Codex P1: media entries are not in the chat selector and are read through their own
  // source agent. This tool only owns the selector switch, so it never edits them —
  // refusing beats reporting a reset that cleaned a key nobody reads.
  it('never edits a media-only model through the selector switch', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'relay', models: { pi: [], codex: [] },
        imageModels: [{ id: 'openai/old-image', name: 'Old Image', defaultEnabled: false, sourceAgent: 'codex' }] }],
        modelVisibilityOverrides: { 'codex:relay:openai/old-image': false } }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);

    for (const value of [null, false, true] as const) {
      await expect(manageAppModels({ operation: 'set',
        target: { providerId: 'relay', agent: 'codex', modelId: 'openai/old-image' },
        change: { setting: 'visible', value } }, async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    }
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  // Codex P1: the override map joins its parts with `:`, and provider/model ids may contain
  // `:` too (`custom:xai`). A stored `pi:custom:xai:foo` is also spelled by the different
  // target `(pi, custom, xai:foo)`, so "the key exists" cannot prove ownership.
  it('refuses an orphan key another catalog entry spells the same way', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'custom:xai', models: { pi: [{ id: 'foo', defaultEnabled: true }] } }],
        modelVisibilityOverrides: { 'pi:custom:xai:foo': false } }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);

    // (pi, custom, xai:foo) reads the same key but is not the model that owns it.
    await expect(manageAppModels({ operation: 'set',
      target: { providerId: 'custom', agent: 'pi', modelId: 'xai:foo' },
      change: { setting: 'visible', value: null } }, async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  it('keeps refusing an explicit on/off choice for a model outside the catalog', async () => {
    await expect(manageAppModels({ operation: 'set', target: orphan, change: { setting: 'visible', value: true } },
      async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  it('refuses an orphan key a media entry spells through its own source agent', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'custom:xai', agents: ['pi'], models: { pi: [] },
        imageModels: [{ id: 'foo', name: 'Foo Image', defaultEnabled: true, sourceAgent: 'pi' }] }],
        modelVisibilityOverrides: { 'pi:custom:xai:foo': false } }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);

    // (pi, custom, xai:foo) spells the media route's key but the selector switch never owns it.
    await expect(manageAppModels({ operation: 'set',
      target: { providerId: 'custom', agent: 'pi', modelId: 'xai:foo' },
      change: { setting: 'visible', value: null } }, async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  it('refuses an orphan key the mirror projection spells under the first agent', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'custom:xai', agents: ['codex', 'pi'], models: { codex: [], pi: [] },
        imageModels: [{ id: 'foo', name: 'Foo Image', defaultEnabled: true, sourceAgent: 'pi' }] }],
        modelVisibilityOverrides: { 'codex:custom:xai:foo': false } }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);

    // The legacy snapshot projects media under the first agent (codex), so that key belongs
    // to the media route even though the viewer reads it through `pi`.
    await expect(manageAppModels({ operation: 'set',
      target: { providerId: 'custom', agent: 'codex', modelId: 'xai:foo' },
      change: { setting: 'visible', value: null } }, async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  it('still clears an orphan key no media entry spells', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'custom:xai', agents: ['pi'], models: { pi: [] },
        imageModels: [{ id: 'bar', name: 'Bar Image', defaultEnabled: true, sourceAgent: 'pi' }] }],
        modelVisibilityOverrides: { 'pi:custom:xai:foo': false } }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);
    manageAppPreferences.mockResolvedValue({ modelVisibility: { visible: true, customized: false } });

    const target = { providerId: 'custom', agent: 'pi' as const, modelId: 'xai:foo' };
    await expect(manageAppModels({ operation: 'set', target,
      change: { setting: 'visible', value: null } }, async () => {})).resolves.toMatchObject({ setting: 'visible' });
    expect(manageAppPreferences).toHaveBeenCalledWith('model-visibility', undefined,
      { target, visible: null, defaultEnabled: undefined });
  });

  it('reports failure when the override survives the reset', async () => {
    manageAppPreferences.mockResolvedValue({ modelVisibility: { visible: false, customized: true } });

    await expect(manageAppModels({ operation: 'set', target: orphan, change: { setting: 'visible', value: null } },
      async () => {})).rejects.toThrow('MODEL_VISIBILITY_NOT_CONFIRMED');
  });

  it('still applies and confirms an explicit choice for a catalog model', async () => {
    manageAppPreferences.mockResolvedValue({ modelVisibility: { visible: false, customized: true } });

    const result = await manageAppModels({ operation: 'set', target: live, change: { setting: 'visible', value: false } },
      async () => {});

    expect(manageAppPreferences).toHaveBeenCalledWith('model-visibility', undefined,
      { target: live, visible: false, defaultEnabled: true });
    expect(result).toMatchObject({ result: { visible: false, customized: true } });
  });
});
