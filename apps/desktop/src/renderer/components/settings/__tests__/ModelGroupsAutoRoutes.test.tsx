// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：智能路由页「分配」一栏的 `ProviderAllocationRows`(真实组件)，看列出的行与点按钮后发出的保存命令。
 * - Bug／规则依据：model-groups.md §6.4、provider-groups.md：main 2026-11-25 加入的 OpenAI 订阅与 API key 混合账号组，选法
 *   与其他账号池一样只在智能路由里改(2026-11-26)。此前这一行把它当成「几台电脑」：提示写电脑数，「按顺序／按权重」时
 *   只列出电脑、不列账号，账号的先后与权重在这里改不了。
 * - 现有覆盖缺口：智能路由页的分配行此前没有组件测试。
 * - 最小失败输入：一个混合组(本机 OpenAI + 一个 API key 账号)，选法为「按权重」。
 * - tier：unit(jsdom，假 IPC 与假目录)。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig } from '../../../../shared/providerGroup';

const h = vi.hoisted(() => ({
  groups: {} as Record<string, unknown>,
  save: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, args?: { count?: number }) => (args?.count !== undefined ? `${key}:${args.count}` : key) }),
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [
    { id: 'openai', name: 'OpenAI', connected: true, agents: [], routing: {}, models: {} },
    { id: 'key-1', name: 'Fixture key', connected: true, agents: [], routing: {}, models: {} },
  ] }),
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({ useLocalProviderGroups: () => h.groups }));
vi.mock('@/features/provider-group/useProviderGroup', () => ({ useProviderGroup: () => ({ view: null, save: h.save }) }));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ProviderMark: () => null }));

import { ProviderAllocationRows } from '../ModelGroupsAutoRoutes';

afterEach(() => cleanup());

it('lists the accounts of a mixed OpenAI group and reorders them through the account allocation', async () => {
  const config: ProviderGroupConfig = {
    strategy: 'weighted', autoSwitch: true,
    members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'openai', weight: 1, limit: 4, paused: false }],
    localAccountIds: ['key-1'],
  };
  h.groups = { openai: config };
  const command = vi.fn(async () => config);
  Object.assign(window, { electronAPI: { providerGroup: { command } } });
  render(<ProviderAllocationRows config={{ routes: [] } as never} />);

  const head = document.querySelector('[data-auto-route="computers:openai"]')!;
  expect(head.textContent).toContain('modelGroups.auto.accounts:2');
  expect(head.textContent).not.toContain('modelGroups.auto.computers');
  const rows = [...document.querySelectorAll('[data-auto-route-member]')].map((row) => row.textContent);
  expect(rows).toEqual([expect.stringContaining('OpenAI'), expect.stringContaining('Fixture key')]);

  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'modelGroups.settings.moveDown' })[0]!); });
  expect(command).toHaveBeenCalledWith({
    action: 'account-allocation', providerId: 'openai', expectedConfig: config, edit: { order: ['key-1', 'openai'] },
  });
  // 账号的设置不经整份组配置保存，免得覆盖账号分配里存的先后与权重。
  expect(h.save).not.toHaveBeenCalled();
});

// 2026-11-26(dash 建议做减法)：选法选择框主推「自动」「按顺序」，轮流、按权重、余量最多、用完再换收在「更多选法」下面，
// 功能不删；同一个供应商的账号与电脑之间价格相同，不列「最省钱」。
it('features Automatic and In order and keeps the other strategies under More options', async () => {
  h.groups = { openai: {
    strategy: 'expiring', autoSwitch: true,
    members: [{ key: 'local', kind: 'local', agentDeviceId: null, providerId: 'openai', weight: 1, limit: 4, paused: false }],
    localAccountIds: ['key-1'],
  } };
  Object.assign(window, { electronAPI: { providerGroup: { command: vi.fn() } } });
  // jsdom 没有 scrollIntoView：下拉列表打开时会滚到选中项。
  Element.prototype.scrollIntoView ??= () => undefined;
  render(<ProviderAllocationRows config={{ routes: [] } as never} />);
  fireEvent.click(screen.getByRole('combobox', { name: 'modelGroups.auto.pickFor' }));
  const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
  expect(options).toEqual([
    'modelGroups.strategy.expiring.title', 'modelGroups.strategy.order.title',
    'modelGroups.strategy.rotate.title', 'modelGroups.strategy.weighted.title',
    'modelGroups.strategy.drain.title', 'modelGroups.strategy.headroom.title',
  ]);
  expect(screen.getByText('modelGroups.settings.moreStrategies')).toBeTruthy();
});
