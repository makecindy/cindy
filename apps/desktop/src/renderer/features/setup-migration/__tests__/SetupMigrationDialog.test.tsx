// @vitest-environment jsdom
/**
 * New-computer setup wizard: pick a computer, review, confirm plugin permissions once,
 * apply, then show what must still be done on this computer.
 *
 * Grounded in docs/product-rules/new-device-setup-migration.md: plugin permissions are
 * confirmed in one batch before anything installs; only the Main-computed facts the user
 * saw are approved; renderer-owned items go through the existing settings APIs.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SetupMigrationApplyResponse, SetupMigrationPlan } from '../../../../shared/setupMigration';
import { SetupMigrationDialog } from '../SetupMigrationDialog';
import { closeSetupMigration, openSetupMigration } from '../setupMigrationStore';

const createCustomProvider = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/customProviders', () => ({ createCustomProvider }));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: () => {} }));

afterEach(() => {
  act(() => closeSetupMigration());
  cleanup();
});

const plan: SetupMigrationPlan = {
  planId: 'plan-1',
  source: { deviceId: 'd1', name: 'Mac mini', platform: 'darwin' },
  createdAt: 0,
  plugins: [
    {
      key: 'plugin:_root:gmail',
      state: 'ready',
      ghostId: 'gmail',
      name: 'Gmail',
      version: '2.0.0',
      namespace: null,
      pluginId: 'plg_gmail',
      source: 'market',
      marketName: null,
      enabledOnSource: true,
      consent: {
        kind: 'install',
        ghostId: 'gmail',
        name: 'Gmail',
        version: '2.0.0',
        permissions: [{ key: 'network:gmail', kind: 'network', labelKey: 'networkHost', labelArgs: { host: 'gmail.googleapis.com' } }],
      },
    },
  ],
  skills: [],
  settings: [{ key: 'settings:collaboration', id: 'collaboration', changeCount: 2, keptCount: 0, state: 'ready' }],
  rendererPrefs: null,
  providers: [
    {
      key: 'provider:or',
      state: 'ready',
      provider: { id: 'or', name: 'OpenRouter', auth: 'apiKey', config: { id: 'or', name: 'OpenRouter', runtimes: {} } },
    },
  ],
  mcpServers: [],
  builtinTools: [],
  access: [{ key: 'access:remote-control', id: 'remote-control', state: 'ready' }],
  secrets: null,
  sshHosts: [],
  checklist: [{ id: 'provider-key:or', kind: 'provider-key', label: 'OpenRouter', ref: 'or' }],
  unavailable: [],
};

function installApi() {
  const setupMigration = {
    sources: vi.fn(async () => [
      { deviceId: 'd1', name: 'Mac mini', platform: 'darwin', online: true, lastSeenAt: null },
      { deviceId: 'd2', name: 'Office PC', platform: 'win32', online: false, lastSeenAt: null, unavailable: 'offline' },
    ]),
    preview: vi.fn(async () => plan),
    apply: vi.fn(async (): Promise<SetupMigrationApplyResponse> => ({
      results: [
        { key: 'plugin:_root:gmail', outcome: 'done' },
        { key: 'settings:collaboration', outcome: 'done' },
      ],
      checklist: [
        { id: 'plugin-setup:_root__gmail', kind: 'plugin-setup', label: 'Gmail', ref: '_root__gmail', details: ['Google account'] },
        { id: 'provider-key:or', kind: 'provider-key', label: 'OpenRouter', ref: 'or' },
      ],
      handledKeys: [],
    })),
    state: vi.fn(),
    dismiss: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    host: { ready: vi.fn(), reply: vi.fn(), onRequest: vi.fn(() => () => {}) },
  };
  const deviceLink = { setEnabled: vi.fn(async () => ({ remoteControlEnabled: true })), setKeepAwake: vi.fn() };
  Object.assign(window, {
    electronAPI: {
      setupMigration,
      deviceLink,
      maker: {
        plugins: { list: vi.fn(async () => []), setEnabled: vi.fn() },
        createCustomMcpServer: vi.fn(),
      },
    },
  });
  return { setupMigration, deviceLink };
}

describe('SetupMigrationDialog', () => {
  it('confirms plugin permissions once, applies the selection and lists what is left', async () => {
    const { setupMigration, deviceLink } = installApi();
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration());

    await screen.findByText('Mac mini');
    // An offline computer is shown with its reason but cannot be picked.
    expect((screen.getAllByRole('radio')[1] as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.source.next' }));

    await screen.findByText('Gmail');
    expect(setupMigration.preview).toHaveBeenCalledWith('d1');
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.review.start' }));

    // Batch confirmation shows the permissions Main computed before anything installs.
    await screen.findByText('setupMigration.permissions.description');
    expect(setupMigration.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.permissions.confirm' }));

    await waitFor(() => expect(setupMigration.apply).toHaveBeenCalledTimes(1));
    expect(setupMigration.apply).toHaveBeenCalledWith({
      planId: 'plan-1',
      keys: ['plugin:_root:gmail', 'settings:collaboration', 'provider:or', 'access:remote-control'],
      approvedPluginKeys: ['plugin:_root:gmail'],
    });
    await waitFor(() => expect(deviceLink.setEnabled).toHaveBeenCalledWith(true));
    expect(createCustomProvider).toHaveBeenCalledWith({ id: 'or', name: 'OpenRouter', runtimes: {} }, {});

    await screen.findByText('setupMigration.done.checklistTitle');
    expect(screen.getByText('setupMigration.checklist.plugin-setup.title')).toBeTruthy();
    expect(screen.getByText('setupMigration.checklist.provider-key.title')).toBeTruthy();
  });

  it('skips the permission step and approves nothing when no plugin is selected', async () => {
    const { setupMigration } = installApi();
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration('d1'));

    await screen.findByText('Gmail');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.review.start' }));

    await waitFor(() => expect(setupMigration.apply).toHaveBeenCalledTimes(1));
    expect(setupMigration.apply).toHaveBeenCalledWith(
      expect.objectContaining({ approvedPluginKeys: [], keys: expect.not.arrayContaining(['plugin:_root:gmail']) }),
    );
  });

  it('writes no renderer-owned item when Main refuses the plan', async () => {
    const { setupMigration, deviceLink } = installApi();
    setupMigration.apply.mockRejectedValueOnce(
      Object.assign(new Error('[SETUP_PLAN_EXPIRED] account changed'), { code: 'SETUP_PLAN_EXPIRED' }),
    );
    createCustomProvider.mockClear();
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration('d1'));

    await screen.findByText('Gmail');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Gmail' }));
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.review.start' }));

    await screen.findByText('setupMigration.done.applyFailed');
    expect(createCustomProvider).not.toHaveBeenCalled();
    expect(deviceLink.setEnabled).not.toHaveBeenCalled();
    expect(screen.getAllByText('setupMigration.failure.SETUP_PLAN_EXPIRED')).toHaveLength(3);
  });

  // Keys step (§2): a connection Main created with its copied key must not be created again
  // without it by this window. Minimal input: one provider handled by Main.
  it('leaves connections created with copied keys to Main', async () => {
    const { setupMigration } = installApi();
    setupMigration.preview.mockResolvedValueOnce({
      ...plan,
      plugins: [],
      settings: [],
      access: [],
      secrets: { key: 'secrets', state: 'ready', items: [{ kind: 'provider', ref: 'or', name: 'OpenRouter' }] },
    });
    setupMigration.apply.mockResolvedValueOnce({
      results: [
        { key: 'secrets', outcome: 'done' },
        { key: 'provider:or', outcome: 'done' },
      ],
      checklist: [{ id: 'provider-key:or', kind: 'provider-key', label: 'OpenRouter', ref: 'or', done: true }],
      handledKeys: ['provider:or'],
    });
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration('d1'));

    fireEvent.click(await screen.findByRole('button', { name: 'setupMigration.review.start' }));
    await waitFor(() =>
      expect(setupMigration.apply).toHaveBeenCalledWith({ planId: 'plan-1', keys: ['provider:or', 'secrets'], approvedPluginKeys: [] }),
    );
    await screen.findByText('setupMigration.done.finish');
    expect(createCustomProvider).not.toHaveBeenCalled();
  });

  it('continues with only a checklist so it is saved and shown on the done page', async () => {
    const { setupMigration } = installApi();
    setupMigration.preview.mockResolvedValueOnce({
      ...plan,
      plugins: [],
      settings: [],
      providers: [],
      access: [],
      checklist: [{ id: 'skill-manual:notes', kind: 'skill-manual', label: 'notes', ref: 'notes' }],
    });
    setupMigration.apply.mockResolvedValueOnce({
      results: [],
      checklist: [{ id: 'skill-manual:notes', kind: 'skill-manual', label: 'notes', ref: 'notes' }],
      handledKeys: [],
    });
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration('d1'));

    fireEvent.click(await screen.findByRole('button', { name: 'setupMigration.review.continue' }));
    await waitFor(() => expect(setupMigration.apply).toHaveBeenCalledWith({ planId: 'plan-1', keys: [], approvedPluginKeys: [] }));
    await screen.findByText('setupMigration.checklist.skill-manual.title');
  });

  it('explains why another computer cannot be read and lets the user try again', async () => {
    const { setupMigration } = installApi();
    setupMigration.preview.mockRejectedValueOnce(
      Object.assign(new Error('[SETUP_SOURCE_OUTDATED] update'), { code: 'SETUP_SOURCE_OUTDATED' }),
    );
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration('d1'));

    await screen.findByText('setupMigration.errors.SETUP_SOURCE_OUTDATED');
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.source.readAgain' }));
    await screen.findByText('Gmail');
  });
});
