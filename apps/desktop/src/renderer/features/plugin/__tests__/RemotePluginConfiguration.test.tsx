// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemotePluginConfiguration } from '../RemotePluginConfiguration';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../../shared/ghost';
import type { RemotePluginPreferenceSnapshot } from '../../../../shared/pluginPreferences';
const { invoke, local } = vi.hoisted(() => ({
  invoke: vi.fn(),
  local: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => (values?.name ? `${key}:${values.name}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../remotePluginManagementClient', async (original) => ({
  ...(await original<typeof import('../remotePluginManagementClient')>()),
  invokePluginManagement: invoke,
}));
vi.mock('../GhostPluginDetailView', () => ({
  DetailSectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));
vi.mock('@/cindy-brain/PluginTaskPrefs', () => ({
  PluginTaskPrefs: ({
    remote,
    disabled,
  }: {
    disabled: boolean;
    remote: {
      deviceId: string;
      value: { config: Record<string, unknown> };
      onChange(config: Record<string, unknown>): Promise<unknown>;
    };
  }) => (
    <>
      <output>{JSON.stringify(remote.value.config)}</output>
      <button
        disabled={disabled}
        onClick={() => {
          void remote
            .onChange({
              agentKind: 'codex',
              providerId: 'target-provider',
              model: 'only-on-target',
              fastMode: false,
            })
            .catch(() => {});
        }}
      >
        Target model
      </button>
      <button
        disabled={disabled}
        onClick={() => {
          void remote.onChange({ ...remote.value.config, permissionMode: 'ask' }).catch(() => {});
        }}
      >
        Task preferences {remote.deviceId}
      </button>
    </>
  ),
}));
vi.mock('@/cindy-brain/GhostSettingsWebview', () => ({
  GhostSettingsWebview: ({
    ghost,
    remoteDeviceId,
  }: {
    ghost: InstalledGhost;
    remoteDeviceId: string;
  }) => (
    <div data-testid="original-settings">
      {remoteDeviceId}:{ghost.manifest.settingsHtml}
    </div>
  ),
}));
const ghost = (cindy?: InstalledGhost['manifest']['cindy']): InstalledGhost => ({
  manifest: {
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id: 'generic-plugin',
    name: 'Generic plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    cindy,
  },
  instanceKey: 'physical-plugin',
  namespace: null,
  dir: '/target/plugin',
  enabled: true,
  approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
});
function preferences(): RemotePluginPreferenceSnapshot {
  return {
    revision: 'a'.repeat(64),
    tasks: {
      revision: 'tasks',
      config: {},
      permissionModes: ['ask'],
      defaultPermissionMode: 'ask',
    },
    auxiliaryModelLabel: 'Target auxiliary model',
  };
}
const props = {
  device: { deviceId: 'target-b', name: 'B' },
  online: true,
  active: true,
  busy: false,
  hostPreferences: true,
  settingsPage: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('config-owner');
  window.electronAPI = {
    ghosts: {
      errandPrefsSync: local,
      setErrandConfig: local,
    },
  } as never;
  invoke.mockResolvedValue({ revision: 'a'.repeat(64) });
});
describe('remote original settings and target Host controls', () => {
  it('reuses the target single-model control and persists it without local preferences', async () => {
    const installed = ghost({ image: ['generate'], text: ['oneshot'] });
    let saved = preferences();
    invoke.mockImplementation(async (_device, action, input) => {
      if (action === 'preferences-set')
        saved = {
          ...saved,
          revision: 'b'.repeat(64),
          tasks: { ...saved.tasks!, config: input.patch.model },
        };
      return saved;
    });
    const ui = render(<RemotePluginConfiguration {...props} ghost={installed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Target model' }));
    await screen.findByText(/only-on-target/);
    expect(invoke).toHaveBeenCalledWith(
      'target-b',
      'preferences-set',
      expect.objectContaining({
        expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
        expectedRevision: 'a'.repeat(64),
        kind: 'tasks',
        patch: {
          model: {
            agentKind: 'codex',
            providerId: 'target-provider',
            model: 'only-on-target',
            fastMode: false,
          },
          permissionMode: null,
        },
      }),
      'physical-plugin',
    );
    ui.unmount();
    render(<RemotePluginConfiguration {...props} ghost={installed} />);
    await screen.findByText(/only-on-target/);
    expect(local).not.toHaveBeenCalled();
  });
  it('embeds the installed plugin settings page without reconstructing its fields', async () => {
    const installed = ghost();
    installed.manifest.settingsHtml = 'custom/settings.html';
    render(<RemotePluginConfiguration {...props} ghost={installed} />);
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'target-b:custom/settings.html',
    );
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.configure' })).toBeNull();
    expect(local).not.toHaveBeenCalled();
  });
  it('removes the remote page when offline and opens the original again on reconnect', async () => {
    const installed = ghost();
    installed.manifest.settingsHtml = 'settings.html';
    const ui = render(<RemotePluginConfiguration {...props} ghost={installed} />);
    expect(await screen.findByTestId('original-settings')).toBeTruthy();
    ui.rerender(<RemotePluginConfiguration {...props} ghost={installed} online={false} />);
    expect(screen.queryByTestId('original-settings')).toBeNull();
    ui.rerender(<RemotePluginConfiguration {...props} ghost={installed} />);
    expect(await screen.findByTestId('original-settings')).toBeTruthy();
  });
  it('does not offer an empty Configure flow for plugins without configuration', async () => {
    render(<RemotePluginConfiguration {...props} ghost={ghost()} />);
    await waitFor(() =>
      expect(screen.queryByText('settings.ghosts.remote.configurationLoading')).toBeNull(),
    );
    expect(screen.queryByText('settings.ghosts.detail.configurationTitle')).toBeNull();
  });
  it('uses target task preferences and patches them without a controller working directory', async () => {
    const installed = ghost();
    installed.manifest.agent = { tasks: true };
    const value = {
      revision: 'a'.repeat(64),
      tasks: {
        revision: 'tasks',
        config: {},
        permissionModes: ['ask'],
        defaultPermissionMode: 'ask',
      },
    };
    invoke.mockResolvedValue(value);
    render(<RemotePluginConfiguration {...props} ghost={installed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Task preferences target-b' }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'target-b',
        'preferences-set',
        expect.objectContaining({ kind: 'tasks', patch: { model: null, permissionMode: 'ask' } }),
        'physical-plugin',
      ),
    );
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('workingDir');
    expect(local).not.toHaveBeenCalled();
  });
  it('discards old instance reads and disables writes offline', async () => {
    let resolve!: (value: RemotePluginPreferenceSnapshot) => void;
    invoke.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const old = ghost({ text: ['oneshot'] });
    const ui = render(<RemotePluginConfiguration {...props} ghost={old} />);
    const next = ghost();
    next.instanceKey = 'new-instance';
    ui.rerender(<RemotePluginConfiguration {...props} ghost={next} />);
    await act(async () => resolve(preferences()));
    expect(screen.queryByRole('button', { name: 'Target model' })).toBeNull();
    invoke.mockResolvedValue(preferences());
    ui.rerender(<RemotePluginConfiguration {...props} ghost={old} />);
    const change = await screen.findByRole('button', { name: 'Target model' });
    ui.rerender(<RemotePluginConfiguration {...props} ghost={old} online={false} />);
    fireEvent.click(change);
    expect(invoke.mock.calls.some((call) => call[1] === 'preferences-set')).toBe(false);
  });
  it('shows the real old-Host capability limit instead of substituting a generic form', async () => {
    const installed = ghost({ text: ['oneshot'] });
    installed.manifest.settingsHtml = 'settings.html';
    render(
      <RemotePluginConfiguration
        {...props}
        hostPreferences={false}
        settingsPage={false}
        ghost={installed}
      />,
    );
    expect(await screen.findByText('settings.ghosts.remote.settingsPageUnavailable')).toBeTruthy();
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.configure' })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
