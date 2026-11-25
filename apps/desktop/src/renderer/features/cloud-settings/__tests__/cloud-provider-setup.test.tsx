// @vitest-environment jsdom
// The cloud providers page uses the local add-provider wizard and connection form against the
// instance: secret-free steps go over the private channel, keys only in the setup ticket.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { CLOUD_PROVIDER_SETTINGS_CHANNEL } from '../../../../shared/cloudProviderSettings';
import type { ManagementItem } from '../../../../shared/settingsManagement';
import type { CloudSettingsClient } from '../client';
import { CloudProvidersSettings } from '../CloudProvidersSettings';
import { splitProviderSecrets } from '../cloudProviderSetup';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toasts }));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [], loading: false, error: null, unsupported: false }),
}));
vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({
  useDeviceProviderSubscriptionCard: () => null,
}));
vi.mock('@/features/provider-share/providerShareStore', () => ({
  useProviderSharePendingRequests: () => [],
  useProviderShareReceived: () => ({ received: [], loaded: true }),
  ensureProviderShareReceivedStarted: () => undefined,
  requestProviderShareJoin: () => undefined,
}));
vi.mock('@/components/icons/ProviderLogoMark', () => ({
  hasProviderLogo: () => false,
  ProviderLogoMark: () => null,
}));

const KEY = 'typed-by-user';
const model = (id: string) => ({ id, name: id, contextWindow: 200_000, efforts: [] });
const providers = [
  {
    id: 'openai',
    name: 'OpenAI',
    source: 'builtin',
    agents: ['codex'],
    auth: { method: 'oauth' },
    routing: {},
    models: { codex: [model('gpt-a')] },
    connected: false,
    removed: false,
  },
  {
    id: 'web-1',
    name: 'My gateway',
    source: 'user',
    agents: ['codex'],
    auth: { method: 'apiKey' },
    routing: {
      codex: { upstream: 'https://gateway.example.test/v1', wireProtocol: 'openai-chat' },
    },
    models: { codex: [model('m-1')] },
    connected: true,
  },
  {
    id: 'xd',
    name: 'Cindy AI · Team',
    source: 'builtin',
    agents: ['codex'],
    auth: { method: 'apiKey' },
    routing: {},
    models: { codex: [model('xd-1')] },
    connected: true,
  },
  {
    id: 'org-1',
    name: 'Team gateway',
    source: 'organization',
    agents: ['pi'],
    auth: { method: 'apiKey' },
    routing: {},
    models: { pi: [model('o-1')] },
    connected: true,
  },
] as unknown as ProviderView[];
const presets = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    authMethod: 'apiKey',
    runtimes: {
      codex: {
        baseUrl: 'https://api.deepseek.test/v1',
        wireProtocol: 'openai-chat',
        models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
      },
    },
  },
];
const setupItem = {
  id: 'setup:apply',
  label: 'Provider setup',
  status: 'available',
  group: 'management.providerSetup',
  actions: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      label: 'management.actions.connect',
      intent: 'connect',
      expiresAt: 9e15,
      fields: [
        { name: 'stage', label: 'stage', kind: 'text', required: true, maxLength: 64 },
        { name: 'secrets', label: 'secrets', kind: 'password', required: false, maxLength: 16384 },
      ],
    },
  ],
} as unknown as ManagementItem;

afterEach(cleanup);

