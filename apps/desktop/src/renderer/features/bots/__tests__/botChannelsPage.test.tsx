// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BotImConnectionListPayload,
  BotImConnectionView,
} from '../../../../shared/botImConnection';
import type { BotProfile } from '../botStore';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: mocks.confirm }),
}));

import { BotChannelsPage } from '../BotChannelsPage';

function profile(id: string, name: string): BotProfile {
  return {
    id,
    name,
    description: '',
    avatar: '🧭',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {} as BotProfile['capabilities'],
    createdAt: 1,
    sessions: [],
  } as BotProfile;
}

const mia = profile('bot-1', 'Mia');

function connection(overrides: Partial<BotImConnectionView> = {}): BotImConnectionView {
  return {
    id: 'a1b2c3d4e5f6',
    botId: 'bot-1',
    channel: 'telegram',
    createdAt: 1,
    botContextId: '111',
    status: { kind: 'connected', appId: '111' },
    identity: { username: 'mia_bot', ownerUserId: '42' },
    ...overrides,
  };
}

function installApi(payload: BotImConnectionListPayload) {
  const api = {
    list: vi.fn(async () => payload),
    add: vi.fn(async () => ({
      connections: [...payload.connections, connection({ id: 'ffffffffffff', botContextId: '222' })],
      connection: connection({ id: 'ffffffffffff', botContextId: '222' }),
    })),
    remove: vi.fn(async () => ({ connections: [], archivedSessionIds: ['lane-1'] })),
    onChanged: vi.fn(() => () => undefined),
    ...groupsApi,
    ...lanesApi,
  };
  Object.assign(window, { electronAPI: { botImConnection: api } });
  return api;
}

/** 群聊小节的 IPC(可选: 旧 preload 没有时整节不显示)。 */
let groupsApi: {
  listGroups?: ReturnType<typeof vi.fn>;
  setGroupActivation?: ReturnType<typeof vi.fn>;
} = {};

/** 隐藏任务小节的 IPC(可选: 旧 preload 没有时整节不显示)。 */
let lanesApi: {
  listLanes?: ReturnType<typeof vi.fn>;
  resetLane?: ReturnType<typeof vi.fn>;
} = {};

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  groupsApi = {};
  lanesApi = {};
});
afterEach(cleanup);

