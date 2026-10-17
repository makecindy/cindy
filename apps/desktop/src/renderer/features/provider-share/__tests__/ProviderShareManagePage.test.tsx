// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import type { ProviderGroupConfig } from '../../../../shared/providerGroup';
import type { ProviderOwnUsageView, ProviderShareOwnerState, ProviderUsageHistoryView } from '../../../../shared/providerShare';
import { __testing as localGroupsTesting } from '../../provider-group/useLocalProviderGroups';
import { ProviderShareManagePage } from '../ProviderShareManagePage';
import {
  getProviderSharePendingRequests,
  getProviderSharePendingReshares,
  publishProviderShareOwnerState,
  resetProviderShareStoreForTests,
} from '../providerShareStore';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [
    { deviceId: 'self', name: "Magi's Mac Mini", isSelf: true },
    { deviceId: 'studio', name: 'Studio', isSelf: false },
  ],
}));
const localCatalog = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; source: string; auth: { method: string; native?: string } }>,
}));
const remoteCatalog = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; source: string; auth: { method: string; native?: string } }>,
  loading: false,
  error: null as string | null,
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => localCatalog }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => remoteCatalog }));
vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
  useOptionalAuthUser: () => ({ name: 'Magi', avatar: null }),
}));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));
// 分享的人一行的 `···` 菜单在 jsdom 里不好驱动 Radix 开合：摊平成普通按钮。
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const owned = (): ProviderShareOwnerState => ({
  ready: true,
  shares: [
    {
      shareId: 'share-1',
      providerId: 'xd',
      providerLabel: 'Cindy AI',
      createdAt: '2026-09-01T00:00:00Z',
      requests: [
        {
          requestId: 'req-1',
          displayName: 'Wang Yi',
          avatarUrl: null,
          region: 'global',
          pairingCode: '4827',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
      members: [
        {
          memberId: 'mem-1',
          displayName: 'Lizi',
          avatarUrl: null,
          region: 'global',
          status: 'active',
          joinedAt: '2026-09-28T00:00:00Z',
          lastUsedAt: Date.now() - 60_000,
          runningTasks: 1,
          models: [
            {
              kind: 'claude-code',
              providerId: 'xd',
              memberKey: 'device:studio:xd-2',
              model: 'claude-opus-5-5',
              turns: 96,
              inputTokens: 1_310_000,
              outputTokens: 188_000,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
              amount: { amount: 31.2, currency: 'USD' },
            },
          ],
        },
      ],
    },
    // 另一个供应商的分享不出现在这一页。
    { shareId: 'share-2', providerId: 'openai', providerLabel: 'OpenAI', createdAt: '2026-09-01T00:00:00Z', requests: [], members: [] },
  ],
});

const usageModel = (model: string, inputTokens: number, amount: number, memberKey: string | null = 'local') => ({
  kind: 'claude-code',
  providerId: 'xd',
  memberKey,
  model,
  turns: 3,
  inputTokens,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  amount: { amount, currency: 'USD' as const },
});

const ownUsage = (): ProviderOwnUsageView => ({
  providerId: 'xd',
  local: { deviceId: null, deviceName: null, lastUsedAt: Date.now() - 120_000, models: [usageModel('claude-sonnet-5', 41_000, 2.5)] },
  devices: [
    {
      deviceId: 'studio',
      deviceName: 'Old Studio Name',
      lastUsedAt: Date.now() - 3_600_000,
      models: [usageModel('claude-fable-5-1', 9_000, 1.25, 'device:studio:xd-2')],
    },
  ],
  relays: [],
});

const TODAY = '2026-10-17';
const usageDay = (day: string, model: string, inputTokens: number, amount: number, memberKey: string | null = 'local') => ({
  ...usageModel(model, inputTokens, amount, memberKey),
  day,
});

/** 按天明细(与 ownUsage / owned 同样的数)：你自己今天在本机、昨天经 Studio；Lizi 前天经 Studio。 */
const usageHistory = (): ProviderUsageHistoryView => ({
  providerId: 'xd',
  todayKey: TODAY,
  coverageStart: null,
  self: {
    lastUsedAt: Date.now() - 120_000,
    days: [
      usageDay(TODAY, 'claude-sonnet-5', 41_000, 2.5),
      usageDay('2026-10-16', 'claude-fable-5-1', 9_000, 1.25, 'device:studio:xd-2'),
    ],
  },
  relays: [],
  members: [{
    shareId: 'share-1',
    memberId: 'mem-1',
    lastUsedAt: Date.now() - 60_000,
    days: [{ ...usageDay('2026-10-15', 'claude-opus-5-5', 1_310_000, 31.2, 'device:studio:xd-2'), turns: 96, outputTokens: 188_000 }],
  }],
});

/** 「用量」块里第 index 行(按人表)的文字。 */
const usageRowText = (index: number) => screen.getAllByTestId('provider-usage-row')[index]!.textContent ?? '';

/** 这台电脑上 xd 的供应商组：本机、Studio、一台分享来的电脑。 */
const xdGroup: ProviderGroupConfig = {
  strategy: 'least',
  autoSwitch: true,
  members: [
    { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'xd', limit: 4, weight: 1, paused: false },
    { key: 'device:studio:xd-2', kind: 'device', agentDeviceId: 'studio', providerId: 'xd-2', limit: 4, weight: 1, paused: false },
    { key: 'share:share-9:xd', kind: 'share', agentDeviceId: 'share:share-9', providerId: 'xd', limit: 4, weight: 1, paused: false },
  ],
};
let localGroups: Record<string, ProviderGroupConfig> = {};

const command = vi.fn();

beforeEach(() => {
  resetProviderShareStoreForTests();
  localGroupsTesting.reset();
  localGroups = {};
  localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
  remoteCatalog.providers = [];
  remoteCatalog.loading = false;
  remoteCatalog.error = null;
  confirmSpy.mockClear();
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string }) => {
    if (cmd.action === 'owned') return owned();
    if (cmd.action === 'own-usage') return ownUsage();
    if (cmd.action === 'usage-history') return usageHistory();
    if (cmd.action === 'received') return [];
    if (cmd.action === 'get-run-limits') return {
      value: { perDevice: 16, total: 64 }, defaults: { perDevice: 16, total: 64 },
      isCustomized: false, customizedKeys: [], usage: { total: 0, devices: 0, largestDevice: 0 },
    };
    if (cmd.action === 'received-snapshot') return { ownerStamp: { dataOwnerId: null, ownerGeneration: 0 }, received: [], confirmedRegions: [] };
    if (cmd.action === 'set-member' || cmd.action === 'approve' || cmd.action === 'reject') return { ok: true };
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, {
    electronAPI: {
      providerShare: { command, onOwnedChanged: () => () => undefined, onReceivedChanged: () => () => undefined },
      // 页面上方的供应商组一块(由 ProviderGroupSection 自己的测试覆盖)：这里只给一个空组。
      providerGroup: {
        command: async (cmd: {
          action: string;
          providerId?: string;
          request?: { action: string; command?: { action: string } };
        }) => {
          if (cmd.action === 'list') return localGroups;
          if (cmd.action === 'remote-manage') {
            const action = cmd.request?.command?.action;
            if (action === 'owned') return owned();
            if (action === 'own-usage') return ownUsage();
            if (action === 'usage-history') return usageHistory();
            if (action === 'get-run-limits') return command(cmd.request?.command);
            if (action === 'approve' || action === 'reject') return { ok: true };
          }
          return { providerId: cmd.providerId, config: null, members: [] };
        },
        onChanged: () => () => undefined,
      },
    },
  });
});

