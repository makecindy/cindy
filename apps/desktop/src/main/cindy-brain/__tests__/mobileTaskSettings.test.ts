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
function setup() {
  let config: PluginTaskConfig = {
    workingDir: '/private/selected-directory',
    permissionMode: 'plan',
  };
  const write = vi.fn((_id, value: PluginTaskConfig) => (config = value));
  const providers = vi.fn(async () => [provider]);
  const service = new MobileTaskSettings({
    read: () => config,
    write,
    validate: async () => {},
    providers,
    agents: async () => ['codex'],
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
});
