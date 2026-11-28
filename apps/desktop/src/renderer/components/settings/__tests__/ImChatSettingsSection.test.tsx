// @vitest-environment jsdom
/**
 * 个人 IM 机器人的「群聊」卡片(2026-11-23 飞书按群设置; 2026-11-24 主人裁决: 版式照微信插件的会话设置,
 * 推广到各平台, 并加「群成员也能提问」与暂停后的「恢复」)。
 *
 * 依据: 群里任何成员 @ 机器人都会用这个群的权限档, 所以把一个群改成「完全访问」前必须经 Cindy 的确认框写明
 * 是哪个群, 取消就不保存; 权限第一项「跟随」清掉覆写。跟随的群在控件里显示正在继承的模型与推理强度, 只改
 * 推理强度也要存成这个群的设置。收起时只读概要(群数、单独设置数与头像), 第一次展开才读完整列表。行右边
 * 一句状态写明单独设了什么, 群成员被暂停时用警示色; 勾「群成员也能提问」即保存, 暂停时给「恢复」。
 * 生产入口: ImChatSettingsCard 经 preload 的 imChatSettingsList / Set / ResumeMembers 读写。
 * 缺口: 主进程用例只覆盖存储与建任务读取, 没有界面的确认、继承显示、排序与暂停恢复。
 * 最小失败输入: 展开一个跟随的群, 依次选「完全访问」取消、确认; 只改推理强度; 列出一个单独设置的群与
 * 二十一个跟随的群; 一个已暂停的群点「恢复」。
 * tier: unit(jsdom; 模型选择器替身只暴露回调)。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ImChatSettingsList, ImChatSettingsView } from '../../../../shared/imChatSettings';

const state = vi.hoisted(() => ({
  confirm: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
  resume: vi.fn(),
  defaultsGet: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string, opts?: { name?: string; count?: number; total?: number }) =>
    opts?.name ? `${key}:${opts.name}` : opts?.count !== undefined ? `${key}:${opts.count}`
      : opts?.total !== undefined ? `${key}:${opts.total}` : key;
  return { useTranslation: () => ({ t, i18n: { exists: () => true } }) };
});
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({ useModelPickerAgents: () => ['claude-code', 'codex', 'pi'] }));
vi.mock('@/hooks/useModelRouteDevices', () => ({ useModelRouteDevices: () => ({ devices: [] }) }));
vi.mock('@/features/model-groups/modelGroupsClient', () => ({
  useModelGroups: () => ({ config: { routes: [], defaultRouteId: null } }),
  previewModelGroup: vi.fn(),
}));
vi.mock('../useSettingsPluginEngines', () => ({
  useSettingsPluginEngines: () => ({
    engines: [
      {
        key: 'cindy-antigravity:antigravity',
        providerId: 'acp-plugin:cindy-antigravity:antigravity',
        ghostId: 'cindy-antigravity',
        harnessId: 'antigravity',
        name: 'Antigravity',
        availability: { state: 'available' },
        models: [{ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', efforts: ['low', 'high'] }],
        permissionModes: [
          { id: 'ask', displayName: 'Default permissions' },
          { id: 'bypassPermissions', displayName: 'Full access' },
        ],
      },
    ],
    readCatalogue: vi.fn(),
    hasSources: true,
  }),
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ modelId, effort, onEffortChange, pluginEngines }: {
    modelId: string;
    effort: string;
    onEffortChange: (effort: string) => void;
    pluginEngines?: {
      active: { providerId: string; modelId: string; effort?: string } | null;
      onSelect: (selection: { providerId: string; modelId: string; effort?: string; deviceId?: string }) => void;
    };
  }) => (
    <>
      <span data-testid="model-trigger">{`${modelId}|${effort}`}</span>
      <span data-testid="plugin-engine-active">
        {pluginEngines?.active ? `${pluginEngines.active.providerId}|${pluginEngines.active.modelId}|${pluginEngines.active.effort ?? ''}` : 'none'}
      </span>
      <button type="button" onClick={() => onEffortChange('low')}>pick-low-effort</button>
      {pluginEngines && (
        <button
          type="button"
          onClick={() => pluginEngines.onSelect({
            providerId: 'acp-plugin:cindy-antigravity:antigravity',
            modelId: 'gemini-3-pro',
          })}
        >
          pick-antigravity
        </button>
      )}
    </>
  ),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { ImChatSettingsCard } from '../ImChatSettingsSection';

const FOLLOWING: ImChatSettingsView = {
  chatId: 'oc_group1',
  kind: 'group',
  name: '项目群',
  avatarUrl: 'https://s1-imfile.feishucdn.com/avatar-1',
  project: null,
  route: null,
  permissionMode: null,
  members: false,
  membersPaused: false,
};

function listOf(chats: ImChatSettingsView[]): ImChatSettingsList {
  return { channel: 'feishu', connected: true, source: 'remote', listError: null, chats, projects: [], channelProject: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 下拉框打开时把选中项滚进可见区域; jsdom 没有这个方法(同 select.test)。
  Element.prototype.scrollIntoView = vi.fn();
  state.list.mockResolvedValue(listOf([FOLLOWING]));
  state.defaultsGet.mockResolvedValue({
    agentKind: 'codex',
    groupPermissionMode: 'auto',
    permissionMode: 'auto',
    agents: {
      'claude-code': { providerId: null, model: 'claude-opus-4-8', effort: 'high' },
      codex: { providerId: 'openai', model: 'gpt-6.2-sol', effort: 'high' },
      pi: { providerId: null, model: 'claude-sonnet-5', effort: 'high' },
    },
  });
  state.set.mockImplementation(async (_channel: string, chatId: string, patch: Record<string, unknown>) => ({
    ...FOLLOWING,
    chatId,
    avatarUrl: null,
    route: (patch.route as ImChatSettingsView['route']) ?? null,
    permissionMode: (patch.permissionMode as ImChatSettingsView['permissionMode']) ?? null,
    members: patch.members === true,
  }));
  state.resume.mockImplementation(async (_channel: string, chatId: string) => ({ ...FOLLOWING, chatId, members: true }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        imChatSettingsList: state.list,
        imChatSettingsSet: state.set,
        imChatSettingsResumeMembers: state.resume,
        imDefaultSettingsGet: state.defaultsGet,
      },
    },
  });
});
afterEach(cleanup);

async function expandCard(channel: 'feishu' | 'telegram' = 'feishu') {
  render(<ImChatSettingsCard channel={channel} />);
  fireEvent.click(screen.getByRole('button', { name: /settings\.imBot\.chats\.expand/ }));
}

async function openGroup(channel: 'feishu' | 'telegram' = 'feishu') {
  await expandCard(channel);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.imBot.chats.expandAria:项目群' }));
  return screen.findByRole('combobox', { name: 'settings.imBot.chats.permission.label' });
}

async function pick(combobox: HTMLElement, label: string | RegExp) {
  fireEvent.keyDown(combobox, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: label }));
}

it('改成完全访问前点名这个群确认, 取消不保存, 确认后保存并在行上写明', async () => {
  const permission = await openGroup();

  state.confirm.mockResolvedValueOnce(false);
  await pick(permission, /bypassPermissions/);
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(state.confirm.mock.calls[0]![0]).toMatchObject({
    title: 'settings.imBot.chats.fullAccessConfirm.title:项目群',
    confirmVariant: 'destructive',
  });
  expect(state.set).not.toHaveBeenCalled();

  state.confirm.mockResolvedValueOnce(true);
  await pick(permission, /bypassPermissions/);
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith('feishu', 'oc_group1', { permissionMode: 'bypassPermissions' }, '项目群'),
  );
  expect(await screen.findByText('settings.imBot.chats.statusCustom')).toBeTruthy();
  // 保存结果不带头像时沿用列表里的头像。
  expect(document.querySelector('img')?.getAttribute('src')).toBe(FOLLOWING.avatarUrl);
});

it('收紧的档位直接保存; 选「跟随」清掉覆写, 跟随的档位更宽时先确认', async () => {
  state.list.mockResolvedValue(listOf([{ ...FOLLOWING, permissionMode: 'bypassPermissions' }]));
  const permission = await openGroup();

  await pick(permission, /permissionSelector\.modes\.codex\.ask/);
  await waitFor(() => expect(state.set).toHaveBeenCalledWith('feishu', 'oc_group1', { permissionMode: 'ask' }, '项目群'));
  expect(state.confirm).not.toHaveBeenCalled();

  // 现在是「默认权限」, 跟随的「群聊新建任务权限档」是自动审批: 更宽, 先确认。
  state.confirm.mockResolvedValueOnce(true);
  await pick(permission, 'settings.imBot.chats.permission.followWith');
  await waitFor(() => expect(state.set).toHaveBeenLastCalledWith('feishu', 'oc_group1', { permissionMode: null }, '项目群'));
  expect(state.confirm).toHaveBeenCalledTimes(1);
});

it('跟随时显示继承的模型与推理强度; 只改推理强度就存成这个群的模型设置, 之后可改回跟随', async () => {
  await openGroup();
  expect(screen.getByTestId('model-trigger').textContent).toBe('gpt-6.2-sol|high');

  fireEvent.click(screen.getByRole('button', { name: 'pick-low-effort' }));
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith(
      'feishu',
      'oc_group1',
      { route: { agentKind: 'codex', model: 'gpt-6.2-sol', providerId: 'openai', agentDeviceId: null, effort: 'low' } },
      '项目群',
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'settings.imBot.chats.model.reset' }));
  await waitFor(() => expect(state.set).toHaveBeenLastCalledWith('feishu', 'oc_group1', { route: null }, '项目群'));
});

it('单独设置过的群排在前面; 不搜索时先显示 20 个, 搜索时全部可找', async () => {
  const following = Array.from({ length: 21 }, (_, index) => ({
    ...FOLLOWING,
    chatId: `oc_follow${index}`,
    name: `跟随群${index}`,
    avatarUrl: null,
  }));
  state.list.mockResolvedValue(
    listOf([...following, { ...FOLLOWING, chatId: 'oc_custom', name: '单独群', permissionMode: 'bypassPermissions' }]),
  );
  await expandCard();

  const group = await screen.findByRole('group', { name: 'settings.imBot.rows.chats' });
  const rows = within(group).getAllByRole('button', { name: /expandAria/ });
  expect(rows[0]!.getAttribute('aria-label')).toBe('settings.imBot.chats.expandAria:单独群');
  expect(rows).toHaveLength(20);
  expect(screen.getByText('settings.imBot.chats.shownHint:22')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('settings.imBot.chats.searchLabel'), { target: { value: '跟随群20' } });
  expect(await screen.findByRole('button', { name: 'settings.imBot.chats.expandAria:跟随群20' })).toBeTruthy();
});

it('收起时只读概要, 标出群数与单独设置数并露出群头像; 第一次展开才读完整列表', async () => {
  state.list.mockResolvedValue(listOf([FOLLOWING, { ...FOLLOWING, chatId: 'oc_custom', name: '单独群', permissionMode: 'auto' }]));
  render(<ImChatSettingsCard channel="feishu" />);
  await waitFor(() => expect(document.querySelectorAll(`img[src="${FOLLOWING.avatarUrl}"]`).length).toBe(2));
  expect(document.body.textContent).toContain('settings.imBot.chats.groupCount:2');
  expect(document.body.textContent).toContain('settings.imBot.chats.customCount:1');
  expect(state.list).toHaveBeenCalledExactlyOnceWith('feishu', { summary: true });

  fireEvent.click(screen.getByRole('button', { name: /settings\.imBot\.chats\.expand/ }));
  expect(await screen.findByRole('button', { name: 'settings.imBot.chats.expandAria:单独群' })).toBeTruthy();
  expect(state.list).toHaveBeenLastCalledWith('feishu', { refresh: false });
  fireEvent.click(await screen.findByRole('button', { name: 'settings.imBot.chats.refresh' }));
  await waitFor(() => expect(state.list).toHaveBeenLastCalledWith('feishu', { refresh: true }));
});

const PROJECT_ROUTE = {
  agentKind: 'claude-code',
  model: 'claude-opus-5-5',
  providerId: 'anthropic',
  agentDeviceId: null,
  effort: 'xhigh',
} as const;

it('绑定了项目的群跟随项目在「项目与模型」里的模型; 只改推理强度时以项目的模型为基础', async () => {
  const token = 'a'.repeat(24);
  state.list.mockResolvedValue({
    ...listOf([
      {
        ...FOLLOWING,
        project: { token, name: 'cindy', available: true, config: { route: PROJECT_ROUTE, permissionMode: 'bypassPermissions' } },
      },
    ]),
    projects: [{ token, name: 'cindy', permissionMode: 'bypassPermissions' }],
  });
  await openGroup();

  expect(screen.getByTestId('model-trigger').textContent).toBe('claude-opus-5-5|xhigh');
  fireEvent.click(screen.getByRole('button', { name: 'pick-low-effort' }));
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith('feishu', 'oc_group1', { route: { ...PROJECT_ROUTE, effort: 'low' } }, '项目群'),
  );
});

it('绑定会放宽群里新任务权限的项目前先确认, 取消不保存; 不放宽的直接保存', async () => {
  const wide = { token: 'a'.repeat(24), name: 'cindy', permissionMode: 'bypassPermissions' as const };
  const narrow = { token: 'b'.repeat(24), name: 'docs', permissionMode: 'ask' as const };
  state.list.mockResolvedValue({ ...listOf([FOLLOWING]), projects: [wide, narrow] });
  await openGroup();
  const project = screen.getByRole('combobox', { name: 'settings.imBot.chats.project.label' });

  // 群现在按「群聊新建任务权限档」(自动审批), cindy 是完全访问: 更宽。
  state.confirm.mockResolvedValueOnce(false);
  await pick(project, 'cindy');
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(state.confirm.mock.calls[0]![0]).toMatchObject({
    title: 'settings.imBot.chats.widerConfirm.title:项目群',
    confirmVariant: 'destructive',
  });
  expect(state.set).not.toHaveBeenCalled();

  await pick(project, 'docs');
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith('feishu', 'oc_group1', { projectToken: narrow.token }, '项目群'),
  );
  expect(state.confirm).toHaveBeenCalledTimes(1);
});

// 2026-11-24 主人裁决(微信插件的「群成员也能提问」): 勾选即保存; 被连续提问暂停时行上用警示色写明、编辑区
// 写明原因并给「恢复」。最小失败输入: 一个没开放的群勾选; 一个开放后已暂停的群点「恢复」。
it('勾「群成员也能提问」就保存这个群; 暂停时行上标出, 点「恢复」解除', async () => {
  await openGroup();
  fireEvent.click(screen.getByRole('checkbox'));
  await waitFor(() => expect(state.set).toHaveBeenCalledExactlyOnceWith('feishu', 'oc_group1', { members: true }, '项目群'));

  cleanup();
  vi.clearAllMocks();
  state.list.mockResolvedValue(listOf([{ ...FOLLOWING, members: true, membersPaused: true }]));
  state.resume.mockResolvedValue({ ...FOLLOWING, members: true, membersPaused: false });
  await expandCard();
  expect(await screen.findByText('settings.imBot.chats.members.pausedChip')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'settings.imBot.chats.expandAria:项目群' }));
  expect(await screen.findByText('settings.imBot.chats.members.paused')).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'settings.imBot.chats.members.resume' }));
  await waitFor(() => expect(state.resume).toHaveBeenCalledExactlyOnceWith('feishu', 'oc_group1', '项目群'));
  expect(await screen.findByText('settings.imBot.chats.members.chip')).toBeTruthy();
});

// 非飞书平台没有「群聊新建任务权限档」: 跟随时继承机器人自己的权限档。
it('Telegram: 跟随的权限是机器人自己的档位', async () => {
  state.defaultsGet.mockResolvedValue({ ...(await state.defaultsGet()), groupPermissionMode: 'bypassPermissions', permissionMode: 'ask' });
  state.list.mockResolvedValue({ ...listOf([FOLLOWING]), channel: 'telegram' });
  const permission = await openGroup('telegram');
  // 机器人自己是「默认权限」, 选「默认权限」不算放宽: 不弹确认。
  await pick(permission, /permissionSelector\.modes\.codex\.ask/);
  await waitFor(() => expect(state.set).toHaveBeenCalledWith('telegram', 'oc_group1', { permissionMode: 'ask' }, '项目群'));
  expect(state.confirm).not.toHaveBeenCalled();
});

// 依据: 插件引擎(如 Antigravity, agentKind='acp') 与内置引擎同等开放到个人 IM 群聊模型设置。
// 缺口: 上述用例只覆盖内置模型，未覆盖按群选用插件引擎及继承渠道 acp 默认路由。
// 最小失败输入: 展开一个跟随群点选 Antigravity 插件引擎模型，以及渠道默认本身为 acp 时展开编辑区。
// tier: unit(jsdom)
it('群聊模型支持选择 Antigravity 插件引擎，且渠道默认是插件引擎时不崩溃并透传 active', async () => {
  await openGroup();
  fireEvent.click(screen.getByRole('button', { name: 'pick-antigravity' }));
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith(
      'feishu',
      'oc_group1',
      {
        route: {
          agentKind: 'acp',
          providerId: 'acp-plugin:cindy-antigravity:antigravity',
          model: 'gemini-3-pro',
          agentDeviceId: null,
          effort: '',
          modelGroup: null,
        },
      },
      '项目群',
    ),
  );

  cleanup();
  vi.clearAllMocks();
  state.list.mockResolvedValue(listOf([FOLLOWING]));
  state.defaultsGet.mockResolvedValue({
    agentKind: 'acp',
    groupPermissionMode: 'ask',
    permissionMode: 'ask',
    agents: {
      'claude-code': { providerId: null, model: 'claude-sonnet-4-6', effort: 'high' },
      codex: { providerId: null, model: 'gpt-5.4', effort: 'high' },
      pi: { providerId: null, model: 'gpt-5.4', effort: 'high' },
      acp: {
        providerId: 'acp-plugin:cindy-antigravity:antigravity',
        model: 'gemini-3-pro',
        effort: '',
      },
    },
  });
  await openGroup();
  expect(screen.getByTestId('plugin-engine-active').textContent).toBe(
    'acp-plugin:cindy-antigravity:antigravity|gemini-3-pro|',
  );
});
