import { DEFAULT_AGENT_ISLAND_SOUND_SETTINGS } from '../../shared/agentIsland';
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
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const gates = vi.hoisted(() => ({
  desktop: true,
  feishu: false,
  islandEnabled: false,
  soundEnabled: true,
  completionSound: true,
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
  getAgentIslandSoundSettings: () => ({ enabled: gates.soundEnabled, sounds: { ...DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds, complete: gates.completionSound ? DEFAULT_AGENT_ISLAND_SOUND_SETTINGS.sounds.complete : { type: 'builtin', id: 'none' } } }),
  isAgentIslandSupported: () => gates.islandSupported,
}));

const markAttention = vi.fn(() => Promise.resolve());
const showSessionEvent = vi.fn<typeof window.electronAPI.notificationShowSessionEvent>(() => Promise.resolve());
const getSession = vi.fn(async (): Promise<unknown> => ({ source: 'desktop', feishuOpenId: null }));
const resolveBinding = vi.fn(async () => ({ attached: false }));

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
    gates.soundEnabled = true;
    gates.completionSound = true;
    gates.islandSupported = false;
    vi.clearAllMocks();
    getSession.mockResolvedValue({ source: 'desktop', feishuOpenId: null });
    resolveBinding.mockResolvedValue({ attached: false });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      notificationMarkSessionAttention: markAttention,
      notificationShowSessionEvent: showSessionEvent,
      localDb: { bots: { list: vi.fn(async () => []) }, sessions: { get: getSession } },
      binding: { resolveSession: resolveBinding },
    };
  });

  afterEach(() => {
    clearRemoteSessionActivity();
    setDataOwnerGeneration(null);
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

  // #9317 / unit: the production sender is the only place that reaches main.
  // A needs-reply or error must carry the turn identity the hook built, or main
  // never records it and the same event toasts again. A completion keeps its own
  // turn identity there, so its id must not ride along (main rejects it).
  it('forwards the alert identity for a needs-reply or error and drops it on completion', () => {
    sendSessionEventNotification('session-1', 'Task', 'needs-reply', { alertEventId: 'turn:100:ask:1' });
    sendSessionEventNotification('session-1', 'Task', 'error', { alertEventId: 'turn:100:error' });
    sendSessionEventNotification('session-1', 'Task', 'done', { alertEventId: 'turn:100:error' });

    expect(showSessionEvent.mock.calls.map(([payload]) => payload.alertEventId)).toEqual([
      'turn:100:ask:1', 'turn:100:error', undefined,
    ]);
  });

  it('keeps the desktop reminder but skips duplicate phone and Feishu delivery for an input handoff', () => {
    gates.feishu = true;

    sendSessionEventNotification('handoff-session', 'Task', 'needs-reply', { mobile: false, feishu: false });

    expect(markAttention).toHaveBeenCalledWith('handoff-session');
    expect(showSessionEvent).toHaveBeenCalledWith({
      sessionId: 'handoff-session',
      title: 'Task',
      kind: 'needs-reply',
      channels: { desktop: true, feishu: false, mobile: false },
    });
  });

  // #6754 review 4373832299 / unit: persisted sources and bindings do not prove
  // that this request has an IM pointer. Main resolves the actual request target.
  it.each([
    { source: 'desktop', openId: null, attached: false, fallback: true },
    { source: 'feishu', openId: 'ou_native', attached: false, fallback: true },
    { source: 'desktop', openId: 'ou_legacy', attached: false, fallback: true },
    { source: 'desktop', openId: null, attached: true, fallback: true },
    { source: 'telegram', openId: null, attached: false, fallback: true },
    { source: 'slack', openId: null, attached: false, fallback: true },
    { source: 'discord', openId: null, attached: false, fallback: true },
  ])('passes handoff identity to Main regardless of persisted source: %j', async entry => {
    gates.feishu = true;
    getSession.mockResolvedValue({ source: entry.source, feishuOpenId: entry.openId });
    resolveBinding.mockResolvedValue({ attached: entry.attached });

    sendSessionEventNotification('handoff', 'Task', 'needs-reply', { inputHandoff: true, inputHandoffRequestId: 'request-1' });
    // Desktop must not wait for the asynchronous route lookup.
    expect(showSessionEvent).toHaveBeenCalledWith({
      sessionId: 'handoff', title: 'Task', kind: 'needs-reply',
      channels: { desktop: true, feishu: false, mobile: false },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(showSessionEvent.mock.calls.map(([payload]) => payload.channels)).toEqual([
      { desktop: true, feishu: false, mobile: false },
      ...(entry.fallback ? [{ desktop: false, feishu: true, mobile: false }] : []),
    ]);
    expect(markAttention).toHaveBeenCalledTimes(1);
    if (entry.fallback) expect(showSessionEvent).toHaveBeenLastCalledWith({
      sessionId: 'handoff', title: 'Task', kind: 'needs-reply', markAttention: false,
      inputHandoffRequestId: 'request-1',
      channels: { desktop: false, feishu: true, mobile: false },
    });
  });

  it.each(['owner-change', 'setting-off', 'focused', 'read-failed'] as const)(
    'drops a pending handoff Feishu fallback after %s', async change => {
      gates.feishu = true;
      let release!: (row: unknown) => void;
      getSession.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
      sendSessionEventNotification('handoff', 'Task', 'needs-reply', { inputHandoff: true, inputHandoffRequestId: 'request-1' });
      if (change === 'owner-change') setDataOwnerGeneration('another-owner');
      if (change === 'setting-off') gates.feishu = false;
      if (change === 'focused') vi.mocked(document.hasFocus).mockReturnValue(true);
      release(change === 'read-failed' ? null : { source: 'desktop' });
      await Promise.resolve();
      await Promise.resolve();
      expect(showSessionEvent).toHaveBeenCalledTimes(1);
      expect(showSessionEvent).toHaveBeenCalledWith({
        sessionId: 'handoff', title: 'Task', kind: 'needs-reply',
        channels: { desktop: true, feishu: false, mobile: false },
      });
    },
  );

  it('keeps remote handoff routing on the execution host without querying local IM bindings', () => {
    gates.feishu = true;
    sendSessionEventNotification('remote-handoff', 'Task', 'needs-reply', {
      inputHandoff: true, remoteDevice: true, remoteDeviceId: 'host',
    });
    expect(showSessionEvent).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'remote-handoff', title: 'Task', kind: 'needs-reply', markAttention: false, remoteDeviceId: 'host',
      channels: { desktop: false, feishu: false, mobile: false },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
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

  // Unit: the old island gate swallowed the OS notification selected as the sound source.
  it('keeps the OS notification available for an unconfigured event sound with the island enabled', () => {
    gates.islandSupported = true;
    gates.islandEnabled = true;
    gates.completionSound = false;
    sendSessionEventNotification('system-sound', 'Task', 'done');
    expect(showSessionEvent).toHaveBeenLastCalledWith(expect.objectContaining({ channels: { desktop: true, feishu: false, mobile: true } }));
    sendSessionEventNotification('system-sound', 'Task', 'needs-reply');
    expect(showSessionEvent).toHaveBeenLastCalledWith(expect.objectContaining({ channels: { desktop: false, feishu: false, mobile: true } }));
    gates.soundEnabled = false;
    sendSessionEventNotification('system-sound', 'Task', 'needs-reply');
    expect(showSessionEvent).toHaveBeenLastCalledWith(expect.objectContaining({ channels: { desktop: true, feishu: false, mobile: true } }));
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

  // Older execution hosts send pending, then teammate (or nothing) for a V1 background task's
  // completion; newer hosts never send either. The controller keeps honouring both.
  it.each([true, false])('uses an older execution host decision for remote mobile/Feishu completion calls (%s)', async handled => {
    gates.feishu = true;
    const frame = { sessionId: 'remote-task', phase: 'completed', attention: true, compactDetail: 'Final result' } as const;
    applyRemoteSessionActivity('host', { ...frame, completionNotification: 'pending' });
    sendSessionEventNotification('remote-task', 'Task', 'done', { remoteDevice: true, remoteDeviceId: 'host' });
    expect(showSessionEvent).not.toHaveBeenCalled();
    applyRemoteSessionActivity('host', { ...frame, ...(handled ? { completionNotification: 'teammate' as const } : {}) });
    await Promise.resolve();
    expect(showSessionEvent).toHaveBeenCalledTimes(handled ? 0 : 1);
    if (!handled) expect(showSessionEvent).toHaveBeenCalledWith({ sessionId: 'remote-task', title: 'Task', kind: 'done', markAttention: false, remoteDeviceId: 'host', channels: { desktop: false, feishu: true, mobile: true } });
    expect(markAttention).not.toHaveBeenCalled();
    expect(getRemoteSessionActivity('remote-task', 'host')).toMatchObject({ phase: 'completed', attention: true, compactDetail: 'Final result' });
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
