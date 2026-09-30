// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botOwnedSessionNotificationTitle,
  findSessionNotificationSession,
  sendSessionEventNotification,
} from '@/lib/sessionEventNotification';

const gates = vi.hoisted(() => ({
  desktop: true,
  feishu: false,
  islandEnabled: false,
  islandSupported: false,
}));

vi.mock('@/hooks/useNotificationSettings', () => ({
  getNotificationsEnabled: () => gates.desktop,
}));
vi.mock('@/hooks/useFeishuNotificationSettings', () => ({
  getFeishuNotificationsEnabled: () => gates.feishu,
}));
vi.mock('@/hooks/useAgentIslandSettings', () => ({
  getAgentIslandEnabled: () => gates.islandEnabled,
  isAgentIslandSupported: () => gates.islandSupported,
}));

const markAttention = vi.fn(() => Promise.resolve());
const showSessionEvent = vi.fn(() => Promise.resolve());

describe('shared session event notifications', () => {
  beforeEach(() => {
    gates.desktop = true;
    gates.feishu = false;
    gates.islandEnabled = false;
    gates.islandSupported = false;
    vi.clearAllMocks();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationMarkSessionAttention: markAttention,
      notificationShowSessionEvent: showSessionEvent,
      localDb: { bots: { list: vi.fn(async () => []) } },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the same desktop, Feishu and mobile channel gates for every sidebar', () => {
    gates.feishu = true;

    sendSessionEventNotification('session-1', 'LiZi · 修复登录', 'needs-reply');

    expect(markAttention).toHaveBeenCalledWith('session-1');
    expect(showSessionEvent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: 'LiZi · 修复登录',
      kind: 'needs-reply',
      channels: { desktop: true, feishu: true, mobile: true },
    });
  });

  it('lets Agent Island replace desktop notification without suppressing other channels', () => {
    gates.islandSupported = true;
    gates.islandEnabled = true;
    gates.feishu = true;

    sendSessionEventNotification('session-2', 'Cindy', 'done');

    expect(showSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { desktop: false, feishu: true, mobile: true },
      }),
    );
  });

  it('does not send external notifications while the user is already looking at Cindy', () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);

    sendSessionEventNotification('session-3', 'Dash', 'error');

    expect(markAttention).not.toHaveBeenCalled();
    expect(showSessionEvent).not.toHaveBeenCalled();
  });

  it('resolves a Bot name for sessions omitted from the ordinary task list', async () => {
    window.electronAPI.localDb.bots.list = vi.fn(async () => [{
      id: 'bot-lizi',
      name: 'LiZi',
      sessions: [{ id: 'bot-session', title: '修复登录' }],
    }]) as typeof window.electronAPI.localDb.bots.list;

    await expect(botOwnedSessionNotificationTitle('bot-session')).resolves.toBe(
      'LiZi · 修复登录',
    );
    await expect(botOwnedSessionNotificationTitle('missing')).resolves.toBeNull();
  });

  it('looks up a notification session across complete and remote snapshots', () => {
    const localVisible = [{ id: 'visible', title: 'Visible' }];
    const allLocal = [{ id: 'archived', title: 'Renamed archived task' }];
    const remote = [{ id: 'remote', title: 'Renamed remote task' }];

    expect(findSessionNotificationSession('archived', [localVisible, allLocal, remote])).toEqual(
      allLocal[0],
    );
    expect(findSessionNotificationSession('remote', [localVisible, allLocal, remote])).toEqual(
      remote[0],
    );
    expect(findSessionNotificationSession('missing', [localVisible, allLocal, remote])).toBeNull();
  });

  it('prefers a named snapshot when the visible snapshot still has the draft title', () => {
    const visible = [{ id: 'same-session', title: 'New Maker' }];
    const complete = [{ id: 'same-session', title: 'Renamed task' }];

    expect(findSessionNotificationSession('same-session', [visible, complete])).toEqual(
      complete[0],
    );
  });
});