function setup({
  holdFirstRun = false,
  holdFirstList = false,
}: { holdFirstRun?: boolean; holdFirstList?: boolean } = {}) {
  let releaseList = () => undefined as void;
  const heldList = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stages: Array<{ kind: string; request: Record<string, unknown> }> = [];
  const invoke = vi.fn(
    async (_device: string, channel: string, [request]: [Record<string, unknown>]) => {
      if (channel !== CLOUD_PROVIDER_SETTINGS_CHANNEL) throw Error(`UNEXPECTED ${channel}`);
      const receipt = (value: unknown, catalogChanged = false) => ({
        ok: true,
        ownerGeneration: 3,
        catalogChanged,
        value,
      });
      switch (request.op) {
        case 'list':
          return {
            version: 1,
            ownerGeneration: 3,
            providers,
            providerOrder: ['web-1', 'xd', 'org-1'],
            visibility: { status: 'ready', revision: 'r1', overrides: {} },
            supportedOps: [
              'list',
              'presets',
              'cli-scan',
              'provider-view',
              'custom-create',
              'custom-update',
              'models-fetch',
              'setup-stage',
              'setup-result',
              'xd',
              'byok',
            ],
          };
        case 'presets':
          return receipt({ presets });
        case 'xd':
          return receipt({ state: 'ok', source: 'server', accountTier: null });
        case 'byok':
          return receipt({
            state: 'ready',
            providers: [{ providerId: 'org-1', state: 'pending' }],
          });
        case 'cli-scan':
          return receipt({ detections: [] });
        case 'provider-view':
          return receipt(providers.find((p) => p.id === request.providerId));
        case 'setup-stage':
          stages.push({ kind: request.kind as string, request: request.request as never });
          return receipt({ stageId: `00000000-0000-4000-8000-00000000000${stages.length}` });
        case 'setup-result': {
          const stage = stages[Number(String(request.stageId).slice(-1)) - 1]!;
          return receipt({
            status: 'done',
            value:
              stage.kind === 'models-fetch'
                ? { ok: true, models: [{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] }
                : stage.kind === 'detect'
                  ? { candidates: [], reason: 'insufficient_evidence' }
                  : { ok: true },
          });
        }
        default:
          return receipt(null, true);
      }
    },
  );
  Object.assign(window, {
    electronAPI: new Proxy(
      { deviceLink: { invoke }, openExternal: async () => ({ success: true }) },
      {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          if (key === 'providerShare')
            return { command: async () => [], onReceivedChanged: () => () => undefined };
          throw Error(`LOCAL_API_FORBIDDEN ${String(key)}`);
        },
      },
    ),
  });
  const runs: Array<Record<string, string>> = [];
  let lists = 0;
  const manage = vi.fn(
    async (request: {
      operation: string;
      values?: Record<string, string>;
      operationId?: string;
    }) => {
      // Every list issues fresh single-use tickets, as the instance does.
      if (request.operation === 'list') {
        lists += 1;
        // The page's first ticket list is still on its way.
        if (holdFirstList && lists === 1) await heldList;
        const ticket = {
          ...setupItem.actions[0]!,
          id: `00000000-0000-4000-8000-${String(lists).padStart(12, '0')}`,
        };
        return { kind: 'page', section: 'providers', items: [{ ...setupItem, actions: [ticket] }] };
      }
      if (request.operation === 'run') {
        runs.push(request.values!);
        // The instance is still working on the first ticket operation.
        if (holdFirstRun && runs.length === 1) await held;
      }
      return { kind: 'operation', operationId: request.operationId, phase: 'succeeded' };
    },
  );
  render(
    <CloudProvidersSettings
      client={{ manage } as unknown as CloudSettingsClient}
      online
      active
      name="Cloud one"
      deviceId="cloud-device-000000000000000000000001"
    />,
  );
  return { invoke, manage, stages, runs, release, releaseList };
}

