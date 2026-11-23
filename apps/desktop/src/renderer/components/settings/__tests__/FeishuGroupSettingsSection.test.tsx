// @vitest-environment jsdom
/**
 * 个人飞书机器人设置页「群聊」(2026-11-23 用户需求: 内置飞书按群设置项目、模型、推理强度和权限,
 * 体验后要求列表分组、显示群头像、整块可以折叠, 且能像「微信群里的 Cindy」那样直接覆盖模型、
 * 推理强度与权限)。
 *
 * 依据: 群里任何成员 @ 机器人都会用这个群的权限档, 所以把一个群改成「完全访问」前必须经
 * Cindy 的确认框写明是哪个群, 取消就不保存; 其余档位直接保存, 恢复按钮清掉覆写。跟随的群在
 * 控件里显示正在继承的模型与推理强度, 只改推理强度也要存成这个群的设置。整块默认收起, 打开
 * 飞书卡片时只读概要(群数与头像, 不解析项目模型), 第一次展开才读完整列表。绑定了项目的群跟随「项目与模型」里那个项目
 * (只有没绑项目的群才跟随「新对话配置」); 换项目会让群里新任务的权限变宽时先确认。
 * 生产入口: FeishuGroupSettingsSection 经 preload 的 feishuGroupSettingsList / Set 读写。
 * 缺口: 主进程用例只覆盖存储与建任务读取, 没有界面的确认、继承显示与分组。
 * 最小失败输入: 展开一个跟随渠道设置的群, 依次选「完全访问」取消、确认; 只改推理强度; 列出
 * 一个单独设置过的群与六个跟随的群。
 * tier: unit(jsdom; 模型与权限选择器替身只暴露回调)。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { FeishuGroupSettingsList, FeishuGroupSettingsView } from '../../../../shared/feishuGroupSettings';

const state = vi.hoisted(() => ({
  confirm: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
  defaultsGet: vi.fn(),
}));

vi.mock('react-i18next', () => {
  const t = (key: string, opts?: { name?: string; count?: number }) =>
    opts?.name ? `${key}:${opts.name}` : opts?.count !== undefined ? `${key}:${opts.count}` : key;
  return { useTranslation: () => ({ t, i18n: { exists: () => true } }) };
});
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: state.confirm }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({ useModelPickerAgents: () => ['claude-code', 'codex', 'pi'] }));
vi.mock('@/hooks/useModelRouteDevices', () => ({ useModelRouteDevices: () => ({ devices: [] }) }));
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: ({ modelId, effort, onEffortChange }: {
    modelId: string;
    effort: string;
    onEffortChange: (effort: string) => void;
  }) => (
    <>
      <span data-testid="model-trigger">{`${modelId}|${effort}`}</span>
      <button type="button" onClick={() => onEffortChange('low')}>pick-low-effort</button>
    </>
  ),
}));
vi.mock('@/components/new-chat/PermissionSelector', () => ({
  PermissionSelector: ({ onPermissionModeChange }: { onPermissionModeChange: (mode: string) => void }) => (
    <>
      <button type="button" onClick={() => onPermissionModeChange('bypassPermissions')}>pick-full-access</button>
      <button type="button" onClick={() => onPermissionModeChange('auto')}>pick-auto</button>
    </>
  ),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { FeishuGroupSettingsSection } from '../FeishuGroupSettingsSection';

const FOLLOWING: FeishuGroupSettingsView = {
  chatId: 'oc_group1',
  name: '项目群',
  avatarUrl: 'https://s1-imfile.feishucdn.com/avatar-1',
  project: null,
  route: null,
  permissionMode: null,
};

const FULL_ACCESS_LABEL = 'newChat.permissionSelector.modes.codex.bypassPermissions.label';

function listOf(groups: FeishuGroupSettingsView[]): FeishuGroupSettingsList {
  return { connected: true, source: 'feishu', listError: null, groups, projects: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 项目下拉框打开时把选中项滚进可见区域; jsdom 没有这个方法(同 select.test)。
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
  state.set.mockImplementation(async (chatId: string, patch: Record<string, unknown>) => ({
    ...FOLLOWING,
    chatId,
    avatarUrl: null,
    route: (patch.route as FeishuGroupSettingsView['route']) ?? null,
    permissionMode: (patch.permissionMode as FeishuGroupSettingsView['permissionMode']) ?? null,
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        feishuGroupSettingsList: state.list,
        feishuGroupSettingsSet: state.set,
        imDefaultSettingsGet: state.defaultsGet,
      },
    },
  });
});
afterEach(cleanup);

/** 整块的「展开 / 收起」按钮(键盘与读屏的入口; 整行另可用鼠标点)。 */
function sectionHeader() {
  return screen.getByRole('button', { name: /settings\.feishuBot\.groups\.(expand|collapse)/ });
}

