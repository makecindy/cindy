import { describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import type { PluginTaskConfig } from '../pluginTaskPrefsStore.js';
import { MobileTaskSettings } from '../mobileTaskSettings.js';
const provider = {
  id: 'selected',
  source: 'user',
  connected: true,
  agents: ['codex'],
  routing: { codex: { enabled: true } },
  models: { codex: [{ id: 'model', mode: 'chat', efforts: ['medium'], supportsFastMode: true }] },
} as unknown as ProviderView;
const route = {
  agentKind: 'codex',
  providerId: 'selected',
  model: 'model',
  effort: 'medium',
  fastMode: true,
};
function setup(
  validate: (config: PluginTaskConfig) => Promise<void> = async () => {},
  pluginEngines: Parameters<typeof MobileTaskSettings['prototype']['read']> extends never ? never : Array<Record<string, unknown>> = [],
) {
  let config: PluginTaskConfig = {
    workingDir: '/private/selected-directory',
    permissionMode: 'plan',
  };
  const write = vi.fn((_id, value: PluginTaskConfig) => (config = value));
  const providers = vi.fn(async () => [provider]);
  const service = new MobileTaskSettings({
    read: () => config,
    write,
    validate,
    providers,
    agents: async () => ['codex'],
    pluginEngines: () => pluginEngines as never,
  });
  return {
    service,
    write,
    providers,
    change: () => {
      config = { ...config, permissionMode: 'auto' };
    },
    get: () => config,
  };
}
describe('native mobile task preferences', () => {
  // unit: the remote user settings use the same choices as the local picker;
  // saving full access keeps the Host-owned directory and returns the saved mode.
  it('offers the ordinary three modes and persists an explicit full-access choice', async () => {
    const h = setup(), before = h.service.read('plugin', 'installed-1');
    expect(before.permissionModes).toEqual(['ask', 'auto', 'bypassPermissions']);
    const result = await h.service.update('plugin', 'installed-1',
      { expectedRevision: before.revision, permissionMode: 'bypassPermissions' }, () => {});
    expect(result.config.permissionMode).toBe('bypassPermissions');
    expect(h.get().workingDir).toBe('/private/selected-directory');
  });
  it('never projects the private directory and pins complete validated configuration while preserving it', async () => {
    const h = setup(),
      before = h.service.read('plugin', 'installed-1');
    expect(JSON.stringify(before)).not.toContain('/private');
    expect(before.defaultPermissionMode).toBe('ask');
    const result = await h.service.update(
      'plugin',
      'installed-1',
      { expectedRevision: before.revision, model: route },
      () => {},
    );
    expect(result.config).toEqual({ ...route, permissionMode: 'plan' });
    expect(h.get().workingDir).toBe('/private/selected-directory');
    const reset = await h.service.update(
      'plugin',
      'installed-1',
      { expectedRevision: result.revision, model: null },
      () => {},
    );
    expect(reset.config).toEqual({ permissionMode: 'plan' });
    expect(h.get().workingDir).toBe('/private/selected-directory');
  });
  it('rejects competing settings and changed installation before persistence', async () => {
    const h = setup(),
      before = h.service.read('plugin', 'installed-1');
    h.providers.mockImplementationOnce(async () => {
      h.change();
      return [provider];
    });
    await expect(
      h.service.update(
        'plugin',
        'installed-1',
        { expectedRevision: before.revision, model: route },
        () => {},
      ),
    ).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
    await expect(
      h.service.update(
        'plugin',
        'installed-2',
        { expectedRevision: before.revision, model: route },
        () => {},
      ),
    ).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
    expect(h.write).not.toHaveBeenCalled();
  });
  it('rejects disconnected routes, invalid tuning and stale authority; never silently chooses a substitute', async () => {
    const h = setup(),
      before = h.service.read('plugin', 'installed-1');
    h.providers.mockResolvedValueOnce([{ ...provider, connected: false }]);
    await expect(
      h.service.update(
        'plugin',
        'installed-1',
        { expectedRevision: before.revision, model: route },
        () => {},
      ),
    ).rejects.toThrow('PLUGIN_MODEL_UNAVAILABLE');
    await expect(
      h.service.update(
        'plugin',
        'installed-1',
        { expectedRevision: before.revision, model: { ...route, effort: 'high' } },
        () => {},
      ),
    ).rejects.toThrow('PLUGIN_MODEL_UNAVAILABLE');
    let current = true;
    h.providers.mockImplementationOnce(async () => {
      current = false;
      return [provider];
    });
    await expect(
      h.service.update(
        'plugin',
        'installed-1',
        { expectedRevision: before.revision, model: route },
        () => {
          if (!current) throw new Error('OWNER_CHANGED');
        },
      ),
    ).rejects.toThrow('OWNER_CHANGED');
    expect(h.write).not.toHaveBeenCalled();
  });
  // Rule (2026-11-16, model-selector-unified.md): plugin task settings list other computers
  // and shares like an ordinary task. The location is saved with the model and checked
  // against that location's catalog, never this Host's; a Host model clears it. tier: unit.
  it('saves a remote run location without the Host catalog and clears it for a Host model', async () => {
    const validate = vi.fn(async (_config: PluginTaskConfig) => {});
    const h = setup(validate),
      before = h.service.read('plugin', 'installed-1');
    expect(before.remoteRoutes).toBe(true);
    const remote = { ...route, providerId: 'only-on-share', agentDeviceId: 'share:abc' };
    const saved = await h.service.update(
      'plugin', 'installed-1', { expectedRevision: before.revision, model: remote }, () => {});
    expect(h.providers).not.toHaveBeenCalled();
    expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ agentDeviceId: 'share:abc' }));
    expect(saved.config).toEqual({ ...remote, permissionMode: 'plan' });
    const local = await h.service.update(
      'plugin', 'installed-1', { expectedRevision: saved.revision, model: route }, () => {});
    expect(local.config).toEqual({ ...route, permissionMode: 'plan' });
    await expect(h.service.update('plugin', 'installed-1',
      { expectedRevision: local.revision, model: { ...route, agentDeviceId: 'local' } }, () => {}))
      .rejects.toThrow('PLUGIN_SETTINGS_INVALID');
    const restored = await h.service.update('plugin', 'installed-1',
      { expectedRevision: local.revision, model: remote }, () => {});
    const reset = await h.service.update('plugin', 'installed-1',
      { expectedRevision: restored.revision, model: null }, () => {});
    expect(reset.config).toEqual({ permissionMode: 'plan' });
  });
  // Old Desktop controllers resend the complete model while changing permissions or tuning.
  // That echo must not replace a remote source with the Host's same-named provider. tier: unit.
  it('preserves the remote source in legacy model echoes and accepts an explicit same-named Host choice', async () => {
    const h = setup(), remote = { ...route, agentDeviceId: 'share:abc' };
    const saved = await h.service.update('plugin', 'installed-1',
      { expectedRevision: h.service.read('plugin', 'installed-1').revision, model: remote }, () => {});
    const permission = await h.service.update('plugin', 'installed-1',
      { expectedRevision: saved.revision, model: route, permissionMode: 'auto' }, () => {});
    expect(permission.config).toEqual({ ...remote, permissionMode: 'auto' });
    const tuned = await h.service.update('plugin', 'installed-1',
      { expectedRevision: permission.revision, model: { ...route, effort: 'high', fastMode: false } }, () => {});
    expect(tuned.config).toEqual({ ...remote, effort: 'high', fastMode: false, permissionMode: 'auto' });
    expect(h.providers).not.toHaveBeenCalled();
    const local = await h.service.update('plugin', 'installed-1',
      { expectedRevision: tuned.revision, model: { ...route, agentDeviceId: null } }, () => {});
    expect(local.config).toEqual({ ...route, agentDeviceId: null, permissionMode: 'auto' });
  });

  it('saves validated plugin-engine (acp) routes and rejects invalid fastMode or provider prefix', async () => {
    const validate = vi.fn(async () => {});
    const h = setup(validate, [{
      key: 'antigravity:agy',
      providerId: 'acp-plugin:antigravity:agy',
      ghostId: 'antigravity',
      harnessId: 'agy',
      name: 'Antigravity',
      availability: { state: 'available' },
      models: [{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['high'] }],
      permissionModes: [],
      defaultPermissionMode: 'ask',
    }]);
    const before = h.service.read('plugin', 'installed-1');
    const acp = {
      agentKind: 'acp',
      providerId: 'acp-plugin:antigravity:agy',
      model: 'gemini-4-neon',
      effort: 'high',
      fastMode: false,
    };
    const saved = await h.service.update('plugin', 'installed-1',
      { expectedRevision: before.revision, model: acp }, () => {});
    expect(saved.config).toEqual({ ...acp, permissionMode: 'plan' });
    await expect(h.service.update('plugin', 'installed-1',
      { expectedRevision: saved.revision, model: { ...acp, fastMode: true } }, () => {}))
      .rejects.toThrow('PLUGIN_SETTINGS_INVALID');
    await expect(h.service.update('plugin', 'installed-1',
      { expectedRevision: saved.revision, model: { ...acp, providerId: 'openai' } }, () => {}))
      .rejects.toThrow('PLUGIN_SETTINGS_INVALID');
    await expect(h.service.update('plugin', 'installed-1',
      { expectedRevision: saved.revision, model: { ...acp, model: 'missing-model' } }, () => {}))
      .rejects.toThrow('PLUGIN_MODEL_UNAVAILABLE');
  });
});
