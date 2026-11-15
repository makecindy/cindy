// @vitest-environment jsdom
// Unit: account management contract. Real dialog/actions, fake IPC. The existing
// form tests cannot catch releasing another device, stale quotas, or late owner responses.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../i18n/locales/zh-CN/common.json';
import type { Schedule } from '@cindy/maker-scheduler';

const state = vi.hoisted(() => ({ owner: 0, confirm: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => state.owner }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useOptionalConfirmDialog: () => ({ confirm: state.confirm }) }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { resolvedLanguage: 'zh-CN' },
  t: (key: string, args: Record<string, unknown> = {}) => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);
    return String(value ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(args[name] ?? ''));
  },
}) }));
import { WebhookAccountManager } from '../WebhookAccountManager';
import { WebhookTriggerPanel } from '../WebhookTriggerPanel';

const endpoint = { id: 'whk_old', url: 'https://example.test/hooks/whk_old', scheduleId: 'old',
  scheduleName: '旧电脑巡检', deviceId: 'retired', deviceName: '旧电脑', currentDevice: false,
  status: 'active' as const, lastReceivedAt: null };
const overview = { used: 1, limit: 10, endpoints: [endpoint] };
let read: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  state.owner = 0;
  state.confirm.mockReset();
  read = vi.fn().mockResolvedValue(overview);
  release = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { schedule: {
    webhookReceiver: async () => 'cloud', webhookAccount: read, releaseWebhookEndpoint: release,
  } } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