async function openGroup() {
  render(<FeishuGroupSettingsSection />);
  fireEvent.click(sectionHeader());
  fireEvent.click(await screen.findByRole('button', { name: 'settings.feishuBot.groups.expandAria:项目群' }));
  return screen.findByRole('button', { name: 'pick-full-access' });
}

it('改成完全访问前点名这个群确认, 取消不保存, 确认后保存并在行上标出', async () => {
  const fullAccess = await openGroup();

  state.confirm.mockResolvedValueOnce(false);
  fireEvent.click(fullAccess);
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(state.confirm.mock.calls[0]![0]).toMatchObject({
    title: 'settings.feishuBot.groups.fullAccessConfirm.title:项目群',
    confirmVariant: 'destructive',
  });
  expect(state.set).not.toHaveBeenCalled();

  state.confirm.mockResolvedValueOnce(true);
  fireEvent.click(fullAccess);
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith('oc_group1', { permissionMode: 'bypassPermissions' }, '项目群'),
  );
  expect(await screen.findByText(FULL_ACCESS_LABEL)).toBeTruthy();
  // 保存结果不带头像时沿用列表里的头像。
  expect(document.querySelector('img')?.getAttribute('src')).toBe(FOLLOWING.avatarUrl);
});

it('其余档位直接保存; 恢复按钮清掉这个群的权限档', async () => {
  await openGroup();

  fireEvent.click(screen.getByRole('button', { name: 'pick-auto' }));
  await waitFor(() => expect(state.set).toHaveBeenCalledWith('oc_group1', { permissionMode: 'auto' }, '项目群'));
  expect(state.confirm).not.toHaveBeenCalled();

  fireEvent.click(await screen.findByRole('button', { name: 'settings.defaults.restore' }));
  await waitFor(() => expect(state.set).toHaveBeenLastCalledWith('oc_group1', { permissionMode: null }, '项目群'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'settings.defaults.restore' })).toBeNull());
});

it('跟随时显示继承的模型与推理强度; 只改推理强度就存成这个群的模型设置', async () => {
  await openGroup();
  expect(screen.getByTestId('model-trigger').textContent).toBe('gpt-6.2-sol|high');

  fireEvent.click(screen.getByRole('button', { name: 'pick-low-effort' }));
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith(
      'oc_group1',
      { route: { agentKind: 'codex', model: 'gpt-6.2-sol', providerId: 'openai', agentDeviceId: null, effort: 'low' } },
      '项目群',
    ),
  );
  expect(await screen.findByText('settings.feishuBot.groups.model.hintFixed')).toBeTruthy();
});

it('单独设置过的群与跟随的群分两组; 跟随组多于 5 个时先显示 4 个', async () => {
  const following = Array.from({ length: 6 }, (_, index) => ({
    ...FOLLOWING,
    chatId: `oc_follow${index}`,
    name: `跟随群${index}`,
    avatarUrl: null,
  }));
  state.list.mockResolvedValue(
    listOf([...following, { ...FOLLOWING, chatId: 'oc_custom', name: '单独群', permissionMode: 'bypassPermissions' }]),
  );
  render(<FeishuGroupSettingsSection />);
  fireEvent.click(sectionHeader());

  const custom = (await screen.findByText('settings.feishuBot.groups.customHeading')).parentElement!.parentElement!;
  expect(within(custom).getByText('单独群')).toBeTruthy();
  expect(within(custom).getByText(FULL_ACCESS_LABEL)).toBeTruthy();
  const follow = screen.getByText('settings.feishuBot.groups.followHeading').parentElement!.parentElement!;
  expect(within(follow).queryByText('跟随群3')).toBeTruthy();
  expect(within(follow).queryByText('跟随群4')).toBeNull();

  // 外层折叠区展开动画结束前其中的控件不可交互, 等它就绪。
  fireEvent.click(await within(follow).findByRole('button', { name: /settings\.feishuBot\.groups\.showMore:2/ }));
  expect(await within(follow).findByText('跟随群5')).toBeTruthy();
});

