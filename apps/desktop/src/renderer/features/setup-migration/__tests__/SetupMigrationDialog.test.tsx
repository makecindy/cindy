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
import { createInstance } from 'i18next';

import enCommon from '@/i18n/locales/en/common.json';

import type { SetupMigrationApplyResponse, SetupMigrationPlan } from '../../../../shared/setupMigration';
import { buildReviewGroups, SetupMigrationDialog } from '../SetupMigrationDialog';
import { SetupMigrationHost } from '../SetupMigrationHost';
import { SetupMigrationSection } from '@/components/settings/SetupMigrationSection';
import { closeSetupMigration, openSetupMigration } from '../setupMigrationStore';

const confirmSuggestion = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ mode: 'cloud', dataOwnerId: 'owner', isAuthenticated: true }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSuggestion }) }));
vi.mock('../SetupMigrationWalkthroughBar', () => ({ SetupMigrationWalkthroughBar: () => null }));

const createCustomProvider = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const translation = vi.hoisted(() => ({
  t: (key: string, _options?: Record<string, unknown>): string => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translation.t }),
}));
vi.mock('@/lib/customProviders', () => ({ createCustomProvider }));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: () => {} }));

afterEach(() => {
  vi.useRealTimers();
  act(() => closeSetupMigration());
  cleanup();
  translation.t = (key) => key;
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
  const deviceLink = { listDevices: vi.fn(async () => ({ devices: [{ deviceId: 'self', name: 'This Mac', isSelf: true }] })), setEnabled: vi.fn(async () => ({ remoteControlEnabled: true })), setKeepAwake: vi.fn() };
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

async function openAndChooseSource() {
  act(() => openSetupMigration());
  const radios = await screen.findAllByRole('radio');
  expect((screen.getByRole('button', { name: 'setupMigration.source.next' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(radios[0]);
  fireEvent.click(screen.getByRole('button', { name: 'setupMigration.source.next' }));
}

describe('SetupMigrationDialog', () => {
  it('confirms plugin permissions once, applies the selection and lists what is left', async () => {
    const { setupMigration, deviceLink } = installApi();
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration());

    await screen.findByText('Mac mini');
    // An offline computer is shown with its reason but cannot be picked.
    expect((screen.getAllByRole('radio')[1] as HTMLInputElement).disabled).toBe(true);
    expect(setupMigration.preview).not.toHaveBeenCalled();
    expect((screen.getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getAllByRole('radio')[0]);
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
    await openAndChooseSource();

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
    await openAndChooseSource();

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
    await openAndChooseSource();

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
    await openAndChooseSource();

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
    await openAndChooseSource();

    await screen.findByText('setupMigration.errors.SETUP_SOURCE_OUTDATED');
    fireEvent.click(screen.getByRole('button', { name: 'setupMigration.source.readAgain' }));
    await screen.findByText('Gmail');
  });
});

// #6473 B2: a saved-but-failed MCP must remain failed and never be created twice.
// Component tier, fake IPC with the real dialog/helper; old coverage only handled a provider.
// Minimal input: one MCP handled by Main with a credential failure. Not run in edit window.
it('shows a handled MCP failure without retrying renderer creation', async () => {
  const { setupMigration } = installApi();
  setupMigration.preview.mockResolvedValueOnce({
    ...plan, plugins: [], providers: [], settings: [], access: [], checklist: [],
    mcpServers: [{ key: 'mcp:docs', state: 'ready', server: { id: 'docs', name: 'Docs', transport: 'http', url: 'https://example.test/mcp', headers: {}, hasToken: true } }],
    secrets: { key: 'secrets', state: 'ready', items: [{ kind: 'mcp', ref: 'docs', name: 'Docs' }] },
  });
  setupMigration.apply.mockResolvedValueOnce({
    results: [
      { key: 'secrets', outcome: 'failed', code: 'CREDENTIAL_STORAGE_FAILED' },
      { key: 'mcp:docs', outcome: 'failed', code: 'PERMISSION_DENIED' },
    ],
    checklist: [], handledKeys: ['mcp:docs'],
  });
  render(<SetupMigrationDialog />);
  await openAndChooseSource();
  fireEvent.click(await screen.findByRole('button', { name: 'setupMigration.review.start' }));
  await screen.findByText('setupMigration.done.finish');
  expect(setupMigration.apply).toHaveBeenCalledTimes(1);
  expect(window.electronAPI.maker.createCustomMcpServer).not.toHaveBeenCalled();
  expect(screen.getByText('setupMigration.failure.CREDENTIAL_STORAGE_FAILED')).toBeTruthy();
  expect(screen.getByText('setupMigration.failure.PERMISSION_DENIED')).toBeTruthy();
});

// Settings-only entry regression, component tier. Old tests entered via a suggested ID.
// Smallest counterexamples: a login with one suggestion, or one selectable source.
// Real Host/Dialog paths; fake IPC and clock.
it('never offers migration on login or remount, while keeping the preferences host ready', async () => {
  const { setupMigration } = installApi();
  setupMigration.state.mockResolvedValue({ suggestion: { deviceId: 'd1', name: 'Mac mini' }, lastRun: null });
  confirmSuggestion.mockClear();
  vi.useFakeTimers();
  const first = render(<SetupMigrationHost />);
  await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
  first.unmount();
  render(<SetupMigrationHost />);
  await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
  expect(confirmSuggestion).not.toHaveBeenCalled();
  expect(setupMigration.preview).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(setupMigration.host.ready).toHaveBeenCalledTimes(2);
});

it('requires a fresh explicit selection on every open, even with only one source', async () => {
  const { setupMigration } = installApi();
  const available = (await setupMigration.sources())[0];
  setupMigration.sources.mockResolvedValue([available]);
  render(<SetupMigrationDialog />);
  act(() => openSetupMigration());
  const radio = await screen.findByRole('radio');
  expect((radio as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: 'setupMigration.source.next' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(radio);
  expect(setupMigration.preview).not.toHaveBeenCalled();
  act(() => closeSetupMigration());
  act(() => openSetupMigration());
  expect((await screen.findByRole('radio') as HTMLInputElement).checked).toBe(false);
  expect(setupMigration.preview).not.toHaveBeenCalled();
});

// Component tier: opening Settings must stay quiet, and cancelling an explicit
// migration must not read another device. Earlier Host-only coverage missed entry wiring.
it('opens only from the Settings action and can cancel without reading a source', async () => {
  const { setupMigration } = installApi();
  setupMigration.state.mockResolvedValue({ suggestion: { deviceId: 'd1', name: 'Mac mini' }, lastRun: null });
  render(<><SetupMigrationSection /><SetupMigrationHost /></>);
  await waitFor(() => expect(setupMigration.state).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(setupMigration.sources).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'setupMigration.settings.start' }));
  await screen.findAllByRole('radio');
  fireEvent.click(screen.getByRole('button', { name: 'setupMigration.cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(setupMigration.preview).not.toHaveBeenCalled();
});

it('keeps Next disabled after a source-list failure until the user reloads and selects', async () => {
  const { setupMigration, deviceLink } = installApi();
  setupMigration.sources.mockRejectedValueOnce(new Error('directory unavailable'));
  deviceLink.listDevices.mockRejectedValueOnce(new Error('directory unavailable'));
  render(<SetupMigrationDialog />);
  act(() => openSetupMigration());
  await screen.findByText('setupMigration.source.loadFailed');
  expect((screen.getByRole('button', { name: 'setupMigration.source.next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(setupMigration.preview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'setupMigration.source.reload' }));
  await screen.findAllByRole('radio');
  expect((screen.getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(false);
});

// Two activations in one render turn must create only one preview plan. A slow
// preview is the minimal race; button disabled state alone updates too late.
it('reads the selected source once when Next is activated twice before rendering', async () => {
  const { setupMigration } = installApi();
  render(<SetupMigrationDialog />);
  act(() => openSetupMigration());
  fireEvent.click((await screen.findAllByRole('radio'))[0]);
  const next = screen.getByRole('button', { name: 'setupMigration.source.next' });
  act(() => { next.click(); next.click(); });
  await screen.findByText('Gmail');
  expect(setupMigration.sources).toHaveBeenCalledTimes(1);
  expect(setupMigration.preview).toHaveBeenCalledTimes(1);
});

it.each(['NOT_FOUND', 'SETUP_SOURCE_UNAVAILABLE'])(
  'refreshes only after Main rejects the chosen source with %s, without substituting', async (code) => {
    const locale = createInstance();
    await locale.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: enCommon } } });
    translation.t = (key, options) => locale.t(key, options);
    const { setupMigration } = installApi();
    render(<SetupMigrationDialog />);
    act(() => openSetupMigration());
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    setupMigration.preview.mockRejectedValueOnce(Object.assign(new Error('source unavailable'), { code }));
    setupMigration.sources.mockResolvedValue([{ deviceId: 'd3', name: 'Another Mac', platform: 'darwin', online: true, lastSeenAt: null }]);
    fireEvent.click(screen.getByRole('button', { name: locale.t('setupMigration.source.next') }));
    await screen.findByText('Another Mac');
    expect(screen.getByText(locale.t('setupMigration.errors.SETUP_SOURCE_UNAVAILABLE', { name: 'Mac mini' }))).toBeTruthy();
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: locale.t('setupMigration.source.next') }) as HTMLButtonElement).disabled).toBe(true);
    expect(setupMigration.sources).toHaveBeenCalledTimes(2);
    expect(setupMigration.preview).toHaveBeenCalledTimes(1);
    expect(setupMigration.preview).toHaveBeenCalledWith('d1');
    expect(setupMigration.apply).not.toHaveBeenCalled();
  },
);

// Same-name source regression, component tier: the picker disambiguated identities
// but access, key-copy and SSH confirmations lost the suffix. Use real locale
// interpolation and the real Dialog; only IPC and the React translation hook are fake.
it('keeps the chosen same-name source in every confirmation description', async () => {
  const locale = createInstance();
  await locale.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: enCommon } } });
  translation.t = (key, options) => locale.t(key, options);
  const { setupMigration } = installApi();
  setupMigration.sources.mockResolvedValue([
    { deviceId: 'd1', name: 'Same Mac', platform: 'darwin', online: true, lastSeenAt: null },
    { deviceId: 'd2', name: 'Same Mac', platform: 'darwin', online: true, lastSeenAt: null },
  ]);
  const reviewPlan: SetupMigrationPlan = {
    ...plan,
    source: { deviceId: 'd2', name: 'Same Mac', platform: 'darwin' },
    access: [
      { key: 'access:remote-control', id: 'remote-control', state: 'ready' },
      { key: 'access:keep-awake', id: 'keep-awake', state: 'ready' },
    ],
    secrets: { key: 'secrets', state: 'ready', items: [{ kind: 'provider', ref: 'or', name: 'OpenRouter' }] },
    sshHosts: [{ key: 'ssh:web', id: 'web', displayName: 'Web', hostname: 'web.example.test', port: 22, user: 'deploy', state: 'ready' }],
  };
  setupMigration.preview.mockResolvedValue(reviewPlan);
  render(<SetupMigrationDialog />);
  act(() => openSetupMigration());
  const source = await screen.findByRole('radio', { name: /Same Mac \(2\)/ });
  expect(screen.getByRole('radio', { name: /Same Mac \(1\)/ })).toBeTruthy();
  fireEvent.click(source);
  fireEvent.click(screen.getByRole('button', { name: locale.t('setupMigration.source.next') }));
  await screen.findByText(locale.t('setupMigration.review.description', { name: 'Same Mac (2)' }));
  expect(setupMigration.preview).toHaveBeenCalledWith('d2');
  for (const key of [
    'setupMigration.review.access.remote-controlHint',
    'setupMigration.review.access.keep-awakeHint',
    'setupMigration.review.secrets.description',
    'setupMigration.review.sshDescription',
  ]) {
    expect(screen.getByText(locale.t(key, { name: 'Same Mac (2)' }))).toBeTruthy();
    expect(screen.queryByText(locale.t(key, { name: 'Same Mac' }))).toBeNull();
  }

  // Three-argument callers keep their previous presentation contract; the
  // display-only override must not rewrite the plan or its routing identity.
  const legacyGroups = buildReviewGroups(reviewPlan, locale.t, new Map());
  expect(legacyGroups.find((group) => group.id === 'access')?.rows[0].meta)
    .toBe(locale.t('setupMigration.review.access.remote-controlHint', { name: 'Same Mac' }));
  expect(legacyGroups.find((group) => group.id === 'secrets')?.description)
    .toBe(locale.t('setupMigration.review.secrets.description', { name: 'Same Mac' }));
  expect(legacyGroups.find((group) => group.id === 'ssh')?.description)
    .toBe(locale.t('setupMigration.review.sshDescription', { name: 'Same Mac' }));
  expect(reviewPlan.source).toEqual({ deviceId: 'd2', name: 'Same Mac', platform: 'darwin' });
});
