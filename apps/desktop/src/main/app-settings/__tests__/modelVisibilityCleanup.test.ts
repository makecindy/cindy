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

  // Codex P2: media models live in provider.imageModels / videoModels, not in
  // models[agent]. They are still catalog entries: treating them as orphans handed
  // defaultEnabled: undefined to the receipt, which then reported the wrong visibility.
  it('uses the real default of a media model that is not listed per agent', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'relay', models: { pi: [] },
        imageModels: [{ id: 'openai/old-image', name: 'Old Image', defaultEnabled: false }] }],
        modelVisibilityOverrides: {} }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);
    manageAppPreferences.mockResolvedValue({ modelVisibility: { visible: false, customized: false } });

    await manageAppModels({ operation: 'set',
      target: { providerId: 'relay', agent: 'pi', modelId: 'openai/old-image' },
      change: { setting: 'visible', value: null } }, async () => {});

    expect(manageAppPreferences).toHaveBeenCalledWith('model-visibility', undefined,
      { target: { providerId: 'relay', agent: 'pi', modelId: 'openai/old-image' }, visible: null, defaultEnabled: false });
  });

  // Codex P1: a media model is in its own catalog, not in the chat selector. An explicit
  // on/off there would persist an override that filters the executable media catalog while
  // the receipt talks about the selector — the fallback is for cleanup only.
  it('keeps refusing explicit on/off for a media-only model', async () => {
    configureModelSettingsActions({
      owner: () => ({ dataOwnerId: 'owner', ownerGeneration: 1 }),
      list: async () => ({ providers: [{ id: 'relay', models: { pi: [] },
        imageModels: [{ id: 'openai/old-image', name: 'Old Image', defaultEnabled: false }] }],
        modelVisibilityOverrides: {} }),
    } as unknown as Parameters<typeof configureModelSettingsActions>[0]);

    await expect(manageAppModels({ operation: 'set',
      target: { providerId: 'relay', agent: 'pi', modelId: 'openai/old-image' },
      change: { setting: 'visible', value: false } }, async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
  });

  it('keeps refusing an explicit on/off choice for a model outside the catalog', async () => {
    await expect(manageAppModels({ operation: 'set', target: orphan, change: { setting: 'visible', value: true } },
      async () => {})).rejects.toThrow('MODEL_NOT_IN_CATALOG');
    expect(manageAppPreferences).not.toHaveBeenCalled();
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
