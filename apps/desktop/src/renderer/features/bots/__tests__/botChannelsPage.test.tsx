// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BotImConnectionListPayload,
  BotImConnectionView,
} from '../../../../shared/botImConnection';
import type { BotProfile } from '../botStore';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  navigate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null }));

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
import { BotSettingsTargetContext, type BotSettingsTarget } from '../botSettingsTarget';
import { localBotSettingsTarget } from '../localBotSettingsTarget';

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
  archiveLane?: ReturnType<typeof vi.fn>;
} = {};

beforeEach(() => {
  mocks.navigate.mockClear();
  mocks.toastError.mockClear();
  mocks.confirm.mockReset();
  mocks.confirm.mockResolvedValue(true);
  groupsApi = {};
  lanesApi = {};
});
afterEach(cleanup);

async function expandTaskList() {
  fireEvent.click(await screen.findByRole('button', { name: /^bots\.channels\.lanes\.expand:/ }));
}

describe('BotChannelsPage', () => {
  // 用户确认的飞书任务折叠合同；既有测试只覆盖打开与重启。
  // 最小输入：一条连接和一条专线。unit：真实组件点击后列表隐藏，展开保留原记录，无业务写入。
  it('starts collapsed, expands and restores only this connection task list without changing sessions', async () => {
    lanesApi = {
      listLanes: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes: [
        { sessionId: 'lane', kind: 'topic', chatId: 'group', threadId: 'topic', name: 'Release room', state: 'idle', lastActivityAt: null, contextMessageCount: 0 },
      ] })),
      resetLane: vi.fn(),
    };
    installApi({ connections: [connection({ channel: 'feishu' })] });
    render(<BotChannelsPage bot={mia} />);
    const label = { platform: 'bots.channels.platform.feishu' };
    expect(await screen.findByText(`bots.channels.lanes.title:${JSON.stringify(label)}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Release room/ })).toBeNull();
    await expandTaskList();
    expect(await screen.findByRole('button', { name: /^Release room/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `bots.channels.lanes.collapse:${JSON.stringify(label)}` }));
    expect(screen.queryByRole('button', { name: /^Release room/ })).toBeNull();
    expect(screen.getByText('bots.channels.platform.feishu')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `bots.channels.lanes.expand:${JSON.stringify(label)}` }));
    expect(await screen.findByRole('button', { name: /^Release room/ })).toBeTruthy();
    expect(lanesApi.resetLane).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  // 测试价值: 真实列表点击应打开普通任务页, 旧覆盖只有重启; 最小输入为一条渠道记录。
  // unit: 校验路由与副作用, 不需真实飞书连接。
  it('opens each IM record in the ordinary task page without restarting it', async () => {
    const lanes = ['owner-dm', 'group', 'topic', 'guest-dm'].map((kind) => ({
      sessionId: `s/${kind}`, kind, chatId: '-1001', threadId: 'thread-1', name: kind,
      state: 'idle', lastActivityAt: null, contextMessageCount: 0,
    }));
    lanesApi = {
      listLanes: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes })),
      resetLane: vi.fn(),
    };
    installApi({ connections: [connection({ channel: 'feishu', botId: 'bot/1' })] });
    render(<BotChannelsPage bot={{ ...mia, id: 'bot/1' }} />);
    await expandTaskList();
    for (const lane of lanes) {
      const name = lane.kind === 'owner-dm' ? 'bots.channels.lanes.ownerName' : lane.name;
      const open = await screen.findByRole('button', { name: new RegExp(`^${name}`) });
      fireEvent.click(open);
      expect(mocks.navigate).toHaveBeenLastCalledWith(`/cc-agent/${encodeURIComponent(lane.sessionId)}`);
    }
    expect(lanesApi.resetLane).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

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

  // 已确认的归档功能：真实列表按钮应调用本连接的归档 IPC，行内二次确认后移出、失败恢复，不打开确认窗。
  // 现有测试只有 reset；最小输入一条专线。unit：可观察列表结果和错误提示。
  it.each(['done', 'failed'] as const)('archives a channel task with %s outcome', async (outcome) => {
    const lanes = [{ sessionId: 's-topic', kind: 'topic', chatId: 'group', threadId: 'topic', name: 'Release room', state: 'idle', lastActivityAt: null, contextMessageCount: 0 }];
    mocks.confirm.mockResolvedValue(false);
    let finishArchive!: (value: { connectionId: string; lanes: typeof lanes }) => void;
    let failArchive!: (error: Error) => void;
    lanesApi = {
      listLanes: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes })),
      resetLane: vi.fn(),
      archiveLane: vi.fn(() => new Promise((resolve, reject) => {
        finishArchive = resolve;
        failArchive = reject;
      })),
    };
    installApi({ connections: [connection({ channel: 'feishu' })] });
    render(<BotChannelsPage bot={mia} />);
    await expandTaskList();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.lanes.archiveAria:{"lane":"Release room"}' }));
    expect(lanesApi.archiveLane).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.sessionMenu.archived' }));
    await waitFor(() => expect(lanesApi.archiveLane).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6', sessionId: 's-topic' }));
    expect(screen.queryByRole('button', { name: /^Release room/ })).toBeNull();
    await act(async () => {
      if (outcome === 'failed') failArchive(new Error('unavailable'));
      else finishArchive({ connectionId: 'a1b2c3d4e5f6', lanes: [] });
    });
    if (outcome === 'done') await waitFor(() => expect(screen.queryByRole('button', { name: /^Release room/ })).toBeNull());
    else {
      await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('bots.channels.lanes.archiveFailed'));
      expect(await screen.findByRole('button', { name: /^Release room/ })).toBeTruthy();
    }
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(lanesApi.resetLane).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  // SessionItem 的行内确认合同：误触不写入，4s 超时 / 点击外部撤销，允许列表归档失败后恢复。
  it.each(['outside', 'timeout'] as const)('dismisses inline archive confirmation on %s without changing the task', async (reason) => {
    const lanes = [{ sessionId: 's-topic', kind: 'topic', chatId: 'group', threadId: 'topic', name: 'Release room', state: 'idle', lastActivityAt: null, contextMessageCount: 0 }];
    lanesApi = {
      listLanes: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes })),
      archiveLane: vi.fn(),
      resetLane: vi.fn(),
    };
    installApi({ connections: [connection({ channel: 'feishu' })] });
    render(<BotChannelsPage bot={mia} />);
    await expandTaskList();
    const archive = await screen.findByRole('button', { name: 'bots.channels.lanes.archiveAria:{"lane":"Release room"}' });
    vi.useFakeTimers();
    try {
      fireEvent.click(archive);
      expect(screen.getByRole('button', { name: 'ccAgent.sidebar.sessionMenu.archived' })).toBeTruthy();
      if (reason === 'timeout') act(() => { vi.advanceTimersByTime(4000); });
      else fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('button', { name: 'ccAgent.sidebar.sessionMenu.archived' })).toBeNull();
      expect(screen.getByRole('button', { name: 'bots.channels.lanes.archiveAria:{"lane":"Release room"}' })).toBeTruthy();
      expect(lanesApi.archiveLane).not.toHaveBeenCalled();
      expect(lanesApi.resetLane).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  // 归档与既有 20 秒轮询竞态；最小输入为归档期间迟到的旧列表，旧测试没有在途读取。
  it('does not restore an archived task when an older list request arrives late', async () => {
    const lanes = [{ sessionId: 's-topic', kind: 'topic', chatId: 'group', threadId: 'topic', name: 'Release room', state: 'idle', lastActivityAt: null, contextMessageCount: 0 }];
    let finishOldRead!: (value: { connectionId: string; lanes: typeof lanes }) => void;
    lanesApi = {
      listLanes: vi.fn().mockResolvedValueOnce({ connectionId: 'a1b2c3d4e5f6', lanes })
        .mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve; })),
      resetLane: vi.fn(),
      archiveLane: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes: [] })),
    };
    installApi({ connections: [connection({ channel: 'feishu' })] });
    const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.useFakeTimers();
    try {
      await act(async () => { render(<BotChannelsPage bot={mia} />); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^bots\.channels\.lanes\.expand:/ })); });
      await act(async () => { vi.advanceTimersByTime(16); });
      const archive = screen.getByRole('button', { name: 'bots.channels.lanes.archiveAria:{"lane":"Release room"}' });
      await act(async () => { vi.advanceTimersByTime(20_000); });
      await act(async () => { fireEvent.click(archive); });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.sessionMenu.archived' })); });
      expect(screen.queryByRole('button', { name: /^Release room/ })).toBeNull();
      await act(async () => { finishOldRead({ connectionId: 'a1b2c3d4e5f6', lanes }); });
      expect(screen.queryByRole('button', { name: /^Release room/ })).toBeNull();
    } finally {
      vi.useRealTimers();
      visibility.mockRestore();
    }
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
    await expandTaskList();

    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.lanes.resetAria:{"lane":"Hulu Report"}' }));
    await waitFor(() =>
      expect(lanesApi.resetLane).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6', sessionId: 's-group' }),
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'bots.channels.lanes.resetConfirm.description:{"name":"Mia"}' }),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(lanesApi.resetLane).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
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
    await expandTaskList();

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

describe('BotChannelsPage with a window API that is not identity-stable', () => {
  it('reads the connection list once, however often it renders', async () => {
    const list = vi.fn(async () => ({ connections: [connection()] }));
    Object.assign(window, { electronAPI: {
      // A harness or proxying bridge hands out a fresh object per access.
      get botImConnection() { return { list, onChanged: () => () => undefined }; },
    } });
    render(<BotChannelsPage bot={mia} />);
    expect(await screen.findByText('bots.channels.platform.telegram')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20)); // real-wait: let a would-be render loop show itself
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('BotChannelsPage for a teammate on another computer', () => {
  /** The page talks to the other computer's API only; this window's own API must stay untouched. */
  function renderRemote(api: Record<string, unknown>, channels: Partial<BotSettingsTarget['channels']> = {}) {
    const own = installApi({ connections: [] });
    const target = {
      ...localBotSettingsTarget,
      kind: 'remote',
      deviceId: 'mac',
      deviceName: 'Studio',
      channels: { im: api, canEnterCredentials: false, wechat: null, x: null, ...channels },
    } as unknown as BotSettingsTarget;
    render(
      <BotSettingsTargetContext.Provider value={target}>
        <BotChannelsPage bot={mia} />
      </BotSettingsTargetContext.Provider>,
    );
    return own;
  }
  const remoteApi = (extra: Record<string, unknown> = {}) => ({
    list: vi.fn(async () => ({ connections: [connection()] })),
    add: vi.fn(async () => { throw new Error('credentials never travel'); }),
    remove: vi.fn(async () => ({ connections: [], archivedSessionIds: [] })),
    listAdoptable: vi.fn(async () => ({ bots: [] })),
    adopt: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    ...extra,
  });

  it('lists and removes connections through the other computer, never this window', async () => {
    const api = remoteApi();
    const own = renderRemote(api);
    expect(await screen.findByText('bots.channels.platform.telegram')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /bots\.channels\.removeAria/ }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6' }));
    expect(own.list).not.toHaveBeenCalled();
    expect(own.remove).not.toHaveBeenCalled();
  });

  // The merge combines archive with target-specific APIs. A remote target must
  // never borrow this computer's archive capability or write to its connections.
  it.each([false, true])('uses only the target archive capability (supported=%s)', async (supported) => {
    const lane = { sessionId: 'remote-lane', kind: 'group', chatId: 'remote-group', name: 'Remote room',
      state: 'idle', lastActivityAt: null, contextMessageCount: 0 };
    lanesApi = { listLanes: vi.fn(), resetLane: vi.fn(), archiveLane: vi.fn() };
    const archiveLane = vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes: [] }));
    const resetLane = vi.fn();
    const api = remoteApi({
      listLanes: vi.fn(async () => ({ connectionId: 'a1b2c3d4e5f6', lanes: [lane] })),
      resetLane,
      ...(supported ? { archiveLane } : {}),
    });
    const own = renderRemote(api);
    await expandTaskList();
    const open = await screen.findByRole('button', { name: /^Remote room/ });
    expect((open as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(open);
    expect(mocks.navigate).toHaveBeenLastCalledWith('/cc-agent/remote-lane?device=mac');
    const archive = screen.queryByRole('button', { name: 'bots.channels.lanes.archiveAria:{"lane":"Remote room"}' });
    if (supported) {
      expect(archive).toBeTruthy();
      fireEvent.click(archive!);
      fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.sessionMenu.archived' }));
      await waitFor(() => expect(archiveLane).toHaveBeenCalledWith({ id: 'a1b2c3d4e5f6', sessionId: 'remote-lane' }));
    } else expect(archive).toBeNull();
    expect(own.listLanes).not.toHaveBeenCalled();
    expect(own.archiveLane).not.toHaveBeenCalled();
    expect(resetLane).not.toHaveBeenCalled();
  });

  it('asks for credentials only on the other computer', async () => {
    const api = remoteApi();
    renderRemote(api);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('bots.channels.add.telegram.tokenLabel')).toBeNull();
    expect(within(dialog).getByText(/bots\.remoteSettings\.finishOnHost:.*Studio/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.add).not.toHaveBeenCalled();
  });

  it('still moves the personal bot that is already set up there, without any credential', async () => {
    const api = remoteApi({
      listAdoptable: vi.fn(async () => ({ bots: [{ channel: 'telegram', identity: '@mia_bot' }] })),
      adopt: vi.fn(async () => ({ connections: [connection()], connection: connection() })),
    });
    renderRemote(api);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.add.button' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('radio', { name: /bots\.channels\.add\.source\.existing/ });
    expect(within(dialog).queryByRole('radio', { name: 'bots.channels.add.source.manual' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'bots.channels.add.confirm' }));
    await waitFor(() => expect(api.adopt).toHaveBeenCalledWith({ botId: 'bot-1', channel: 'telegram' }));
    expect(api.add).not.toHaveBeenCalled();
  });

  it('shows the official X assignment of the other computer and changes it there, with sign-in left to that computer', async () => {
    const x = {
      get: vi.fn(async () => ({ available: true, enabled: true, connected: true, companionBotId: null as string | null })),
      setCompanion: vi.fn(async () => ({ companionBotId: 'bot-1' })),
    };
    renderRemote(remoteApi(), { x });
    fireEvent.click(await screen.findByRole('button', { name: 'bots.channels.officialX.bind' }));
    await waitFor(() => expect(x.setCompanion).toHaveBeenCalledWith(true, null));
    expect(await screen.findByRole('button', { name: 'bots.channels.officialX.remove' })).toBeTruthy();
  });

  it('asks to connect X on the other computer when its account is not signed in there', async () => {
    const x = {
      get: vi.fn(async () => ({ available: true, enabled: false, connected: false, companionBotId: null })),
      setCompanion: vi.fn(),
    };
    renderRemote(remoteApi(), { x });
    expect(await screen.findByText(/bots\.remoteSettings\.finishOnHost:.*Studio/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bots.channels.officialX.bind' })).toBeNull();
  });
});