describe('cloud provider setup with the local wizard', () => {
  it('adds a preset connection with model selection, keeping the key in the ticket', async () => {
    const { invoke, stages, runs } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /settings.providers.addProvider/ }));
    const dialog = await screen.findByRole('dialog');
    // The local wizard's catalog and steps, read from the instance.
    expect(within(dialog).getByRole('button', { name: 'settings.providers.wizard.customAction' })).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole('button', { name: /DeepSeek/ }));
    expect(within(dialog).getByText('settings.providers.wizard.stepModels')).toBeTruthy();
    fireEvent.change(within(dialog).getByPlaceholderText('sk-…'), { target: { value: KEY } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.providers.wizard.next' }));
    // Step 3 lists the models the instance discovered with the key.
    fireEvent.click(await within(dialog).findByRole('button', { name: /DeepSeek Reasoner/ }));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.providers.wizard.finish' }),
    );
    await waitFor(() =>
      expect(stages.map((stage) => stage.kind)).toEqual(['models-fetch', 'custom-create']),
    );
    const created = stages[1]!.request.config as {
      name: string;
      runtimes: {
        codex: { baseUrl: string; models: Array<{ id: string; defaultEnabled?: boolean }> };
      };
    };
    expect(created.name).toBe('DeepSeek');
    expect(created.runtimes.codex.baseUrl).toBe('https://api.deepseek.test/v1');
    expect(created.runtimes.codex.models.map((m) => [m.id, m.defaultEnabled])).toEqual([
      ['deepseek-chat', undefined],
      ['deepseek-reasoner', undefined],
    ]);
    // The key travels only in the setup ticket, never over DeviceLink.
    expect(JSON.stringify(invoke.mock.calls)).not.toContain(KEY);
    expect(runs.map((values) => JSON.parse(values.secrets!))).toEqual([
      { apiKey: KEY },
      { keys: { codex: KEY } },
    ]);
    await waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('settings.providers.wizard.createdToast'),
    );
  });

  it('edits a custom connection in the local form with its full instance configuration', async () => {
    const { invoke } = setup();
    fireEvent.keyDown(
      await screen.findByRole('button', { name: 'settings.providers.detail.moreActionsAria' }),
      { key: 'ArrowDown' },
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'settings.providers.custom.editAria' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      (within(dialog).getByDisplayValue('https://gateway.example.test/v1') as HTMLInputElement)
        .value,
    ).toBe('https://gateway.example.test/v1');
    expect(invoke.mock.calls.map((call) => call[2][0].op)).toContain('provider-view');
  });
});

describe('adding before the ticket list is read', () => {
  it('opens the local wizard instead of the older runtimes dialog', async () => {
    const { releaseList } = setup({ holdFirstList: true });
    fireEvent.click(await screen.findByRole('button', { name: /settings.providers.addProvider/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByRole('textbox', { name: 'settings.providers.wizard.searchPlaceholder' }),
    ).toBeTruthy();
    releaseList();
  });
});

describe('cloud provider setup while a keyed detection is running', () => {
  // The page polls the instance until it is idle; the clock follows real time so the dialog still
  // renders, and the test advances it to let that poll observe the running detection.
  afterEach(() => {
    vi.useRealTimers();
  });
  it('saves after the detection instead of failing on the busy instance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { stages, runs, release } = setup({ holdFirstRun: true });
    fireEvent.click(await screen.findByRole('button', { name: /settings.providers.addProvider/ }));
    fireEvent.click(
      await within(await screen.findByRole('dialog')).findByRole('button', {
        name: /settings.providers.wizard.customAction/,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(
      within(dialog).getByPlaceholderText('settings.providers.custom.fields.namePlaceholder'),
      { target: { value: 'Gateway two' } },
    );
    fireEvent.change(
      within(dialog).getByPlaceholderText('settings.providers.custom.fields.baseUrlPlaceholder'),
      { target: { value: 'https://two.example.test/v1' } },
    );
    fireEvent.change(
      within(dialog).getByPlaceholderText('settings.providers.custom.fields.apiKeyPlaceholder'),
      { target: { value: KEY } },
    );
    // The form detects the provider with the key; that ticket operation is still running.
    await waitFor(() => expect(runs).toHaveLength(1));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.providers.connection.manualAdd' }),
    );
    fireEvent.change(within(dialog).getByLabelText('settings.providers.connection.manualId'), {
      target: { value: 'model-two' },
    });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.providers.custom.fields.addModel' }),
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'settings.providers.connection.saveProvider' }),
    );
    // The save reaches the instance while the detection still holds it.
    await waitFor(() => expect(stages.map((stage) => stage.kind)).toContain('custom-create'), {
      timeout: 3000,
    });
    // Its ticket run waits while the instance is still running the detection.
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(runs).toHaveLength(1);
    release();
    await waitFor(
      () => expect(toasts.success).toHaveBeenCalledWith('settings.providers.custom.toast.created'),
      { timeout: 3000 },
    );
    expect(stages.map((stage) => stage.kind)).toEqual(['detect', 'custom-create']);
    expect(runs.map((values) => JSON.parse(values.secrets!))).toEqual([
      { apiKey: KEY },
      { keys: { pi: KEY } },
    ]);
  });
});