const element = () => <MemoryRouter><WebhookAccountManager /></MemoryRouter>;
async function open() {
  fireEvent.click(await screen.findByRole('button', { name: '管理' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('旧电脑巡检');
  return within(dialog);
}

it('按设备确认释放，成功后刷新名额，不删除自动化', async () => {
  render(element());
  const dialog = await open();
  expect(dialog.queryByRole('button', { name: '查看自动化' })).toBeNull();
  fireEvent.click(dialog.getByRole('button', { name: '释放' }));
  expect(release).not.toHaveBeenCalled();
  expect(dialog.getByText(/自动化及运行记录/)).toBeTruthy();
  read.mockResolvedValue({ used: 0, limit: 10, endpoints: [] });
  fireEvent.click(dialog.getByRole('button', { name: '释放地址' }));
  await waitFor(() => expect(release).toHaveBeenCalledWith('whk_old'));
  await waitFor(() => expect(dialog.queryByText('旧电脑巡检')).toBeNull());
  expect(dialog.getByText('接收地址 0 / 10')).toBeTruthy();
});

it('结果未知时隐藏旧用量，要求刷新再操作', async () => {
  render(element());
  const dialog = await open();
  fireEvent.click(dialog.getByRole('button', { name: '释放' }));
  release.mockRejectedValueOnce(new Error('network lost'));
  fireEvent.click(dialog.getByRole('button', { name: '释放地址' }));
  await dialog.findByRole('alert');
  expect(dialog.queryByText('接收地址 1 / 10')).toBeNull();
  expect((dialog.getByRole('button', { name: '释放地址' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(dialog.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(dialog.queryByRole('alert')).toBeNull());
});

it('切换账号时丢弃旧清单与迟到的响应', async () => {
  let finish!: (value: typeof overview) => void;
  read.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(element());
  await waitFor(() => expect(read).toHaveBeenCalled());
  state.owner = 1;
  read.mockResolvedValue({ used: 0, limit: 10, endpoints: [] });
  view.rerender(element());
  await screen.findByText('接收地址 0 / 10');
  finish(overview);
  fireEvent.click(screen.getByRole('button', { name: '管理' }));
  await screen.findByRole('dialog');
  expect(screen.queryByText('旧电脑巡检')).toBeNull();
});

// 2026-11-04 detail redesign, unit/jsdom: the real panel now collapses saved
// settings. Account-dialog tests do not cover discoverability or retaining a
// newly generated secret across the status refresh that marks it saved.
function connection(preset = 'github', id = 'fixture') {
  let current = { receiver: 'cloud', connected: true, url: 'https://example.test/hooks/test',
    hasSecret: true, lastReceivedAt: Date.UTC(2026, 10, 4, 11), ignored: 0 };
  const api = window.electronAPI.maker.schedule;
  Object.assign(api, { webhookStatus: vi.fn(async () => current),
    setWebhookSecret: vi.fn(async () => { current = { ...current, hasSecret: true }; return { secret: 'test-only-generated-secret' }; }),
    restoreWebhookEndpoint: vi.fn(async () => { current = { ...current, problem: undefined, hasSecret: false } as typeof current; }),
  });
  const schedule = { id, name: 'Fixture', status: 'active', updatedAt: 1,
    webhookTrigger: { events: ['issues.opened'], source: { preset } } } as Schedule;
  return { api, schedule, patch: (value: Record<string, unknown>) => { current = { ...current, ...value }; },
    render: () => render(<MemoryRouter><WebhookTriggerPanel schedule={schedule} /></MemoryRouter>) };
}

// PR #8470, unit/jsdom: a slow status read must not enqueue unbounded IPC calls.
// Existing panel tests only exercise immediately resolved status requests.
it('keeps one status read in flight across timer ticks and schedule revisions', async () => {
  vi.useFakeTimers();
  const c = connection();
  let finish!: (value: null) => void;
  const readStatus = vi.mocked(c.api.webhookStatus);
  readStatus.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = c.render();
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(readStatus).toHaveBeenCalledTimes(1);
  view.rerender(<MemoryRouter><WebhookTriggerPanel schedule={{ ...c.schedule, updatedAt: 2 }} /></MemoryRouter>);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(readStatus).toHaveBeenCalledTimes(1);
  await act(async () => { finish(null); });
  expect(readStatus).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(readStatus).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(readStatus).toHaveBeenCalledTimes(3);
});

it('已配置时只显示摘要，展开后仍可复制地址和管理账号名额', async () => {
  const c = connection(); c.render();
  await screen.findByText(/最近事件/);
  expect(screen.queryByText('https://example.test/hooks/test')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
  await screen.findByRole('button', { name: '复制 接收地址' });
  expect(screen.getByText('事件：Issue · 新建')).toBeTruthy();
  expect(screen.queryByText(/发送测试事件/)).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: '管理' }));
  await within(await screen.findByRole('dialog')).findByText('旧电脑巡检');
});

it('首次配置自动展开，生成密钥后不因状态刷新而收起明文', async () => {
  const c = connection(); c.patch({ hasSecret: false, lastReceivedAt: null }); c.render();
  fireEvent.click(await screen.findByRole('button', { name: '生成密钥' }));
  await screen.findByText('test-only-generated-secret');
  await screen.findByRole('button', { name: '重新生成密钥' });
  expect(screen.getByRole('button', { name: '连接设置' }).getAttribute('aria-expanded')).toBe('true');
  expect(c.api.setWebhookSecret).toHaveBeenCalledWith('fixture');
});

// A missing key used to reopen settings on every visit. Existing tests only
// exercised one mount; revisit the real panel after leaving an unfinished setup.
// Unit/jsdom: persists only the one-time UI hint, never the URL or secret.
it('首次配置收起后，切走再回来不再自动展开，也不闪现配置内容', async () => {
  const c = connection(); c.patch({ hasSecret: false, lastReceivedAt: null });
  const first = c.render();
  await screen.findByRole('button', { name: '生成密钥' });
  fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
  first.unmount();
  const revisited = c.render();
  expect(screen.getByRole('button', { name: '连接设置' }).getAttribute('aria-expanded')).toBe('false');
  await screen.findByText(/生成密钥之前/);
  expect(screen.getByRole('button', { name: '连接设置' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: '生成密钥' })).toBeNull();
  expect(screen.queryByText('https://example.test/hooks/test')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
  await screen.findByRole('button', { name: '生成密钥' });
  revisited.unmount();

  const leftOpen = c.render();
  await screen.findByText(/生成密钥之前/);
  expect(screen.getByRole('button', { name: '连接设置' }).getAttribute('aria-expanded')).toBe('false');
  leftOpen.unmount();

  const another = connection('github', 'another');
  another.patch({ hasSecret: false, lastReceivedAt: null });
  another.render();
  await screen.findByRole('button', { name: '生成密钥' });
  expect(screen.getByRole('button', { name: '连接设置' }).getAttribute('aria-expanded')).toBe('true');
});

it('发送方密钥保存后收起配置，再展开不回显已粘贴的值', async () => {
  const c = connection('linear'); c.patch({ hasSecret: false, lastReceivedAt: null }); c.render();
  fireEvent.change(await screen.findByLabelText(/粘贴 Linear/), { target: { value: 'test-only-pasted-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '保存密钥' }));
  await waitFor(() => expect(c.api.setWebhookSecret).toHaveBeenCalledWith('fixture', 'test-only-pasted-secret'));
  await waitFor(() => expect(screen.getByRole('button', { name: '连接设置' }).getAttribute('aria-expanded')).toBe('false'));
  fireEvent.click(screen.getByRole('button', { name: '连接设置' }));
  expect((await screen.findByLabelText(/粘贴 Linear/) as HTMLInputElement).value).toBe('');
});

it('版本认不出发送方格式时说不支持，不说暂时不可用', async () => {
  const c = connection(); c.patch({ problem: 'unsupported', hasSecret: false }); c.render();
  expect(await screen.findByText('当前版本不支持这个发送方的格式。')).toBeTruthy();
  expect(screen.queryByText('接收地址暂时不可用。')).toBeNull();
});

it('已释放状态和重新连接入口不藏在配置里，仍须确认后恢复', async () => {
  const c = connection(); c.patch({ problem: 'released', url: null }); c.render();
  const reconnect = await screen.findByRole('button', { name: '重新连接' });
  state.confirm.mockResolvedValueOnce(false); fireEvent.click(reconnect);
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(c.api.restoreWebhookEndpoint).not.toHaveBeenCalled();
  state.confirm.mockResolvedValueOnce(true); fireEvent.click(reconnect);
  await waitFor(() => expect(c.api.restoreWebhookEndpoint).toHaveBeenCalledWith('fixture'));
});
