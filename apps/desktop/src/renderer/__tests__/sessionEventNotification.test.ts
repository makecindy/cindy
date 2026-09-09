// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botOwnedSessionNotificationTitle,
  sendSessionEventNotification,
} from '@/lib/sessionEventNotification';

const gates = vi.hoisted(() => ({
  desktop: true,
  feishu: false,
  sound: true,
  islandEnabled: false,
  islandSupported: false,
}));

const sound = vi.hoisted(() => ({
  play: vi.fn(async () => true),
}));

vi.mock('@/hooks/useNotificationSettings', () => ({
  getNotificationsEnabled: () => gates.desktop,
  getSoundNotificationsEnabled: () => gates.sound,
}));
vi.mock('@/hooks/useFeishuNotificationSettings', () => ({
  getFeishuNotificationsEnabled: () => gates.feishu,
}));
vi.mock('@/hooks/useAgentIslandSettings', () => ({
  getAgentIslandEnabled: () => gates.islandEnabled,
  isAgentIslandSupported: () => gates.islandSupported,
}));
vi.mock('@/lib/notificationSound', () => ({
  playSessionEventSound: sound.play,
}));

const markAttention = vi.fn(() => Promise.resolve());
const showSessionEvent = vi.fn(() => Promise.resolve());

describe('shared session event notifications', () => {
  beforeEach(() => {
    gates.desktop = true;
    gates.feishu = false;
    gates.sound = true;
    gates.islandEnabled = false;
    gates.islandSupported = false;
    vi.clearAllMocks();
    sound.play.mockResolvedValue(true);
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

  it('uses the same desktop, Feishu and mobile channel gates for every sidebar', async () => {
    gates.feishu = true;

    await sendSessionEventNotification('session-1', 'LiZi · 修复登录', 'needs-reply');

    expect(markAttention).toHaveBeenCalledWith('session-1');
    expect(showSessionEvent).toHaveBeenCalledWith({
      sessionId: 'session-1',
      title: 'LiZi · 修复登录',
      kind: 'needs-reply',
      channels: { desktop: true, feishu: true, mobile: true, sound: true },
    });
  });

  it('lets Agent Island replace desktop notification without suppressing other channels', async () => {
    gates.islandSupported = true;
    gates.islandEnabled = true;
    gates.feishu = true;

    await sendSessionEventNotification('session-2', 'Cindy', 'done');

    expect(showSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { desktop: false, feishu: true, mobile: true, sound: false },
      }),
    );
    expect(sound.play).not.toHaveBeenCalled();
  });

  it('does not send external notifications while the user is already looking at Cindy', () => {
    vi.mocked(document.hasFocus).mockReturnValue(true);

    void sendSessionEventNotification('session-3', 'Dash', 'error');

    expect(markAttention).not.toHaveBeenCalled();
    expect(showSessionEvent).not.toHaveBeenCalled();
  });

  it('keeps the OS sound as fallback when application sound is disabled', async () => {
    gates.sound = false;

    await sendSessionEventNotification('session-4', 'Cindy', 'done');

    expect(sound.play).not.toHaveBeenCalled();
    expect(showSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { desktop: true, feishu: false, mobile: true, sound: false },
      }),
    );
  });

  it('resolves a Bot name for sessions omitted from the ordinary task list', async () => {
    window.electronAPI.localDb.bots.list = vi.fn(async () => [
      {
        id: 'bot-lizi',
        name: 'LiZi',
        sessions: [{ id: 'bot-session', title: '修复登录' }],
      },
    ]) as typeof window.electronAPI.localDb.bots.list;

    await expect(botOwnedSessionNotificationTitle('bot-session')).resolves.toBe('LiZi · 修复登录');
    await expect(botOwnedSessionNotificationTitle('missing')).resolves.toBeNull();
  });
});
