// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botOwnedSessionNotificationTitle,
  findSessionNotificationSession,
  isReviewSessionNotificationTarget,
  sendSessionEventNotification,
} from '@/lib/sessionEventNotification';
import { applyRemoteSessionActivity, clearRemoteSessionActivity, getRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { SessionActivityRelay } from '../../main/agent-island/sessionActivityRelay';

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
  it.each(['before-clear', 'after-clear'])('does not notify for a cleared remote completion (%s)', order => {
    gates.feishu = true;
    const relay = new SessionActivityRelay(payload => applyRemoteSessionActivity('host', payload));
    const running = { sessionId: 'remote-silent', phase: 'running', recordStatus: 'active', compactDetail: 'Working', startedAtMs: 1, lastActivityAtMs: 1, currentActionSummary: 'Working', attention: false, workflow: null, turnGeneration: null, gracefulStopState: 'none', source: 'live' } as const;
    const notify = () => sendSessionEventNotification('remote-silent', 'Silent task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    relay.publish([running]);
    if (order === 'before-clear') notify();
    relay.publish([{ ...running, phase: 'completed', attention: false }]);
    expect(getRemoteSessionActivity('remote-silent', 'host')).toBeUndefined();
    if (order === 'after-clear') notify();
    relay.dispose();
    expect(showSessionEvent).not.toHaveBeenCalled();
  });

  it.each(['before-done', 'after-done'])('preserves remote unread without notifying for a silent completion (%s)', order => {
    gates.feishu = true;
    const notify = () => sendSessionEventNotification('remote-silent', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    applyRemoteSessionActivity('host', { sessionId: 'remote-silent', phase: 'running', attention: true });
    if (order === 'after-done') notify();
    applyRemoteSessionActivity('host', { sessionId: 'remote-silent', phase: 'completed', attention: true, completionNotification: 'silent' });
    if (order === 'before-done') notify();
    expect(showSessionEvent).not.toHaveBeenCalled();
    expect(getRemoteSessionActivity('remote-silent', 'host')).toMatchObject({ attention: true, completionNotification: 'silent' });
    applyRemoteSessionActivity('host', { sessionId: 'remote-silent', phase: 'running', attention: true });
    notify();
    applyRemoteSessionActivity('host', { sessionId: 'remote-silent', phase: 'completed', attention: true });
    expect(showSessionEvent).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    clearRemoteSessionActivity();
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
    clearRemoteSessionActivity();
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

  it('leaves the desktop toast of a remote device task to the main-process scope filter', () => {
    gates.feishu = true;

    sendSessionEventNotification('remote-1', 'Fix login', 'done', { remoteDevice: true });

    // 未读归属那台设备:本机 Dock 角标两条标记路径都不记。
    expect(markAttention).not.toHaveBeenCalled();
    expect(showSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        markAttention: false,
        channels: { desktop: false, feishu: true, mobile: true },
      }),
    );
  });

  it.each([true, false])('uses the execution host decision for remote mobile/Feishu completion calls (%s)', async handled => {
    gates.feishu = true;
    let resolve!: (handled: boolean) => void;
    const relay = new SessionActivityRelay(payload => applyRemoteSessionActivity('host', payload), {
      isCompletionHandledByTeammate: () => new Promise<boolean>(r => { resolve = r; }),
    });
    const running = { sessionId: 'remote-task', phase: 'running', recordStatus: 'active', compactDetail: 'Working', startedAtMs: 1, lastActivityAtMs: 1, currentActionSummary: 'Working', attention: false, workflow: null, turnGeneration: null, gracefulStopState: 'none', source: 'live' } as const;
    relay.publish([running]);
    // The native renderer transition can precede the activity relay frame.
    sendSessionEventNotification('remote-task', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    expect(showSessionEvent).not.toHaveBeenCalled();
    relay.awaitCompletionTerminal('remote-task');
    const completed = { ...running, phase: 'completed' as const, attention: true, compactDetail: 'Final result' };
    relay.publish([completed]);
    sendSessionEventNotification('remote-task', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    expect(showSessionEvent).not.toHaveBeenCalled();
    relay.completeTerminal('remote-task');
    await Promise.resolve();
    resolve(handled);
    await relay.waitForCompletionNotification('remote-task');
    expect(showSessionEvent).toHaveBeenCalledTimes(handled ? 0 : 1);
    if (!handled) expect(showSessionEvent).toHaveBeenCalledWith({ sessionId: 'remote-task', title: 'Task', kind: 'done', markAttention: false, channels: { desktop: false, feishu: true, mobile: true } });
    expect(markAttention).not.toHaveBeenCalled();
    expect(getRemoteSessionActivity('remote-task', 'host')).toMatchObject({ phase: 'completed', attention: true, compactDetail: 'Final result' });
    relay.replay([completed]);
    expect(showSessionEvent).toHaveBeenCalledTimes(handled ? 0 : 1);
    relay.dispose();
  });

  it.each(['running', 'read', 'error', 'needs-interaction'])('discards a pending remote completion on %s without losing action/error reminders', boundary => {
    gates.feishu = true;
    applyRemoteSessionActivity('host', { sessionId: 'remote-task', phase: 'completed', attention: true, completionNotification: 'pending' });
    sendSessionEventNotification('remote-task', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    applyRemoteSessionActivity('host', { sessionId: 'remote-task', phase: boundary === 'read' ? 'completed' : boundary, attention: boundary !== 'read' });
    expect(showSessionEvent).not.toHaveBeenCalled();
    if (boundary === 'error' || boundary === 'needs-interaction') {
      sendSessionEventNotification('remote-task', 'Task', boundary === 'error' ? 'error' : 'needs-reply', { remoteDevice: true, remoteDeviceId: 'host' });
      expect(showSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: boundary === 'error' ? 'error' : 'needs-reply', channels: { desktop: false, feishu: true, mobile: true } }));
    }
  });

  it.each(['focus', 'preferences'])('rechecks %s when remote handoff releases an ordinary completion', boundary => {
    gates.feishu = true;
    applyRemoteSessionActivity('host', { sessionId: 'remote-task', phase: 'completed', attention: true, completionNotification: 'pending' });
    sendSessionEventNotification('remote-task', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    if (boundary === 'focus') vi.mocked(document.hasFocus).mockReturnValue(true);
    else gates.feishu = false;
    applyRemoteSessionActivity('host', { sessionId: 'remote-task', phase: 'completed', attention: true });
    if (boundary === 'focus') expect(showSessionEvent).not.toHaveBeenCalled();
    else expect(showSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ channels: { desktop: false, feishu: false, mobile: true } }));
  });

  it('keeps old-host remote completion calls unchanged', () => {
    applyRemoteSessionActivity('old-host', { sessionId: 'legacy', phase: 'completed', attention: true });
    sendSessionEventNotification('legacy', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'old-host' });
    expect(showSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'done', channels: { desktop: false, feishu: false, mobile: true } }));
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

describe('tasks omitted from the task list', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'electronAPI'); });
  it('suppresses plugin background tasks resolved from the database, but not visible ones', async () => {
    const rows: Record<string, unknown> = {
      bg: { id: 'bg', source: 'plugin', hiddenAt: '2026-10-15T00:00:00.000Z' },
      shown: { id: 'shown', source: 'plugin', hiddenAt: null },
      review: { id: 'review', source: 'review' },
    };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { sessions: { get: async (id: string) => rows[id] ?? null } } },
    });
    expect(await isReviewSessionNotificationTarget('bg')).toBe(true);
    expect(await isReviewSessionNotificationTarget('review')).toBe(true);
    expect(await isReviewSessionNotificationTarget('shown')).toBe(false);
    expect(await isReviewSessionNotificationTarget('missing')).toBe(false);
  });
});
