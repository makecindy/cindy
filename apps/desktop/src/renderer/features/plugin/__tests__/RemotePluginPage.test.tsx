// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemotePluginUiEnablePrompt } from '@/components/new-chat/RemotePluginUiEnablePrompt';
import { RemotePluginPage } from '../RemotePluginPage';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { ghostInstallApprovalToken } from '../../../../shared/ghost';
const { invoke, confirm, localGhosts, notices } = vi.hoisted(() => ({
  notices: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  localGhosts: vi.fn(),
}));
vi.mock('../PluginDevicePicker', async importOriginal => ({ ...await importOriginal<typeof import('../PluginDevicePicker')>(), usePluginDeviceDirectory: () => ({ online: true, target: { name: 'Execution computer' } }) }));
vi.mock('@/lib/toast', () => ({ toast: notices }));
vi.mock('@/components/new-chat/AddRemoteProjectDialog', () => ({
  AddRemoteProjectDialog: ({ fixedDeviceId, onProjectAdded, onOpenChange }: {
    fixedDeviceId: string;
    onProjectAdded(target: { kind: 'device-link'; deviceId: string; deviceName: string; path: string }): Promise<void>;
    onOpenChange(open: boolean): void;
  }) => <>
    <output>Browse {fixedDeviceId}</output>
    <button onClick={() => void onProjectAdded({ kind: 'device-link', deviceId: fixedDeviceId, deviceName: fixedDeviceId, path: '/target/browsed' }).then(() => onOpenChange(false))}>Select target folder</button>
    <button onClick={() => onOpenChange(false)}>Cancel folder</button>
  </>,
}));
vi.mock('@/cindy-brain/GhostSettingsWebview', () => ({
  GhostSettingsWebview: ({
    ghost,
    remoteDeviceId,
  }: {
    ghost: { instanceKey: string };
    remoteDeviceId: string;
  }) => (
    <output data-testid="original-settings">
      {remoteDeviceId}/{ghost.instanceKey}
    </output>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('../GhostPluginPage', () => ({
  GhostPluginCard: ({ item, onManage }: { item: { name: string }; onManage(): void }) => (
    <button onClick={onManage}>{item.name}</button>
  ),
  MarketPluginCard: () => null,
}));
vi.mock('../GhostPluginDetailView', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../GhostPluginDetailView')>()),
  GhostPluginDetailView: (props: {
    toggleDisabled: boolean;
    onToggle(value: boolean): void;
    remoteConfiguration: React.ReactNode;
    onBack(): void;
    detail: { enabled: boolean };
  }) => (
    <>
      <output>{props.detail.enabled ? 'Scoped enabled' : 'Scoped disabled'}</output>
      <button disabled={props.toggleDisabled} onClick={() => props.onToggle(false)}>
        Disable
      </button>
      {props.remoteConfiguration}
      <button onClick={props.onBack}>Back</button>
    </>
  ),
}));
vi.mock('../PluginManagementLayout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../PluginManagementLayout')>()),
  PLUGIN_INSTALLED_CARD_GRID_CLASS: '',
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS: '',
  PluginManagementLayout: ({
    children,
    onSelectTab,
    headerActions,
  }: {
    children: React.ReactNode;
    onSelectTab?: (tab: 'plugins' | 'skills') => void;
    headerActions?: React.ReactNode;
  }) => (
    <>
      <button onClick={() => onSelectTab?.('skills')}>Skills</button>
      {headerActions}
      {children}
    </>
  ),
  PluginManagementPage: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: localGhosts }));
