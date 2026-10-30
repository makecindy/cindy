// @vitest-environment jsdom

/**
 * 伙伴对话头部:名字/头像 + 设置齿轮,两个入口都跳设置页;电脑与切换都收进近况浮层,头部不再单列。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterAll(() => { HTMLElement.prototype.scrollIntoView = originalScrollIntoView; });

const navigate = vi.fn();
const deviceData = vi.hoisted(() => ({
  pathname: '/bots/bot-1/session/sess-1',
  local: [] as import('../botStore').BotProfile[],
  remote: [] as import('../remoteBotRoster').RemoteBot[],
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => deviceData.local, useBotUnreadCounts: () => ({}) }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => deviceData.remote }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => [] }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: deviceData.pathname, search: '' }),
}));
vi.mock('../feature-context', () => ({ useRegisterContentHeader: () => undefined }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="bot-avatar" /> }));
vi.mock('../BotGlancePopover', () => ({
  BotGlanceButton: ({ cloudHome }: { cloudHome: boolean }) => (
    <button type="button" data-cloud-home={String(cloudHome)}>bots.glance.open</button>
  ),
}));

const { BotSessionContentHeader } = await import('../BotSessionContentHeader');
const { resetCompanionCloudStoreForTests } = await import('../companionCloudStore');

const bot = { id: 'bot-1', name: '小可' };
const localCindy = { id: 'local-cindy', name: 'Cindy', templateId: 'cindy', status: 'active' } as import('../botStore').BotProfile;
const remoteCindy = { id: 'cindy-default', name: 'Cindy', deviceId: 'cloud', deviceName: 'Cloud',
  avatar: '', avatarColor: '', description: '', preview: '', activityAt: 0, sessionId: 'remote-chat', online: true };

function appRegionOf(element: HTMLElement): string {
  return (
    (element.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion ?? ''
  );
}

afterEach(() => {
  cleanup();
  resetCompanionCloudStoreForTests();
  navigate.mockClear();
  deviceData.local = [];
  deviceData.remote = [];
  deviceData.pathname = '/bots/bot-1/session/sess-1';
});

describe('BotSessionContentHeader', () => {
  it('keeps voice startup in the composer and configuration behind settings', () => {
    render(<BotSessionContentHeader bot={bot} />);
    expect(screen.queryByRole('button', { name: 'bots.voiceMode.title' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'bots.settings' }));
    expect(navigate).toHaveBeenCalledWith('/bots/bot-1/session/sess-1?settings=1');
  });

  it('keeps computers out of the header even when Cindy runs on several computers', () => {
    deviceData.local = [localCindy];
    deviceData.remote = [remoteCindy];
    render(<BotSessionContentHeader bot={localCindy} />);
    expect(screen.queryByRole('combobox', { name: 'bots.devicePicker.switchDevice' })).toBeNull();
    expect(screen.queryByText('Cloud')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('offers add-to-group only in an active local teammate’s canonical private chat', () => {
    deviceData.local = [localCindy];
    const view = render(<BotSessionContentHeader bot={{ ...localCindy, canonicalChat: true }} />);
    expect(screen.getByRole('button', { name: 'bots.groupChat.addFromChat.triggerFor' })).toBeTruthy();
    // Channel routes and read-only history reuse this header without the canonical flag.
    view.rerender(<BotSessionContentHeader bot={localCindy} />);
    expect(screen.queryByRole('button', { name: 'bots.groupChat.addFromChat.triggerFor' })).toBeNull();
    view.rerender(<BotSessionContentHeader bot={{ ...localCindy, canonicalChat: true, deviceId: 'cloud', deviceName: 'Cloud' }} />);
    expect(screen.queryByRole('button', { name: 'bots.groupChat.addFromChat.triggerFor' })).toBeNull();
  });

  it('opens settings and offers 近况 for a remote teammate with a live main task', () => {
    deviceData.remote = [remoteCindy];
    deviceData.pathname = '/bots/remote/cloud/cindy-default';
    render(<BotSessionContentHeader bot={remoteCindy} />);
    expect(screen.queryByText('Cloud')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Cindy' }));
    expect(navigate).toHaveBeenCalledWith('/bots/remote/cloud/cindy-default?settings=1');
    expect(screen.getByRole('button', { name: 'bots.glance.open' }).dataset.cloudHome).toBe('false');
  });

  it('leaves the header whitespace in the native window drag region', () => {
    render(<BotSessionContentHeader bot={bot} />);

    expect(appRegionOf(screen.getByTestId('bot-session-content-header'))).toBe('');
    expect(appRegionOf(screen.getByTitle('bots.settings'))).toBe('no-drag');
    expect(appRegionOf(screen.getByLabelText('bots.settings'))).toBe('no-drag');
  });

  it('opens settings from either the name lockup or the gear button', () => {
    render(<BotSessionContentHeader bot={bot} />);

    fireEvent.click(screen.getByTitle('bots.settings'));
    expect(navigate).toHaveBeenCalledWith('/bots/bot-1/session/sess-1?settings=1');

    fireEvent.click(screen.getByLabelText('bots.settings'));
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('keeps routine management out of the chat header', () => {
    render(<BotSessionContentHeader bot={bot} />);
    expect(screen.queryByRole('button', { name: 'routines.title' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('opens settings on the remote route from both entry points', () => {
    deviceData.pathname = '/bots/remote/remote-1/bot-1';
    render(<BotSessionContentHeader bot={{ ...bot, deviceId: 'remote-1', deviceName: 'Office' }} />);
    fireEvent.click(screen.getByRole('button', { name: '小可' }));
    fireEvent.click(screen.getByRole('button', { name: 'bots.settings' }));
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate.mock.calls).toEqual([
      ['/bots/remote/remote-1/bot-1?settings=1'],
      ['/bots/remote/remote-1/bot-1?settings=1'],
    ]);
    expect(screen.queryByRole('button', { name: 'routines.title' })).toBeNull();
    expect(screen.queryByText('Office')).toBeNull();
  });

  it('keeps every colour on semantic tokens so both modes come out right', () => {
    render(<BotSessionContentHeader bot={bot} />);
    const className = screen.getByLabelText('bots.settings').className;
    expect(className).toMatch(/text-\[var\(--text-tertiary\)\]/);
    expect(className).toMatch(/hover:bg-\[var\(--surface-hover\)\]/);
    // Header action controls follow the current pill-first design rules.
    expect(className).not.toMatch(/shadow|gradient/);
    expect(className).toMatch(/rounded-full/);
  });

  it('hands a cloud companion to 近况 as one teammate instead of listing per-computer copies', () => {
    resetCompanionCloudStoreForTests({ enabled: true, selfDeviceId: 'desk', humanActorId: 'human', demotedBotIds: [],
      actors: [{ id: 'a-cindy', externalId: 'cindy-default', name: 'Cindy', avatar: null, homeDeviceId: 'cloud',
        homeDevice: { deviceId: 'cloud', name: 'Cloud', online: true, isSelf: false } }] });
    deviceData.local = [localCindy];
    deviceData.remote = [remoteCindy];
    render(<BotSessionContentHeader bot={remoteCindy} />);
    expect(screen.getByRole('button', { name: 'bots.glance.open' }).dataset.cloudHome).toBe('true');
    expect(screen.queryByRole('combobox', { name: 'bots.devicePicker.switchDevice' })).toBeNull();
    expect(screen.queryByText('Cloud')).toBeNull();
  });
});