describe('cloud provider headers like the local page', () => {
  const select = async (name: string) => {
    const row = (await screen.findAllByText(name)).find((node) =>
      node.closest('.provider-settings-sortable-row'),
    );
    fireEvent.click(row!);
  };
  const openMenu = async () =>
    fireEvent.keyDown(
      await screen.findByRole('button', { name: 'settings.providers.detail.moreActionsAria' }),
      { key: 'ArrowDown' },
    );

  it("signs in the instance's own Codex from the OpenAI header", async () => {
    const { stages, runs } = setup();
    await select('OpenAI');
    expect(await screen.findByText(/^settings.providers.openai.subtitle/)).toBeTruthy();
    expect(screen.getByText('settings.providers.pill.disconnected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.openai.connect' }));
    await waitFor(() =>
      expect(stages.at(-1)).toEqual({ kind: 'native-login', request: { agent: 'codex' } }),
    );
    expect(runs.at(-1)).toEqual({ stage: expect.any(String) });
  });

  it('offers the custom connection edit and the configured state', async () => {
    setup();
    expect(await screen.findByText('settings.providers.pill.configured')).toBeTruthy();
    await openMenu();
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'settings.providers.pill.rename',
      'settings.providers.custom.editAria',
      'settings.providers.menu.disableProvider',
      'settings.providers.custom.deleteAria',
    ]);
  });

  it('refreshes the organization configuration and hides the model refresh', async () => {
    const { invoke } = setup();
    await select('Team gateway');
    expect(await screen.findByText('settings.providers.byok.pending')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.byok.refresh' }));
    await waitFor(() =>
      expect(invoke.mock.calls.map((call) => call[2][0])).toContainEqual({
        op: 'byok',
        action: 'retry',
        ownerGeneration: 3,
      }),
    );
    expect(
      screen.queryByRole('button', { name: 'settings.providers.models.refreshAria' }),
    ).toBeNull();
  });

  it('manages Cindy AI credentials on the instance without exposing the key', async () => {
    const { invoke } = setup();
    await select('Cindy AI · Team');
    await openMenu();
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'settings.providers.xd.sync.refresh',
      'settings.providers.xd.sync.rotate',
      'settings.providers.button.disconnect',
      'settings.providers.menu.disableProvider',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.providers.xd.sync.rotate' }));
    await waitFor(() =>
      expect(invoke.mock.calls.map((call) => call[2][0])).toContainEqual({
        op: 'xd',
        action: 'rotate',
        ownerGeneration: 3,
      }),
    );
  });
});

describe('cloud provider secrets', () => {
  it('moves request headers and filled keys out of the configuration', () => {
    const split = splitProviderSecrets(
      {
        id: 'web-1',
        name: 'G',
        runtimes: {
          codex: { baseUrl: 'https://g.test', models: [], headers: { 'X-Org': 'o' } },
          pi: { baseUrl: 'https://g.test', models: [] },
        },
      },
      { codex: 'k', pi: '' },
    );
    expect(split.config.runtimes.codex).toEqual({ baseUrl: 'https://g.test', models: [] });
    expect(split.secrets).toEqual({
      keys: { codex: 'k' },
      runtimeHeaders: { codex: { 'X-Org': 'o' } },
    });
    expect(
      splitProviderSecrets({
        id: 'x',
        name: 'x',
        runtimes: { codex: { baseUrl: 'u', models: [] } },
      }).secrets,
    ).toBeNull();
  });
});
