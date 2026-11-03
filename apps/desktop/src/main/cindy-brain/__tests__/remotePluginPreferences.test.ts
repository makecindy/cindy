import { describe, expect, it, vi } from 'vitest';
import type { PluginTaskPreferences } from '@cindy/device-link';
import { RemotePluginPreferences } from '../remotePluginPreferences';
import type { InstalledGhost } from '../../../shared/ghost';

function fixture() {
  const ghost = {
    manifest: {
      id: 'sample',
      cindy: { text: ['oneshot'] },
      agent: { tasks: true },
      mainView: { html: 'main.html' },
    },
    enabled: true,
    approval: { state: 'approved', revision: 'install-a' },
  } as unknown as InstalledGhost;
  let visible = true;
  let tasks: PluginTaskPreferences = {
    revision: 'task-a',
    config: {},
    permissionModes: ['ask'],
    defaultPermissionMode: 'ask',
  };
  const deps = {
    auxiliaryModelLabel: () => 'Target auxiliary model',
    tasks: {
      read: vi.fn(() => tasks),
      update: vi.fn<
        (
          id: string,
          installation: string,
          input: Record<string, unknown>,
          check: () => void,
        ) => Promise<PluginTaskPreferences>
      >(async (...[, , input, check]) => {
        check();
        tasks = {
          ...tasks,
          revision: 'task-b',
          config: input.model as PluginTaskPreferences['config'],
        };
        return tasks;
      }),
    },
    sidebar: {
      read: vi.fn(() => visible),
      write: vi.fn(async (...[, value, check]: [string, boolean, () => void]) => {
        check();
        visible = value;
      }),
    },
  };
  return {
    service: new RemotePluginPreferences(deps),
    ghost,
    deps,
    changeSidebar: () => {
      visible = false;
    },
  };
}
describe('target-owned plugin preferences', () => {
  it('uses the single target model and sidebar controls without projecting private routes', () => {
    const f = fixture(),
      value = f.service.read('physical-instance', f.ghost);
    expect(value.tasks?.revision).toBe('task-a');
    expect(value.auxiliaryModelLabel).toBe('Target auxiliary model');
    expect(value.sidebarVisible).toBe(true);
    expect(f.deps.tasks.read).toHaveBeenCalledWith('physical-instance', expect.any(String));
    expect(JSON.stringify(value)).not.toMatch(/workingDir|routing|overrides/);
  });
  it('shows one model for quick-answer-only plugins and no obsolete media capability controls', () => {
    const f = fixture();
    f.ghost.manifest.agent = undefined;
    expect(f.service.read('sample', f.ghost).tasks).toBeDefined();
    f.ghost.manifest.cindy = { image: ['generate'] };
    expect(f.service.read('sample', f.ghost).tasks).toBeUndefined();
  });
  it('rejects stale revisions before writing', async () => {
    const f = fixture(),
      value = f.service.read('sample', f.ghost);
    f.changeSidebar();
    await expect(
      f.service.update(
        'sample',
        f.ghost,
        { expectedRevision: value.revision, kind: 'tasks', patch: { model: null } },
        () => {},
      ),
    ).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
    expect(f.deps.tasks.update).not.toHaveBeenCalled();
  });
  it('patches the target model and returns the committed snapshot', async () => {
    const f = fixture(),
      value = f.service.read('sample', f.ghost);
    const model = {
      agentKind: 'codex',
      providerId: 'target-provider',
      model: 'target-model',
      fastMode: false,
    };
    const result = await f.service.update(
      'sample',
      f.ghost,
      { expectedRevision: value.revision, kind: 'tasks', patch: { model } },
      () => {},
    );
    expect(result.tasks?.config).toEqual(model);
    expect(result.revision).not.toBe(value.revision);
    expect(f.deps.tasks.update).toHaveBeenCalledWith(
      'sample',
      expect.any(String),
      { model, expectedRevision: 'task-a' },
      expect.any(Function),
    );
    expect(f.deps.sidebar.write).not.toHaveBeenCalled();
  });
  it('does not expose or mutate controls absent from the installed declaration', async () => {
    const f = fixture();
    f.ghost.manifest = {
      ...f.ghost.manifest,
      cindy: undefined,
      agent: undefined,
      mainView: undefined,
    };
    const value = f.service.read('sample', f.ghost);
    expect(value.tasks).toBeUndefined();
    expect(value.sidebarVisible).toBeUndefined();
    for (const input of [
      { kind: 'sidebar', visible: true },
      { kind: 'tasks', patch: { model: null } },
      { kind: 'cindy', capability: 'image.generate', model: 'target-model' },
    ]) {
      await expect(
        f.service.update(
          'sample',
          f.ghost,
          { expectedRevision: value.revision, ...input },
          () => {},
        ),
      ).rejects.toThrow('PLUGIN_SETTINGS_INVALID');
    }
  });
});