afterEach(() => cleanup());

/** 「你自己」一行先出来；分享的人等分享读到后才有。 */
async function findMemberRow(memberId = 'mem-1'): Promise<HTMLElement> {
  return waitFor(() => {
    const row = screen.getAllByTestId('provider-usage-row')
      .find((item) => item.getAttribute('data-usage-party') === `member:${memberId}`);
    if (!row) throw new Error(`no usage row for ${memberId}`);
    return row;
  });
}

function renderPage(
  gate: 'on' | 'remote-off' | 'invocation-off' = 'on',
  options: { deviceId?: string; remoteProvider?: ProviderView } = {},
) {
  const onBack = vi.fn();
  const view = render(
    <ProviderShareManagePage
      providerId="xd"
      providerName="Cindy AI"
      providerIcon={null}
      gate={gate}
      deviceId={options.deviceId}
      remoteProvider={options.remoteProvider}
      onBack={onBack}
    />,
  );
  return { onBack, ...view };
}

describe('ProviderShareManagePage', () => {
  it('lists pending requests and members for this provider only, and publishes pending requests', async () => {
    renderPage();
    await findMemberRow();
    const rows = screen.getAllByTestId('provider-usage-row');
    expect(rows.filter((row) => row.getAttribute('data-usage-party')?.startsWith('member:'))).toHaveLength(1);
    expect(screen.getAllByTestId('provider-share-pending-row')).toHaveLength(1);
    expect(command).toHaveBeenCalledWith({ action: 'owned', range: 'all' });
    expect(getProviderSharePendingRequests().map((item) => item.request.requestId)).toEqual(['req-1']);
    expect(screen.getByText(/providerShare\.manage\.members\.statusRunning/)).toBeTruthy();
  });

  /*
   * 测试价值
   * - 生产入口与可观察结果：远程管理页构造待审批项；审批弹窗必须把决定发回目标电脑。
   * - Bug／规则依据：Greptile Review #6279 P1；供应商分享 §4 的跨电脑审批。
   * - 现有覆盖缺口：全局宿主覆盖了弹窗转发，但页面把待审批项交给弹窗前的 hostDeviceId 还没有断言。
   * - 最小失败输入：deviceId=studio 且有一条待审批申请。
   * - tier：unit；验证本地页面状态与跨电脑路由字段。
   * - 实测耗时：本文件单独运行约 3 秒。
   */
  it('keeps the managed computer on pending approvals', async () => {
    renderPage('on', { deviceId: 'studio' });
    await screen.findByTestId('provider-share-pending-row');
    expect(getProviderSharePendingRequests()[0]?.hostDeviceId).toBe('studio');
  });

  it("does not import another computer's watched approval into the managed computer snapshot", () => {
    const snapshot = {
      ...owned(),
      watchedRequests: [{
        request: {
          requestId: 'watched-on-other-host',
          displayName: 'Other',
          avatarUrl: null,
          region: 'global' as const,
          pairingCode: '1234',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        share: { shareId: 'other-share', providerId: 'xd', providerLabel: 'Cindy AI' },
        hostDeviceId: 'other-host',
      }],
    };
    publishProviderShareOwnerState(snapshot, { hostDeviceId: 'studio' });
    publishProviderShareOwnerState(snapshot, { hostDeviceId: 'studio' });
    expect(getProviderSharePendingRequests().map((item) => [item.request.requestId, item.hostDeviceId])).toEqual([['req-1', 'studio']]);
  });

  // 2026-10-16 用户反馈页面底部的「生成分享链接」太难找：它在标题一行，待处理紧跟标题，不再有底部的「分享」块。
  it('puts link creation in the title row and pending requests above the usage list', async () => {
    renderPage();
    const usageRow = (await screen.findAllByTestId('provider-usage-row'))[0]!;
    const heading = screen.getByRole('heading', { name: 'providerGroup.page.title:{"provider":"Cindy AI"}' });
    const create = screen.getByRole('button', { name: 'providerShare.manage.createLink' });
    expect(create.parentElement).toBe(heading.parentElement);
    const pending = screen.getAllByTestId('provider-share-pending-row')[0]!;
    expect(pending.compareDocumentPosition(usageRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/providerShare\.manage\.description/)).toBeNull();
  });

  // 2026-10-16 用户要求：「已分享的人」并进「用量」，同一个人只占一行。
  it('shows each person’s share status and actions on their usage row instead of a separate list', async () => {
    renderPage();
    const member = await findMemberRow();
    expect(member.textContent).toContain('Lizi');
    expect(member.textContent).toContain('providerShare.manage.members.statusRunning:{"count":1}');
    expect(member.textContent).toContain('providerShare.manage.members.joined');
    await waitFor(() => expect(usageRowText(1)).toContain('1.5M'));
    expect(within(member).getByRole('button', { name: /providerShare\.manage\.members\.moreAria.*Lizi/ })).toBeTruthy();
    expect(within(member).getByRole('button', { name: 'providerShare.manage.members.pause' })).toBeTruthy();
    expect(within(member).getByRole('button', { name: 'providerShare.manage.members.remove' })).toBeTruthy();
    // 你自己一行没有分享操作。
    const self = screen.getAllByTestId('provider-usage-row')[0]!;
    expect(within(self).queryByRole('button', { name: /members\.moreAria/ })).toBeNull();
    expect(self.textContent).not.toMatch(/members\.(statusActive|joined)/);
    expect(screen.queryByTestId('provider-share-member-row')).toBeNull();
    expect(screen.queryByText('providerShare.manage.members.title')).toBeNull();
  });

  it('dims a paused member and offers to resume sharing', async () => {
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') {
        const state = owned();
        state.shares[0]!.members[0]!.status = 'paused';
        return state;
      }
      if (cmd.action === 'usage-history') return usageHistory();
      if (cmd.action === 'received') return [];
      if (cmd.action === 'set-member') return { ok: true };
      throw new Error(`unexpected ${cmd.action}`);
    });
    renderPage();
    const member = await findMemberRow();
    expect(member.textContent).toContain('providerShare.manage.members.statusPaused');
    fireEvent.click(within(member).getByRole('button', { name: 'providerShare.manage.members.resume' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'resume' }),
    );
  });

  it('lists usage by person: you first (this computer and your other computers together), then the people shared with', async () => {
    renderPage();
    await findMemberRow();
    const rows = screen.getAllByTestId('provider-usage-row');
    expect(rows.map((row) => row.getAttribute('data-usage-party'))).toEqual(['self', 'member:mem-1']);
    expect(command).toHaveBeenCalledWith({ action: 'usage-history', providerId: 'xd' });
    // 所有时间的合计只在那台电脑是旧版本时才读。
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'own-usage' }));
    // 自己按人显示：当前登录账号的昵称，合计本机与 Studio(41k + 1k + 9k + 1k)。
    await waitFor(() => expect(usageRowText(0)).toContain('52.0k'));
    expect(usageRowText(0)).toContain('Magi');
    expect(usageRowText(0)).toContain('providerGroup.usage.selfTag');
    expect(usageRowText(0)).toContain('$3.75');
    // 分享的人的用量与分享状态在同一行。
    expect(usageRowText(1)).toContain('1.5M');
    expect(usageRowText(1)).toMatch(/members\.statusRunning/);
  });

  // 2026-10-17 用户确认原型：与设置 → 用量同一套，默认合计，可以只看一个人或一台电脑。
  it('splits usage by computer in the group and narrows everything to one person when their row is picked', async () => {
    localGroups = { xd: xdGroup };
    const history = usageHistory();
    history.relays = [
      { deviceId: 'studio', deviceName: null, lastUsedAt: Date.now() - 600_000, days: [usageDay(TODAY, 'claude-sonnet-5', 4_000, 0.5)] },
    ];
    // 加组内电脑之前记的用量：没有区分电脑。
    history.members[0]!.days.push(usageDay('2026-10-01', 'claude-sonnet-5', 2_000, 0.1, null));
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') return owned();
      if (cmd.action === 'usage-history') return history;
      if (cmd.action === 'received') return [];
      throw new Error(`unexpected ${cmd.action}`);
    });
    renderPage();
    // 建了组：多一个组内电脑的筛选；标题下不再有说明文字。
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'providerGroup.usage.filter.computerAria' })).toBeTruthy());
    expect(screen.queryByText(/providerGroup\.usage\.description/)).toBeNull();
    // 经 Studio 的组转来的受邀者任务：看不到具体的人，按那台电脑一行。
    await waitFor(() => expect(screen.getAllByTestId('provider-usage-row').map((row) => row.getAttribute('data-usage-party')))
      .toEqual(['self', 'member:mem-1', 'relay:studio']));
    expect(usageRowText(2)).toContain('providerGroup.usage.relayName:{"device":"Studio"}');

    const computers = () => screen.getAllByTestId('provider-usage-computer');
    expect(computers().map((row) => row.getAttribute('data-computer-key'))).toEqual([
      'local',
      'device:studio',
      'share:share:share-9',
      '',
    ]);
    expect(computers()[0]!.textContent).toContain('providerGroup.member.local');
    expect(computers()[0]!.textContent).toContain("Magi's Mac Mini");
    expect(computers()[1]!.textContent).toContain('Studio');
    // 这段时间没用过的那台也列出来，只是没有数字。
    expect(computers()[2]!.textContent).toContain('providerGroup.member.shareComputerUnknown');
    expect(computers()[2]!.textContent).not.toContain('%');
    expect(computers()[3]!.textContent).toContain('providerGroup.usage.unattributed');
    expect(computers()[0]!.textContent).toContain('%');

    // 点 Lizi：整块只看他，按电脑表跟着变(他没在本机上用过)。
    fireEvent.click(screen.getByRole('button', { name: 'Lizi' }));
    expect(screen.getByRole('button', { name: 'Lizi' }).getAttribute('aria-pressed')).toBe('true');
    expect(computers()[0]!.textContent).not.toContain('%');
    expect(computers()[1]!.textContent).toContain('%');
    // 再点一次回到所有人。
    fireEvent.click(screen.getByRole('button', { name: 'Lizi' }));
    expect(screen.getByRole('button', { name: 'Lizi' }).getAttribute('aria-pressed')).toBe('false');
    expect(computers()[0]!.textContent).toContain('%');
  });

  it('counts usage from multiple accounts on one physical computer once', async () => {
    localGroups = {
      xd: {
        ...xdGroup,
        members: [
          { ...xdGroup.members[0]! },
          { ...xdGroup.members[1]! },
          { ...xdGroup.members[2]!, hostDeviceId: 'kai-pc' },
          {
            ...xdGroup.members[2]!,
            key: 'share:share-10:xd',
            agentDeviceId: 'share:share-10',
            hostDeviceId: 'kai-pc',
          },
        ],
      },
    };
    const history = usageHistory();
    history.self.days.push(
      usageDay(TODAY, 'claude-sonnet-5', 2_000, 0.2, 'share:share-9:xd'),
      usageDay(TODAY, 'claude-sonnet-5', 3_000, 0.3, 'share:share-10:xd'),
    );
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') return owned();
      if (cmd.action === 'usage-history') return history;
      if (cmd.action === 'received') return [];
      throw new Error('unexpected action');
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('provider-usage-computer').map((row) => row.getAttribute('data-computer-key')))
      .toEqual(['local', 'device:studio', 'share-host:kai-pc']));
    // 两个账号合成一台：2k + 1k + 3k + 1k。
    expect(screen.getAllByTestId('provider-usage-computer')[2]!.textContent).toContain('7.0k');
  });

  it('filters by a picked day on the same daily data without reading it again', async () => {
    renderPage();
    await waitFor(() => expect(usageRowText(0)).toContain('52.0k'));
    const reads = () => command.mock.calls.filter(([cmd]) => (cmd as { action: string }).action === 'usage-history').length;
    const before = reads();
    fireEvent.change(screen.getByLabelText('usageHistory.range.date'), { target: { value: '2026-10-16' } });
    // 那天只有经 Studio 的 9k + 1k；Lizi 那天没用，不写 0。
    await waitFor(() => expect(usageRowText(0)).toContain('10.0k'));
    expect(usageRowText(1)).not.toContain('1.5M');
    expect(reads()).toBe(before);
  });

  it('shows a provider without a group as a group of just this computer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('provider-usage-model').length).toBeGreaterThan(0));
    expect(screen.getByTestId('provider-usage-summary')).toBeTruthy();
    // 只有一台：没有组内电脑的筛选与「按电脑」。
    expect(screen.queryByRole('combobox', { name: 'providerGroup.usage.filter.computerAria' })).toBeNull();
    expect(screen.queryByTestId('provider-usage-computer')).toBeNull();
    expect(screen.getAllByTestId('provider-usage-model').map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Opus 5.5')]),
    );
    expect(screen.getAllByText('$31.20').length).toBeGreaterThan(0);
    expect(screen.getByText('providerShare.manage.members.estimateNote')).toBeTruthy();
  });

  it('does not show zero when usage could not be read', async () => {
    const respond = command.getMockImplementation()!;
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'usage-history') throw new Error('boom');
      return respond(cmd);
    });
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toBe('providerGroup.usage.loadFailed');
    const rows = screen.getAllByTestId('provider-usage-row');
    expect(rows[0]!.getAttribute('data-usage-party')).toBe('self');
    expect(rows[0]!.textContent).not.toMatch(/\d(\.\d)?[kM]/);
  });

  // 那台电脑还没更新、不认识按天明细：退回所有时间的合计，时间固定为所有时间，不显示两张图。
  it('falls back to all-time totals when the provider computer has not been updated', async () => {
    const remoteCommand = vi.spyOn(window.electronAPI.providerGroup, 'command');
    remoteCommand.mockImplementation(async (cmd) => {
      if (cmd.action === 'remote-manage' && cmd.request.action === 'manage-share') {
        const action = cmd.request.command.action;
        if (action === 'usage-history') throw new Error('[UNSUPPORTED_CAPABILITY] Provider management requires an update');
        if (action === 'own-usage') return ownUsage();
        return command(cmd.request.command);
      }
      return { providerId: 'xd', config: null, members: [] };
    });
    renderPage('on', { deviceId: 'studio' });
    await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith({
      action: 'remote-manage',
      deviceId: 'studio',
      request: { action: 'manage-share', command: { action: 'own-usage', providerId: 'xd', range: 'all' } },
    }));
    expect(await screen.findByText(/providerGroup\.usage\.legacyNote/)).toBeTruthy();
    await waitFor(() => expect(usageRowText(0)).toContain('52.0k'));
    // 分享的人所有时间的合计来自 owned。
    expect(usageRowText(1)).toContain('1.5M');
    // 选不了时间：不摆出时间范围与日期。
    expect(screen.queryByRole('combobox', { name: 'usageHistory.range.ariaLabel' })).toBeNull();
    expect(screen.queryByLabelText('usageHistory.range.date')).toBeNull();
    expect(screen.queryByText('usageHistory.daily.title')).toBeNull();
  });

  it('pauses and removes a member after confirmation', async () => {
    renderPage();
    const member = await findMemberRow();
    fireEvent.click(within(member).getByRole('button', { name: 'providerShare.manage.members.pause' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'pause' }),
    );
    fireEvent.click(within(await findMemberRow()).getByRole('button', { name: 'providerShare.manage.members.remove' }));
    await waitFor(() =>
      expect(command).toHaveBeenCalledWith({ action: 'set-member', memberId: 'mem-1', status: 'remove' }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });

  // 转分享(provider-sharing.md §4.3)：成员想经自己的供应商组把这里的供应商转给别人用，主人逐人处理。
  it.each([undefined, 'studio'])('handles reshare decisions on the provider’s computer (%s)', async (deviceId) => {
    command.mockImplementation(async (cmd: { action: string }) => {
      if (cmd.action === 'owned') {
        const state = owned();
        state.shares[0]!.members[0]!.reshares = [
          { id: 'rs-pending', name: 'Carol', avatarUrl: null, state: 'pending', requestedAt: Date.now() - 1_000, decidedAt: null },
          { id: 'rs-approved', name: 'Dave', avatarUrl: null, state: 'approved', requestedAt: Date.now() - 9_000, decidedAt: Date.now() - 5_000 },
          { id: 'rs-rejected', name: 'Erin', avatarUrl: null, state: 'rejected', requestedAt: Date.now() - 9_000, decidedAt: Date.now() - 5_000 },
        ];
        return state;
      }
      if (cmd.action === 'usage-history') return usageHistory();
      if (cmd.action === 'received') return [];
      if (cmd.action === 'reshare-decide') return { ok: true };
      throw new Error(`unexpected ${cmd.action}`);
    });
    remoteCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
    const remoteCommand = vi.spyOn(window.electronAPI.providerGroup, 'command');
    if (deviceId) {
      remoteCommand.mockImplementation(async (cmd) => {
        if (cmd.action === 'remote-manage' && cmd.request.action === 'manage-share') {
          if (cmd.request.command.action === 'reshare-decide') return { ok: true };
          return command(cmd.request.command);
        }
        return { providerId: 'xd', config: null, members: [] };
      });
    }
    const expectDecision = async (id: string, decision: 'approve' | 'reject') => {
      const decidedCommand = { action: 'reshare-decide', id, decision };
      if (deviceId) {
        await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith({
          action: 'remote-manage', deviceId, request: { action: 'manage-share', command: decidedCommand },
        }));
        expect(command).not.toHaveBeenCalledWith(decidedCommand);
      } else {
        await waitFor(() => expect(command).toHaveBeenCalledWith(decidedCommand));
      }
    };
    renderPage('on', { deviceId });
    const pending = await screen.findByTestId('provider-share-reshare-row');
    expect(pending.textContent).toContain('Carol');
    expect(pending.textContent).toContain('providerShare.manage.reshare.applying:{"owner":"Lizi"}');
    expect(getProviderSharePendingReshares().map((item) => item.reshare.id)).toEqual(deviceId ? [] : ['rs-pending']);
    fireEvent.click(within(pending).getByRole('button', { name: 'providerShare.manage.reshare.approve' }));
    await expectDecision('rs-pending', 'approve');

    // 处理过的人列在这个成员那一行下方：已同意的可撤回，拒绝的可改为同意。
    await findMemberRow();
    const extra = document.querySelector('[data-usage-party-extra="member:mem-1"]') as HTMLElement;
    const decided = within(extra).getAllByTestId('provider-share-reshare-item');
    expect(decided.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Dave'),
      expect.stringContaining('Erin'),
    ]);
    fireEvent.click(within(decided[0]!).getByRole('button', { name: /providerShare\.manage\.reshare\.revokeAria/ }));
    await expectDecision('rs-approved', 'reject');
    fireEvent.click(within(decided[1]!).getByRole('button', { name: /providerShare\.manage\.reshare\.approveAria/ }));
    await expectDecision('rs-rejected', 'approve');
  });

  it('disables link creation and explains why when sharing is gated', async () => {
    renderPage('invocation-off');
    await findMemberRow();
    const create = screen.getByRole('button', { name: 'providerShare.manage.createLink' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('providerShare.manage.gateInvocation');
  });

  it('shows the Claude subscription email notice on the management page', async () => {
    localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'oauth', native: 'claude' } }];
    renderPage();
    await screen.findAllByTestId('provider-share-pending-row');
    expect(screen.getByTestId('provider-share-claude-email-callout').textContent).toContain(
      'providerShare.approve.calloutClaudeEmail',
    );
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not show the Claude subscription email notice for a non-Claude provider', async () => {
    localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
    renderPage();
    await screen.findAllByTestId('provider-share-pending-row');
    expect(screen.queryByTestId('provider-share-claude-email-callout')).toBeNull();
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(['empty', 'unrelated'])('blocks a local management approval when its provider directory is %s', async (catalog) => {
    localCatalog.providers = catalog === 'empty' ? [] : [{ id: 'openai', source: 'builtin', auth: { method: 'oauth' } }];
    renderPage();
    await screen.findAllByTestId('provider-share-pending-row');
    const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(command).not.toHaveBeenCalledWith({ action: 'approve', requestId: 'req-1' });
    const reject = screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'reject', requestId: 'req-1' }));
  });

  it.each(['empty', 'unrelated', 'loading', 'failed'])(
    'blocks a remote management approval when its provider directory is %s, even with an earlier provider snapshot',
    async (catalog) => {
      remoteCatalog.providers = catalog === 'empty' ? [] : [{
        id: catalog === 'unrelated' ? 'openai' : 'xd', source: 'builtin', auth: { method: 'oauth', native: 'claude' },
      }];
      remoteCatalog.loading = catalog === 'loading';
      remoteCatalog.error = catalog === 'failed' ? 'directory unavailable' : null;
      const remoteCommand = vi.spyOn(window.electronAPI.providerGroup, 'command');
      renderPage('on', {
        deviceId: 'studio',
        remoteProvider: {
          id: 'xd', name: 'Cindy AI', source: 'builtin', agents: ['claude-code'],
          auth: { method: 'oauth', native: 'claude' }, routing: {}, models: {}, connected: true,
        },
      });
      await screen.findAllByTestId('provider-share-pending-row');
      const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      fireEvent.click(approve);
      expect(remoteCommand).not.toHaveBeenCalledWith({
        action: 'remote-manage',
        deviceId: 'studio',
        request: { action: 'manage-share', command: { action: 'approve', requestId: 'req-1' } },
      });
      const reject = screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement;
      expect(reject.disabled).toBe(false);
      fireEvent.click(reject);
      await waitFor(() => expect(remoteCommand).toHaveBeenCalledWith({
        action: 'remote-manage',
        deviceId: 'studio',
        request: { action: 'manage-share', command: { action: 'reject', requestId: 'req-1' } },
      }));
    },
  );

  it('blocks approval on a remote management page until the provider directory is ready', async () => {
    remoteCatalog.loading = true;
    const view = renderPage('on', { deviceId: 'studio' });
    await screen.findAllByTestId('provider-share-pending-row');
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement).disabled).toBe(false);

    remoteCatalog.loading = false;
    remoteCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'oauth', native: 'claude' } }];
    view.rerender(
      <ProviderShareManagePage
        providerId="xd"
        providerName="Cindy AI"
        providerIcon={null}
        gate="on"
        deviceId="studio"
        onBack={view.onBack}
      />,
    );
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByTestId('provider-share-claude-email-callout')).toBeTruthy();
  });
});