describe('BotChannelsPage', () => {
  it('lets the owner switch a known group to always-on per connection, and hides the section without groups', async () => {
    let activation: 'mention' | 'always' = 'mention';
    const groups = () => ({
      connectionId: 'a1b2c3d4e5f6',
      groups: [{ chatId: '-1001', chatName: 'Hulu Report', activation }],
    });
    groupsApi = {
      listGroups: vi.fn(async () => groups()),
      setGroupActivation: vi.fn(async (payload: { mode: 'mention' | 'always' }) => {
        activation = payload.mode;
        return groups();
      }),
    };
    installApi({ connections: [connection()] });
    render(<BotChannelsPage bot={mia} />);

    expect(await screen.findByText('Hulu Report')).toBeTruthy();
    expect(screen.getByText('bots.channels.groups.hint:{"name":"Mia"}')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'bots.channels.groups.mode.always' }));
    await waitFor(() =>
      expect(groupsApi.setGroupActivation).toHaveBeenCalledWith({
        id: 'a1b2c3d4e5f6',
        chatId: '-1001',
        mode: 'always',
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: 'bots.channels.groups.mode.always' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('starts one hidden task over through the connection it belongs to', async () => {
    const lanes = [
      { sessionId: 's-main', kind: 'owner-dm', chatId: null, threadId: null, name: null, state: 'idle', lastActivityAt: null, contextMessageCount: 0 },
      { sessionId: 's-group', kind: 'group', chatId: '-1001', threadId: null, name: 'Hulu Report', state: 'failed', lastActivityAt: null, contextMessageCount: 0 },
    ];
    lanesApi = {
      listLanes: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes })),
      resetLane: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes })),
    };
    installApi({ connections: [connection()] });
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.lanes.resetAria:{"lane":"Hulu Report"}' }));
    await waitFor(() =>
      expect(lanesApi.resetLane).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6', sessionId: 's-group' }),
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'bots.channels.lanes.resetConfirm.description:{"name":"Mia"}' }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(lanesApi.resetLane).toHaveBeenCalledTimes(1);
  });

  it('does not start a hidden task over when the owner cancels', async () => {
    mocks.confirm.mockResolvedValue(false);
    lanesApi = {
      listLanes: vi.fn(async () => ({
        connectionId: 'a1b2c3d4e5f6',
        lanes: [{ sessionId: 's-main', kind: 'owner-dm', chatId: null, threadId: null, name: null, state: 'running', lastActivityAt: null, contextMessageCount: 0 }],
      })),
      resetLane: vi.fn(),
    };
    installApi({ connections: [connection()] });
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.lanes.resetAria:{"lane":"bots.channels.lanes.ownerName"}' }));
    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'bots.channels.lanes.resetConfirm.ownerDescription:{"name":"Mia"}' }),
      ),
    );
    expect(lanesApi.resetLane).not.toHaveBeenCalled();
    expect(screen.getByText('bots.channels.lanes.empty:{"name":"Mia"}')).toBeTruthy();
  });

  it('does not render the groups section when the bot has not seen any group yet', async () => {
    groupsApi = {
      listGroups: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', groups: [] })),
      setGroupActivation: vi.fn(),
    };
    installApi({ connections: [connection()] });
    render(<BotChannelsPage bot={mia} />);
    await screen.findByText('@mia_bot');
    await waitFor(() => expect(groupsApi.listGroups).toHaveBeenCalled());
    expect(screen.queryByText('bots.channels.groups.title')).toBeNull();
  });

  it('shows the empty state and the external / shared-memory notes', async () => {
    installApi({ connections: [] });
    render(<BotChannelsPage bot={mia} />);

    expect(await screen.findByText('bots.channels.empty:{"name":"Mia"}')).toBeTruthy();
    expect(screen.getByText('bots.channels.externalNote:{"name":"Mia"}')).toBeTruthy();
    expect(screen.getByText('bots.channels.sharedMemoryNote:{"name":"Mia"}')).toBeTruthy();
  });

  it('lists only this teammate’s connections with identity and status, and removes after confirmation', async () => {
    const api = installApi({
      connections: [
        connection(),
        connection({
          id: 'b2c3d4e5f6a1',
          botId: 'bot-2',
          channel: 'feishu',
          service: 'lark',
          botContextId: 'cli_other',
          status: { kind: 'idle' },
          identity: { username: null, ownerUserId: null },
        }),
        connection({
          id: 'c3d4e5f6a1b2',
          channel: 'feishu',
          service: 'lark',
          botContextId: 'cli_a1b2c3d4e5f6',
          status: { kind: 'error', reason: 'app secret rejected' },
          identity: { username: null, ownerUserId: null },
        }),
      ],
    });
    render(<BotChannelsPage bot={mia} />);

    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('bots.channels.platform.telegram')).toBeTruthy();
    expect(within(rows[0]!).getByText('@mia_bot')).toBeTruthy();
    expect(within(rows[0]!).getByText(/bots\.channels\.status\.connected/)).toBeTruthy();
    expect(within(rows[1]!).getByText('bots.channels.platform.lark')).toBeTruthy();
    expect(within(rows[1]!).getByText('cli_a1b2••••e5f6')).toBeTruthy();
    expect(within(rows[1]!).getByText(/bots\.channels\.status\.error · app secret rejected/)).toBeTruthy();

    fireEvent.click(within(rows[0]!).getByRole('button', { name: /bots\.channels\.removeAria/ }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6' }));
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'bots.channels.removeConfirm.description:{"name":"Mia"}' }),
    );
    expect(await screen.findByText('bots.channels.empty:{"name":"Mia"}')).toBeTruthy();
  });

  it('adds a Telegram bot from its token and owner id', async () => {
    const api = installApi({ connections: [] });
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel'), {
      target: { value: 'not a token' },
    });
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.ownerLabel'), {
      target: { value: '4242' },
    });
    fireEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'bots.channels.add.errors.invalidToken',
    );
    expect(api.add).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel'), {
      target: { value: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith({
        botId: 'bot-1',
        channel: 'telegram',
        token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        ownerUserId: '4242',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(await screen.findByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });

  it('offers the bot already set up in Cindy first, and moves it without asking for credentials', async () => {
    const api = Object.assign(installApi({ connections: [] }), {
      listAdoptable: vi.fn(async () => ({ bots: [{ channel: 'telegram', identity: '@mia_bot' }] })),
      adopt: vi.fn(async () => ({ connections: [connection()], connection: connection() })),
    });
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    const existing = await within(dialog).findByRole('radio', { name: /bots\.channels\.add\.source\.existing/ });
    expect(existing.getAttribute('aria-checked')).toBe('true');
    expect(existing.textContent).toContain('@mia_bot');
    expect(within(dialog).queryByLabelText('bots.channels.add.telegram.tokenLabel')).toBeNull();

    // Entering new credentials stays one click away.
    fireEvent.click(within(dialog).getByRole('radio', { name: 'bots.channels.add.source.manual' }));
    expect(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel')).toBeTruthy();
    fireEvent.click(existing);
    fireEvent.click(within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }));
    await waitFor(() => expect(api.adopt).toHaveBeenCalledWith({ botId: 'bot-1', channel: 'telegram' }));
    expect(api.add).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('switches to the Feishu form and explains a connect failure in place', async () => {
    const api = installApi({ connections: [] });
    api.add.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'botImConnection:add': Error: [PRECONDITION_FAILED] CONNECT_FAILED: invalid app secret",
      ),
    );
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /bots\.channels\.platform\.feishu/ }));
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.feishu.appIdLabel'), {
      target: { value: 'cli_abc' },
    });
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.feishu.appSecretLabel'), {
      target: { value: 'secret' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }));

    await waitFor(() =>
      expect(api.add).toHaveBeenCalledWith({
        botId: 'bot-1',
        channel: 'feishu',
        appId: 'cli_abc',
        appSecret: 'secret',
        service: 'feishu',
      }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'bots.channels.add.errors.connectFailed:{"reason":"invalid app secret"}',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('tells the user when the same bot is already connected on this computer', async () => {
    const api = installApi({ connections: [] });
    api.add.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'botImConnection:add': Error: [PRECONDITION_FAILED] TOKEN_IN_USE: already connected",
      ),
    );
    render(<BotChannelsPage bot={mia} />);

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.tokenLabel'), {
      target: { value: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    });
    fireEvent.change(within(dialog).getByLabelText('bots.channels.add.telegram.ownerLabel'), {
      target: { value: '4242' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'bots.channels.add.errors.conflict',
    );
  });
});
