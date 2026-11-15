// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:`RemoteTeammateSettings`——远程控制伙伴时设置抽屉里实际渲染什么:同一套本机页面(带远程目标)、
 *   旧版主机回退到通用表单页、对方离线时的状态、主机推送后的重读。
 * - Bug／规则依据:cindy-bots-runtime.md「远程设置」;AGENTS.md 协议兼容:新桌面控制旧主机不得破坏现有通用表单页。
 * - 现有覆盖缺口:botSettingsDrawer.test 只验证抽屉对该组件的挂载;remoteBotSettings.test 只测通用表单页。
 * - 最小失败输入:主机未声明 management:settings;caps 被旧主机拒绝;离线且从未探测;同一伙伴/其它伙伴的推送。
 * - tier:unit(jsdom + 假的主机客户端)。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { createIpcError } from '../../../../shared/ipc-errors';

const h = vi.hoisted(() => ({
  declares: vi.fn(),
  caps: vi.fn(),
  call: vi.fn(),
  push: null as null | ((push: unknown, stamp: unknown) => void),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('../remoteBotSettingsClient', () => ({
  hostDeclaresBotSettings: h.declares,
  readBotSettingsCaps: h.caps,
  invokeBotSettings: h.call,
  splitProfilePatch: (patch: object) => [patch],
}));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [] }));
vi.mock('@/hooks/useAvailableAgents', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/hooks/useAvailableAgents')>()), useAvailableAgents: () => ({ availableVendors: new Set(), loaded: false }) }));
vi.mock('../RemoteBotSettings', () => ({ RemoteBotSettings: ({ bot }: { bot: { deviceId: string } }) => <div data-testid="generic-form">{bot.deviceId}</div> }));
vi.mock('../BotsHomeView', async () => {
  const { useOptionalBotSettingsTarget } = await import('../botSettingsTarget');
  return {
    BotSettings: ({ bot, initialPage, onOpenSession }: { bot: { name: string }; initialPage: string; onOpenSession(id: string): void }) => {
      const target = useOptionalBotSettingsTarget();
      return <div data-testid="pages" data-page={initialPage} data-target={`${target?.kind}:${target?.deviceId}`}>{bot.name}<button aria-label="Open channel task" onClick={() => onOpenSession('channel-task')} /></div>;
    },
  };
});

import { RemoteTeammateSettings } from '../RemoteTeammateSettings';

const bot = { id: 'bot-1', deviceId: 'mac', deviceName: 'Studio', name: 'Sora', avatar: '', avatarColor: '', description: '', preview: '', activityAt: 0, sessionId: 's', online: true };
const profile = (name: string) => ({ profile: { id: 'bot-1', name, description: '', avatar: '🙂', avatarColor: 'teal', status: 'active', skills: [], currentVersion: 1, createdAt: 1, sessions: [], capabilities: { harness: 'pi', model: 'm', modelChain: [], memory: true, permissions: 'ask' } } });
const renderSettings = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const props = { beforeCloseRef: { current: null }, onBack: vi.fn(), onDeleted: vi.fn() };
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname}{location.search}</output>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  h.declares.mockReset().mockResolvedValue(true);
  h.caps.mockReset().mockResolvedValue({ version: 1, ops: ['caps', 'profile.get', 'profile.update', 'memory.list', 'memory.read', 'memory.update', 'memory.delete'] });
  h.call.mockReset().mockResolvedValue(profile('Sora'));
  h.push = null;
  vi.stubGlobal('window', Object.assign(window, { electronAPI: { deviceLink: { onRemotePush: (listener: (push: unknown, stamp: unknown) => void) => { h.push = listener; return () => { h.push = null; }; } } } }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pushFor = (id: string) => act(() => h.push?.({ deviceId: 'mac', channel: REMOTE_RESOURCE_CHANGED_CHANNEL,
  payload: { collectionId: 'teammates', resourceRefs: [{ collectionId: 'teammates', kind: 'bot', id }] } }, {}));

it('renders the local pages against the teammate computer, opening the requested page it can serve', async () => {
  renderSettings(<RemoteTeammateSettings bot={bot} initialPage="memory" {...props} />);
  const pages = await screen.findByTestId('pages');
  expect(pages.getAttribute('data-target')).toBe('remote:mac');
  expect(pages.getAttribute('data-page')).toBe('memory');
  expect(pages.textContent).toBe('Sora');
  expect(screen.queryByTestId('generic-form')).toBeNull();
});

it('falls back to the home page when the host cannot serve the requested page', async () => {
  renderSettings(<RemoteTeammateSettings bot={bot} initialPage="channels" {...props} />);
  expect((await screen.findByTestId('pages')).getAttribute('data-page')).toBe('home');
});

// A channel selected from settings previously did nothing unless it was canonical/history.
// Unit tier: the actual settings consumer must navigate to the original device's ordinary task.
it('opens a selected task without requiring it in the loaded profile projection', async () => {
  renderSettings(<><LocationProbe /><RemoteTeammateSettings bot={bot} {...props} /></>);
  fireEvent.click(await screen.findByRole('button', { name: 'Open channel task' }));
  expect(screen.getByTestId('route').textContent).toBe('/cc-agent/channel-task?device=mac');
});

it('keeps the generic form page for a host that predates teammate settings', async () => {
  h.declares.mockResolvedValue(false);
  renderSettings(<RemoteTeammateSettings bot={bot} {...props} />);
  expect(await screen.findByTestId('generic-form')).toBeTruthy();
  h.declares.mockResolvedValue(true);
  cleanup();
  // An older host that lists the action but rejects the operation set is treated the same way.
  h.caps.mockRejectedValue(createIpcError('UNSUPPORTED_CAPABILITY', 'old'));
  renderSettings(<RemoteTeammateSettings bot={bot} {...props} />);
  expect(await screen.findByTestId('generic-form')).toBeTruthy();
  expect(screen.queryByTestId('pages')).toBeNull();
});

it('asks nothing of an unreachable computer and says so', () => {
  renderSettings(<RemoteTeammateSettings bot={{ ...bot, online: false }} {...props} />);
  expect(screen.getByRole('status').textContent).toBe('bots.remote.offlineDescription');
  expect(h.declares).not.toHaveBeenCalled();
});

it('re-reads the profile once after the host reports a change for this teammate, and ignores others', async () => {
  renderSettings(<RemoteTeammateSettings bot={bot} {...props} />);
  await screen.findByTestId('pages');
  const reads = () => h.call.mock.calls.filter((call) => call[1] === 'profile.get').length;
  expect(reads()).toBe(1);
  h.call.mockResolvedValue(profile('Renamed on the other computer'));
  pushFor('someone-else');
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(reads()).toBe(1);
  pushFor('bot-1');
  pushFor('bot-1');
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  await waitFor(() => expect(screen.getByTestId('pages').textContent).toBe('Renamed on the other computer'));
  expect(reads()).toBe(2);
});

it('keeps the open pages (and what is typed in them) across a disconnect and reconnect', async () => {
  const view = renderSettings(<RemoteTeammateSettings bot={bot} {...props} />);
  const before = await screen.findByTestId('pages');
  view.rerender(<MemoryRouter><RemoteTeammateSettings bot={{ ...bot, online: false }} {...props} /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toBe('bots.remote.offlineDescription');
  expect(screen.getByTestId('pages')).toBe(before);
  h.caps.mockClear();
  view.rerender(<MemoryRouter><RemoteTeammateSettings bot={bot} {...props} /></MemoryRouter>);
  await waitFor(() => expect(h.caps).toHaveBeenCalledTimes(1));
  // The host answered the same operation set again: the pages are the same mounted pages.
  expect(screen.getByTestId('pages')).toBe(before);
});