const snapshot = (name: string) => ({
  version: 1,
  settingsPage: true,
  ghosts: [
    {
      manifest: {
        schemaVersion: 3,
        minCindyVersion: '0.1.61',
        id: 'weather',
        name,
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        settingsHtml: 'settings.html',
      },
      dir: '/fixture/weather',
      instanceKey: 'weather',
      namespace: null,
      enabled: true,
      approval: { state: 'approved' as const, revision: '00000000-0000-4000-8000-000000000001' },
    },
  ],
  market: {
    items: [],
    unavailableReason: null,
    customSourceNames: [],
    unavailableCustomSourceNames: [],
  },
});
const configurationResource = (state = 'configured', id = 'weather') => ({
  ref: { collectionId: 'plugins', kind: 'plugin', id },
  revision: 'r1',
  blocks: [
    {
      id: 'capabilities',
      primitive: 'plugin-capabilities',
      fallbackMarkdown: '',
      data: {
        usage: {
          taskUsable: true,
          hasSettings: true,
          approvalRequired: false,
          builtin: false,
          retired: false,
          setup: { state: 'ready', missing: [], expired: [] },
          configuration: {
            items: [
              {
                id: 'oauth:account',
                kind: 'oauth',
                label: 'Example account',
                state,
                count: state === 'configured' ? 1 : 0,
              },
            ],
            alternatives: [],
          },
        },
      },
    },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('test-owner');
  window.electronAPI = {
    deviceLink: {
      invoke,
      onRemotePush: () => () => {},
    },
  } as never;
  invoke.mockImplementation(
    async (
      device: string,
      channel: string,
      args: Array<{ actionId?: string; input?: { operationId?: string } }>,
    ) => {
      if (channel.endsWith(':manifest'))
        return { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] };
      if (channel === 'maker:remote-resources:get') return configurationResource();
      if (args[0].actionId === 'management:snapshot')
        return { effects: [], result: snapshot(device) };
      if (args[0].actionId === 'management:begin')
        return {
          effects: [],
          result: { operationId: args[0].input?.operationId, phase: 'succeeded' },
        };
      return { effects: [], result: { operationId: args[0].input?.operationId, phase: 'running' } };
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('selected plugin host', () => {
  it.each(['cancelled', 'changed'] as const)('presents the %s receipt with the existing notice', async outcome => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) =>
      args[0]?.actionId === 'management:begin'
        ? { effects: [], result: { operationId: args[0].input.operationId, phase: outcome === 'changed' ? 'failed' : 'cancelled', ...(outcome === 'changed' ? { errorCode: 'NOT_FOUND' } : {}) } }
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() =>
      expect(outcome === 'changed' ? notices.error : notices.info).toHaveBeenCalledWith(`settings.ghosts.remote.${outcome}`),
    );
    expect(screen.queryByText('settings.ghosts.remote.cancelled')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.retry' })).toBeNull();
  });
  const projectRevision = 'a'.repeat(64);
  function projects() {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot')
        return {
          effects: [],
          result: {
            ...snapshot(device),
            projectBrowse: true,
            projects: [
              { id: 'project-' + device, name: 'Project ' + device },
              { id: 'other-' + device, name: 'Other project' },
            ],
          },
        };
      if (args[0]?.actionId === 'management:project-state')
        return {
          effects: [],
          result: {
            projectId: args[0].input.projectId,
            revision: projectRevision,
            disabled: args[0].input.projectId.startsWith('other-') ? ['weather'] : [],
          },
        };
      return normal(device, channel, args);
    });
  }
  async function selectProject(name: string) {
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), {
      key: 'ArrowDown',
    });
    fireEvent.keyDown(
      await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' }),
      { key: 'ArrowRight' },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name }));
  }
  it('uses the existing target folder picker and Host-issued identity without reading controller folders', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) =>
      args[0]?.actionId === 'management:project-select'
        ? { effects: [], result: { id: 'browsed', name: 'Browsed folder', path: '/target/browsed' } }
        : normal(device, channel, args));
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('settings.ghosts.scopePicker.browse');
    expect(screen.getByText('Browse computer-a')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select target folder' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('computer-a', expect.any(String), [expect.objectContaining({
      actionId: 'management:project-state', input: { projectId: 'browsed' },
    })]));
    expect(invoke).toHaveBeenCalledWith('computer-a', expect.any(String), [expect.objectContaining({
      actionId: 'management:project-select', input: { path: '/target/browsed' },
    })]);
    const actions = invoke.mock.calls.map(call => call[2][0].actionId);
    expect(actions.slice(actions.indexOf('management:project-select') + 1)).toContain('management:snapshot');
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('ignores a late folder selection after switching computers and cancels without changing scope', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) => args[0]?.actionId === 'management:project-select'
      ? new Promise(done => { resolve = done; }) : normal(device, channel, args));
    const view = render(<RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('settings.ghosts.scopePicker.browse');
    fireEvent.click(screen.getByRole('button', { name: 'Select target folder' }));
    view.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    await act(async () => { resolve({ effects: [], result: { id: 'late-a', name: 'Late A' } }); });
    expect(invoke.mock.calls.some(call => call[2][0].actionId === 'management:project-state' && call[2][0].input.projectId === 'late-a')).toBe(false);
    await selectProject('settings.ghosts.scopePicker.browse');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel folder' }));
    expect(screen.queryByText('Browse computer-b')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }).textContent).toContain('globalScope');
  });
  it('binds a project toggle to its Host, project revision and physical plugin while avoiding market reconciliation on scope change', async () => {
    projects();
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    const snapshotsBefore = invoke.mock.calls.filter(
      (call) => call[2][0].actionId === 'management:snapshot',
    ).length;
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.remote.device' })
        .closest('[data-catalog-region="heading"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.remote.device' })
        .closest('[data-catalog-region="target"]')
        ?.querySelectorAll('button'),
    ).toHaveLength(1);
    await selectProject('Project computer-a');
    fireEvent.click(await screen.findByText('computer-a'));
    expect(screen.getByText('Scoped enabled')).toBeTruthy();
    expect(
      invoke.mock.calls.filter((call) => call[2][0].actionId === 'management:snapshot'),
    ).toHaveLength(snapshotsBefore);
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() =>
      expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
        true,
      ),
    );
    const call = invoke.mock.calls.find((call) => call[2][0].actionId === 'management:begin')!;
    expect(call[0]).toBe('computer-a');
    expect(call[2][0]).toMatchObject({
      resourceRef: { id: 'weather' },
      input: {
        kind: 'disable',
        projectId: 'project-computer-a',
        expectedProjectRevision: projectRevision,
      },
    });
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('ignores the previous project late response after switching projects', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      args[0]?.actionId === 'management:project-state' &&
      args[0].input.projectId === 'project-computer-a'
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('Project computer-a');
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(screen.queryByText('computer-a')).toBeNull();
    await selectProject('Other project');
    fireEvent.click(await screen.findByText('computer-a'));
    expect(screen.getByText('Scoped disabled')).toBeTruthy();
    await act(async () => {
      resolve({
        effects: [],
        result: { projectId: 'project-computer-a', revision: projectRevision, disabled: [] },
      });
    });
    expect(screen.getByText('Scoped disabled')).toBeTruthy();
  });
  it('loads the next computer own projects and resets its scope to global', async () => {
    projects();
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />,
    );
    await screen.findByText('computer-a');
    await selectProject('Other project');
    await screen.findByText('computer-a');
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }).textContent).toBe(
      'B / settings.ghosts.scopePicker.globalScope',
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), {
      key: 'ArrowDown',
    });
    fireEvent.keyDown(
      await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' }),
      { key: 'ArrowRight' },
    );
    await screen.findByRole('menuitem', { name: 'Project computer-b' });
    expect(screen.queryByRole('menuitem', { name: 'Project computer-a' })).toBeNull();
  });
  it('keeps global management usable with old Host project capability absent', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    expect(screen.getByText('settings.ghosts.remote.projectsUnsupported')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), {
      key: 'ArrowDown',
    });
    expect(
      (
        await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' })
      ).getAttribute('data-disabled'),
    ).toBe('');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByText('computer-a'));
    await screen.findByTestId('original-settings');
    expect((screen.getByText('Disable') as HTMLButtonElement).disabled).toBe(false);
  });
  it('project read failure retains the target with retry and blocks project actions', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      args[0]?.actionId === 'management:project-state'
        ? Promise.reject(new Error('timeout'))
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('Project computer-a');
    await screen.findByText(/projectReadFailed/);
    expect(screen.queryByText('computer-a')).toBeNull();
    expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
      false,
    );
    expect(screen.getByText('settings.ghosts.remote.retry')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.projectBanner.backToGlobal' }),
    );
    await screen.findByText('computer-a');
    expect(screen.getByText('settings.ghosts.remote.managingDescription')).toBeTruthy();
    expect(screen.queryByText(/projectReadFailed/)).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
      false,
    );
  });
  it('installs a file from the add-plugin menu onto the selected computer without a list-level import action', async () => {
    const pick = vi.fn(async () => ({ attachment: 'sandbox-transferred-package' }));
    Object.assign(window.electronAPI.deviceLink, { pickPluginPackage: pick });
    render(<RemotePluginPage device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    expect(screen.queryByText('settings.ghosts.remote.import')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.page.addPluginAria' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.ghosts.install' }));
    await waitFor(() => expect(pick).toHaveBeenCalledWith('computer-b'));
    await waitFor(() =>
      expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
        true,
      ),
    );
    const call = invoke.mock.calls.find((call) => call[2][0].actionId === 'management:begin')!;
    expect(call[0]).toBe('computer-b');
    expect(call[2][0].input).toMatchObject({
      kind: 'install-file',
      attachment: 'sandbox-transferred-package',
    });
  });
  it('keeps add-plugin disabled while offline', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-b', name: 'B' }} online={false} />);
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.page.addPluginAria',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'settings.ghosts.remote.device' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('does not reconcile a hidden target market until the Plugins tab is shown', async () => {
    const ui = render(
      <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active={false} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).not.toHaveBeenCalled();
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active />);
    await screen.findByText('computer-a');
  });
  it('routes enable/disable with target physical instance and approval without reading the local store', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[2][0].actionId === 'management:begin')).toBe(true),
    );
    const call = invoke.mock.calls.find((c) => c[2][0].actionId === 'management:begin')!;
    expect(call[0]).toBe('computer-a');
    expect(call[2][0].resourceRef.id).toBe('weather');
    expect(call[2][0].input).toMatchObject({
      kind: 'disable',
      expectedInstalledApproval: ghostInstallApprovalToken(snapshot('A').ghosts[0].approval),
    });
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('keeps offline target data, disables writes and never falls back to local APIs', async () => {
    const ui = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online={false} />);
    expect((screen.getByText('Disable') as HTMLButtonElement).disabled).toBe(true);
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('shows only the disabled hint, then mounts the original settings when enabled', async () => {
    let enabled = false;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot') {
        const data = snapshot(device);
        data.ghosts[0].enabled = enabled;
        return { effects: [], result: data };
      }
      return normal(device, channel, args);
    });
    const ui = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.queryByText('settings.ghosts.detail.configurationTitle')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.enableBeforeConfigure')).toBeTruthy();
    enabled = true;
    ui.rerender(
      <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active={false} />,
    );
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active />);
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    expect(screen.queryByText('settings.ghosts.remote.enableBeforeConfigure')).toBeNull();
    expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
      false,
    );
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('removes the original page when a Host operation returns its new disabled state', async () => {
    let enabled = true;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot') {
        const data = snapshot(device);
        data.ghosts[0].enabled = enabled;
        return { effects: [], result: data };
      }
      if (args[0]?.actionId === 'management:begin') {
        enabled = false;
        return {
          effects: [],
          result: {
            operationId: args[0].input.operationId,
            phase: 'failed',
            errorCode: 'GHOST_ASLEEP',
          },
        };
      }
      return normal(device, channel, args);
    });
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toBeTruthy();
    fireEvent.click(screen.getByText('Disable'));
    await screen.findByText('Scoped disabled');
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.enableBeforeConfigure')).toBeTruthy();
  });
  it('reopens the original settings instead of rendering synthesized authorization metadata', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    expect(screen.queryByText('settings.ghosts.remote.authorizedAccounts')).toBeNull();
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toBeTruthy();
    expect(invoke.mock.calls.some((call) => call[1] === 'maker:remote-resources:get')).toBe(false);
  });
  it('does not open the setup coordinator or read a summary while displaying settings', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    await screen.findByTestId('original-settings');
    expect(invoke.mock.calls.some((call) => call[2][0].input?.kind === 'configure')).toBe(false);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.configure' })).toBeNull();
  });
  it('binds the original page to the selected computer when switching targets', async () => {
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />,
    );
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    expect(screen.queryByTestId('original-settings')).toBeNull();
    fireEvent.click(await screen.findByText('computer-b'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-b/weather',
    );
  });
  it('keeps settings bound to the physical instance when opening a namespaced copy', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot') {
        const state = snapshot(device);
        return {
          effects: [],
          result: {
            ...state,
            ghosts: [
              ...state.ghosts,
              {
                ...state.ghosts[0],
                instanceKey: '_ns__xd__weather',
                namespace: 'xd',
                manifest: { ...state.ghosts[0].manifest, name: 'Organization weather' },
              },
            ],
          },
        };
      }
      return normal(device, channel, args);
    });
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(await screen.findByText('Organization weather'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/_ns__xd__weather',
    );
  });
  it('unmounts the original settings when its Host disconnects', async () => {
    const ui = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    await screen.findByTestId('original-settings');
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online={false} />);
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.offlineNotice')).toBeTruthy();
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('ignores a late response from a previous mounted device', async () => {
    let reply!: (value: unknown) => void;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      device === 'computer-a' && args[0].actionId === 'management:snapshot'
        ? new Promise((resolve) => {
            reply = resolve;
          })
        : normal(device, channel, args),
    );
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />,
    );
    await waitFor(() => expect(reply).toBeTypeOf('function'));
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    await act(async () => {
      reply({ result: snapshot('stale-a') });
    });
    expect(screen.queryByText('stale-a')).toBeNull();
  });
  it('discards an owner’s late response after switching account', async () => {
    let reply!: (value: unknown) => void;
    invoke.mockImplementation(async (_device, channel) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] }
        : new Promise((resolve) => {
            reply = resolve;
          }),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await waitFor(() => expect(reply).toBeTypeOf('function'));
    setDataOwnerGeneration('other-owner');
    await act(async () => {
      reply({ result: snapshot('old-account') });
    });
    expect(screen.queryByText('old-account')).toBeNull();
  });
  it('shows old Host plugins read-only when the capability is absent', async () => {
    invoke.mockImplementation(async (_device, channel) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'plugins' }] }
        : {
            items: [
              {
                ref: { collectionId: 'plugins', kind: 'plugin', id: 'legacy' },
                revision: 'r1',
                display: { title: 'Legacy plugin', status: { label: 'enabled' } },
              },
            ],
          },
    );
    const onSelectCatalogTab = vi.fn();
    render(
      <RemotePluginPage
        device={{ deviceId: 'old', name: 'Old' }}
        online
        deviceControl={{
          selected: { deviceId: 'old', name: 'Old' },
          onSelect: vi.fn(),
          directory: { candidates: [], target: undefined, online: true, relayOnline: true },
        }}
        onSelectCatalogTab={onSelectCatalogTab}
      />,
    );
    await screen.findByText('Legacy plugin');
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.remote.device' })
        .closest('[data-catalog-region="heading"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Skills'));
    expect(onSelectCatalogTab).toHaveBeenCalledWith('skills');
    expect(screen.getByText('settings.ghosts.remote.unsupported')).toBeTruthy();
    expect(invoke.mock.calls.some((c) => c[2][0].actionId === 'management:begin')).toBe(false);
  });
  const legacyItem = {
    ref: { collectionId: 'plugins', kind: 'plugin', id: '_ns__team__notes' },
    revision: 'r1',
    display: { title: 'Team notes', subtitle: 'Organize notes', status: { label: 'enabled' } },
  };
  const legacyResource = {
    ...legacyItem,
    blocks: [
      { id: 'about', primitive: 'markdown', fallbackMarkdown: 'Full description from A' },
      { id: 'version', primitive: 'status', fallbackMarkdown: '1.2.3' },
      {
        id: 'capabilities',
        primitive: 'plugin-capabilities',
        fallbackMarkdown: '',
        data: {
          tools: [{ name: 'read_notes', description: 'Read saved notes' }],
          permissions: [{ title: 'Access notes service', description: 'Only the declared host' }],
          details: [{ key: 'author', title: 'Author', value: 'Example Team' }],
        },
      },
    ],
  };
  function oldHost() {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    invoke.mockImplementation(async (_device, channel) => {
      if (channel.endsWith(':manifest')) return { collections: [{ id: 'plugins' }] };
      if (channel.endsWith(':list')) return { items: [legacyItem] };
      if (channel.endsWith(':get')) return legacyResource;
      throw new Error('unexpected write');
    });
  }
  it('opens a normal detail header and all provided facts for an older Host without using local actions', async () => {
    oldHost();
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('Full description from A');
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('Example Team')).toBeTruthy();
    expect(screen.getByText('read_notes')).toBeTruthy();
    expect(screen.getByText('Access notes service')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('settings.ghosts.remote.configure')).toBeNull();
    expect(invoke.mock.calls.find((call) => call[1].endsWith(':get'))).toMatchObject([
      'old-a',
      expect.any(String),
      [{ ref: legacyItem.ref, client: { locale: 'en' } }],
    ]);
    expect(invoke.mock.calls.some((call) => call[1].endsWith(':invoke'))).toBe(false);
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('keeps the readable header while loading, and Back prevents a late detail from reopening', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    await screen.findByText('settings.ghosts.remote.detailLoading');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    await act(async () => resolve(legacyResource));
    expect(screen.queryByText('Full description from A')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team notes' })).toBeNull();
  });
  it('does not let a late old-Host detail appear after selecting a different computer', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'old-a', name: 'A' }} online />,
    );
    fireEvent.click(await screen.findByText('Team notes'));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'old-b', name: 'B' }} online />);
    await screen.findByText('Team notes');
    await act(async () => resolve(legacyResource));
    expect(screen.queryByText('Full description from A')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team notes' })).toBeNull();
  });
  it('shows a detail read failure and retries only that Host resource', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? Promise.reject(new Error('timeout'))
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('settings.ghosts.remote.detailReadFailed');
    invoke.mockImplementation(normal);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.refreshDetail' }));
    await screen.findByText('Full description from A');
    expect(screen.queryByText('settings.ghosts.remote.detailReadFailed')).toBeNull();
    expect(invoke.mock.calls.every((call) => call[0] === 'old-a')).toBe(true);
  });
  it('ignores a late detail after account ownership changes', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    setDataOwnerGeneration('signed-out');
    await act(async () => resolve(legacyResource));
    expect(screen.queryByText('Full description from A')).toBeNull();
  });
  it('retains the detail offline and refreshes it on reconnect without invoking writes', async () => {
    oldHost();
    const ui = render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('Full description from A');
    const previousReads = invoke.mock.calls.filter((call) => call[1].endsWith(':get')).length;
    ui.rerender(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online={false} />);
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    expect(screen.getByText('settings.ghosts.remote.offlineNotice')).toBeTruthy();
    ui.rerender(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    await waitFor(() =>
      expect(invoke.mock.calls.filter((call) => call[1].endsWith(':get')).length).toBeGreaterThan(
        previousReads,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('settings.ghosts.remote.detailLoading')).toBeNull(),
    );
    expect(screen.getByText('Full description from A')).toBeTruthy();
    expect(invoke.mock.calls.some((call) => call[1].endsWith(':invoke'))).toBe(false);
  });
  it('returns to the full management page when a refreshed Host gains the capability', async () => {
    oldHost();
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('Full description from A');
    invoke.mockImplementation(async (_device, channel) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] }
        : { result: snapshot('Upgraded plugin') },
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.refresh' }));
    await screen.findByText('Upgraded plugin');
    expect(screen.queryByText('Full description from A')).toBeNull();
    expect(screen.queryByText('settings.ghosts.remote.unsupported')).toBeNull();
  });
  it('shows list errors before upgrade advice and clears the error after refreshing', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':list')
        ? Promise.reject(new Error('timeout'))
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    await waitFor(() =>
      expect(notices.error).toHaveBeenCalledWith(
        'settings.ghosts.remote.readFailed',
        expect.any(Object),
      ),
    );
    expect(screen.queryByText('settings.ghosts.remote.unsupported')).toBeNull();
    invoke.mockImplementation(normal);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.refresh' }));
    await screen.findByText('Team notes');
    expect(screen.queryByText('settings.ghosts.remote.readFailed')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.refresh' })).toBeTruthy();
  });
});