// 2026-11-23 用户反馈: 收起时标题旁的群数与群头像要先展开一次才出现。最小失败输入: 只打开飞书
// 卡片(挂载本块)、不点展开, 名单里一个单独设置的群和一个跟随的群。
it('默认收起, 不展开就在标题旁标出群数与单独设置数并露出群头像; 第一次展开才读完整列表', async () => {
  state.list.mockResolvedValue(
    listOf([FOLLOWING, { ...FOLLOWING, chatId: 'oc_custom', name: '单独群', permissionMode: 'auto' }]),
  );
  render(<FeishuGroupSettingsSection />);
  const header = sectionHeader();
  const section = header.closest('section')!;
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'settings.feishuBot.groups.refresh' })).toBeNull();
  // 只读概要(不解析项目模型), 两个群共用同一张替身头像。
  await waitFor(() => expect(section.querySelectorAll(`img[src="${FOLLOWING.avatarUrl}"]`).length).toBe(2));
  expect(section.textContent).toContain('settings.feishuBot.groups.groupCount:2');
  expect(section.textContent).toContain('settings.feishuBot.groups.customCount:1');
  expect(state.list).toHaveBeenCalledExactlyOnceWith({ summary: true });

  fireEvent.click(header);
  expect(await screen.findByText('单独群')).toBeTruthy();
  expect(state.list).toHaveBeenLastCalledWith({ refresh: false });

  fireEvent.click(header);
  expect(header.getAttribute('aria-expanded')).toBe('false');
  expect(header.textContent).toContain('settings.feishuBot.groups.expand');
  expect(section.textContent).toContain('settings.feishuBot.groups.groupCount:2');
  // 再展开沿用已读到的名单, 不重复请求; 要最新名单用「刷新」。
  fireEvent.click(header);
  expect(state.list).toHaveBeenCalledTimes(2);
  fireEvent.click(await screen.findByRole('button', { name: 'settings.feishuBot.groups.refresh' }));
  await waitFor(() => expect(state.list).toHaveBeenLastCalledWith({ refresh: true }));
});

const PROJECT_ROUTE = {
  agentKind: 'claude-code',
  model: 'claude-opus-5-5',
  providerId: 'anthropic',
  agentDeviceId: null,
  effort: 'xhigh',
} as const;

it('绑定了项目的群跟随项目在「项目与模型」里的模型与权限; 只改推理强度时以项目的模型为基础', async () => {
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
  expect(screen.getByText('settings.feishuBot.groups.model.hintFollowProject')).toBeTruthy();
  expect(screen.getByText('settings.feishuBot.groups.permission.hintFollowProject')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'pick-low-effort' }));
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith('oc_group1', { route: { ...PROJECT_ROUTE, effort: 'low' } }, '项目群'),
  );
});

it('绑定会放宽群里新任务权限的项目前先确认, 取消不保存; 不放宽的直接保存', async () => {
  const wide = { token: 'a'.repeat(24), name: 'cindy', permissionMode: 'bypassPermissions' as const };
  const narrow = { token: 'b'.repeat(24), name: 'docs', permissionMode: 'ask' as const };
  state.list.mockResolvedValue({ ...listOf([FOLLOWING]), projects: [wide, narrow] });
  await openGroup();
  const pick = async (label: string) => {
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: label }));
  };

  // 群现在按「群聊新建任务权限档」(自动审批), cindy 是完全访问: 更宽。
  state.confirm.mockResolvedValueOnce(false);
  await pick('cindy');
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(state.confirm.mock.calls[0]![0]).toMatchObject({
    title: 'settings.feishuBot.groups.widerConfirm.title:项目群',
    confirmVariant: 'destructive',
  });
  expect(state.set).not.toHaveBeenCalled();

  await pick('docs');
  await waitFor(() =>
    expect(state.set).toHaveBeenCalledExactlyOnceWith('oc_group1', { projectToken: narrow.token }, '项目群'),
  );
  expect(state.confirm).toHaveBeenCalledTimes(1);
});

it('收起时点标题行任意位置也能展开(鼠标); 点按钮不会重复切换', async () => {
  render(<FeishuGroupSettingsSection />);
  await screen.findByText('settings.feishuBot.groups.groupCount:1');
  fireEvent.click(screen.getByText('settings.feishuBot.groups.description'));
  expect(sectionHeader().getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(sectionHeader());
  expect(sectionHeader().getAttribute('aria-expanded')).toBe('false');
});

// PR #12287, unit: 通过真实恢复按钮验证项目和权限的继承分支，原有用例只覆盖直接选择。
it.each([
  ['project', null, 'ask', { projectToken: null }],
  ['permission', 'ask', 'bypassPermissions', { permissionMode: null }],
] as const)('恢复 %s 会放宽权限时先确认，取消不写入', async (field, permissionMode, projectPermission, patch) => {
  const token = 'a'.repeat(24);
  state.list.mockResolvedValue(listOf([{
    ...FOLLOWING,
    project: { token, name: 'cindy', available: true, config: { route: PROJECT_ROUTE, permissionMode: projectPermission } },
    permissionMode,
  }]));
  const defaults = await state.defaultsGet();
  state.defaultsGet.mockResolvedValue({ ...defaults, groupPermissionMode: 'bypassPermissions' });
  await openGroup();
  const label = screen.getByText(`settings.feishuBot.groups.${field}.label`);
  const reset = within(label.parentElement!).getByRole('button', { name: 'settings.defaults.restore' });
  state.confirm.mockResolvedValueOnce(false);
  fireEvent.click(reset);
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(state.set).not.toHaveBeenCalled();

  state.confirm.mockResolvedValueOnce(true);
  fireEvent.click(reset);
  await waitFor(() => expect(state.set).toHaveBeenCalledExactlyOnceWith('oc_group1', patch, '项目群'));
});