// unit: the remote task prompt must negotiate before sending, and a lost approval
// receipt must never replay consent. Minimum input: one pending UI plugin and one answer.
describe('remote task interactive-page consent prompt', () => {
  function setup(capability: boolean, lost = false) {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      const action = args?.[0]?.actionId;
      if (action === 'management:snapshot') {
        const data = snapshot(device);
        return { effects: [], result: { ...data, ...(capability ? { uiCapabilityApproval: true } : {}),
          ghosts: data.ghosts.map(g => ({ ...g, manifest: { ...g.manifest, schemaVersion: 3, tools: [{ name: 'open', description: 'Open page' }], mcpApps: { ui: { resources: [{
            uri: "ui://planner",
            file: 'ui.html'
        }], tools: { open: { resourceUri: 'ui://planner' } } } } } })) } };
      }
      if (action === 'management:operation') return { effects: [], result: {
        operationId: args[0].input.operationId, phase: 'confirmation', consent: {
          requestId: 'page-consent', purpose: 'ui-capability', initiator: 'user', origin: 'local-file',
          facts: { kind: 'install', ghostId: 'weather', name: 'Weather', version: '1.0.0', permissions: [] },
        },
      } };
      if (action === 'management:answer' && lost) throw new Error('receipt lost');
      return normal(device, channel, args);
    });
  }
  it('shows an upgrade hint without sending an unnegotiated operation to an old Host', async () => {
    setup(false); render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await screen.findByText('newChat.pluginUi.updateHost');
    expect(screen.queryByText('newChat.pluginUi.enable')).toBeNull();
    expect(invoke.mock.calls.some(c => c[2]?.[0]?.actionId === 'management:begin')).toBe(false);
  });
  it('answers page consent once, then queries the same operation after a lost receipt', async () => {
    setup(true, true); render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    const button = await screen.findByText('newChat.pluginUi.enable');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:answer')).toHaveLength(1);
    const begin = invoke.mock.calls.find(c => c[2]?.[0]?.actionId === 'management:begin')!;
    expect(begin[2][0].input).toMatchObject({ kind: 'approve-ui', uiConsentVersion: 1 });
    expect(confirm).toHaveBeenCalledOnce();
    // Poll with fake time; no network replay and no second consent dialog.
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:operation').length).toBeGreaterThan(1);
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:answer')).toHaveLength(1);
    expect(confirm).toHaveBeenCalledOnce();
  });
  // #4423428047, unit: real prompt + RPC adapter; previous coverage only rejected
  // an already-created operation. A stale begin must refresh and allow an explicit
  // retry; a lost begin receipt must keep querying without replaying approval.
  it.each(['NOT_FOUND', 'receipt lost'])('recovers a %s begin without replaying it', async failure => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    const revision = '00000000-0000-4000-8000-000000000002';
    let begins = 0;
    invoke.mockImplementation(async (device, channel, args) => {
      const request = args?.[0];
      if (request?.actionId === 'management:begin' && ++begins === 1)
        throw new Error(failure === 'NOT_FOUND' ? '[NOT_FOUND] Plugin changed' : failure);
      if (request?.actionId === 'management:operation' && failure === 'NOT_FOUND' && begins === 1)
        throw new Error('[NOT_FOUND] Operation was not created');
      if (request?.actionId === 'management:operation' && failure === 'receipt lost')
        return { effects: [], result: { operationId: request.input.operationId, phase: 'running' } };
      const result = await normal(device, channel, args);
      if (request?.actionId === 'management:snapshot' && begins > 0)
        result.result.ghosts = result.result.ghosts.map((ghost: ReturnType<typeof snapshot>['ghosts'][number]) => ({ ...ghost, approval: { ...ghost.approval, revision } }));
      return result;
    });
    render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    const button = await screen.findByRole('button', { name: 'newChat.pluginUi.enable' });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    const operations = invoke.mock.calls.filter(call => call[2]?.[0]?.actionId === 'management:operation');
    expect(begins).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    if (failure === 'NOT_FOUND') {
      expect(notices.error).toHaveBeenCalledWith('settings.ghosts.remote.changed');
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText('settings.ghosts.remote.unknown')).toBeNull();
      expect(operations).toHaveLength(0);
      await act(async () => { fireEvent.click(button); });
      const requests = invoke.mock.calls.filter(call => call[2]?.[0]?.actionId === 'management:begin');
      expect(requests).toHaveLength(2);
      expect(requests[1][2][0].input.expectedInstalledApproval).toBe(ghostInstallApprovalToken({ state: 'approved', revision }));
      expect(requests[1][2][0].input.operationId).not.toBe(requests[0][2][0].input.operationId);
      expect(confirm).toHaveBeenCalledOnce();
    } else {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(operations.length).toBeGreaterThan(1);
      expect(new Set(operations.map(call => call[2][0].input.operationId)).size).toBe(1);
      expect(notices.error).not.toHaveBeenCalled();
    }
  });
  // M04, unit: a confirmation for an updated install fails; the prompt must not
  // silently disappear. Existing tests only covered success and lost receipts.
  it('shows the existing changed-plugin notice for a stale page approval', async () => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    let answered = false;
    invoke.mockImplementation(async (device, channel, args) => {
      const request = args?.[0];
      if (request?.actionId === 'management:answer') answered = true;
      if (request?.actionId === 'management:operation' && answered) return { effects: [], result: {
        operationId: request.input.operationId, phase: 'failed', errorCode: 'NOT_FOUND',
      } };
      return normal(device, channel, args);
    });
    render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    const button = await screen.findByText('newChat.pluginUi.enable');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(notices.error).toHaveBeenCalledWith('settings.ghosts.remote.changed');
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:answer')).toHaveLength(1);
    expect(screen.queryByText('newChat.pluginUi.ready')).toBeNull();
  });

});
