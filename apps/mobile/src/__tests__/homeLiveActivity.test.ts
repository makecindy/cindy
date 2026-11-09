import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_ACTIVITY_CHANNEL } from '@cindy/device-link';
import { i18n } from '@/i18n';
import { buildMobileHomePresentation } from '@/session/mobileHome';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import {
  buildRemoteSessionCardPreview,
  type RemoteSessionLiveActivity,
} from '@/session/sessionList';
import type { RemoteSession } from '@/session/types';
import { projectAgentActivity, readTaskBadgeCount, summarizeAgentActivities } from '@/widgets/agentActivity';

function session(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: 'Mobile live activity',
    workingDir: '/repo/xdt-maker',
    workspaceKind: 'project',
    model: 'claude',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function buildLiveActivityIndex(sessions: readonly RemoteSession[]): Map<string, RemoteSessionLiveActivity> {
  const entries: Array<[string, RemoteSessionLiveActivity]> = [];
  for (const item of sessions) {
    const liveActivity = remoteSessionStore.getSessionLiveActivity(item.id);
    if (liveActivity) entries.push([item.id, liveActivity]);
  }
  return new Map(entries);
}

describe('mobile Home live activity', () => {
  beforeEach(() => remoteSessionStore.clear());

  // Unit: approved badge rule is waiting + unread terminal tasks, never running
  // or push count. Existing Home row tests did not exercise aggregate counts.
  // Real host pushes below prove a read acknowledgement reduces the same source
  // used by the island projection and the Android/iOS badge.
  it('shares exact deduplicated counts between the island and task badges', () => {
    const phases = ['needs-interaction', 'needs-interaction', 'running', 'running', 'running',
      'completed', 'completed', 'completed', 'error'] as const;
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', phases.map((_, index) => session(`s${index}`)));
    phases.forEach((phase, index) => remoteSessionStore.applyRemotePush('dev-1', SESSION_ACTIVITY_CHANNEL, {
      sessionId: `s${index}`, phase, compactDetail: '', attention: true,
    }));
    const rows = remoteSessionStore.getHomeSessions();
    const read = (row: RemoteSession) => remoteSessionStore.getSessionLiveActivity(row.id, row.deviceLinkDeviceId);
    const labels = { attention: 'Waiting', running: 'Running', completed: 'Done', error: 'Error' };
    const island = projectAgentActivity(rows, read, labels, row => `/sessions/${row.id}`, 'Stale');
    expect(island).toMatchObject({ attentionCount: 2, runningCount: 3, unreadCompletedCount: 4, badgeCount: 6 });
    expect(summarizeAgentActivities([...rows, ...rows], read).badgeCount).toBe(6);
    const badge = (online = true) => readTaskBadgeCount(remoteSessionStore.getHomeSessions(), 'user-1',
      remoteSessionStore.getSessionSnapshotDeviceIds(), () => online, read);
    expect(badge()).toBe(island?.badgeCount);
    expect(badge(false)).toBeUndefined();
    remoteSessionStore.applyRemotePush('dev-1', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 's5', phase: 'completed', compactDetail: '', attention: false,
    });
    expect(badge()).toBe(5);
    expect(readTaskBadgeCount(rows, 'other-user', ['dev-1'], () => true, read)).toBe(0);
    expect(summarizeAgentActivities(rows.map(row => ({ ...row, status: 'archived' })), read).badgeCount).toBe(0);
    expect(summarizeAgentActivities(rows.map(row => ({ ...row, pendingLocalCreation: true })), read).badgeCount).toBe(0);
    expect(readTaskBadgeCount(rows.map(row => ({ ...row, cacheSeeded: true })), 'user-1', ['dev-1'], () => true, read)).toBeUndefined();
  });

  it('distinguishes cold state from a received empty snapshot and notifies badge subscribers', async () => {
    const count = () => readTaskBadgeCount(remoteSessionStore.getHomeSessions(), 'user-1',
      remoteSessionStore.getSessionSnapshotDeviceIds(), remoteSessionStore.isDeviceHomeSnapshotReady, () => null);
    expect(count()).toBeUndefined();
    const seen: Array<number | undefined> = [];
    const unsubscribe = remoteSessionStore.subscribeHomeStatus(() => { seen.push(count()); });
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', []);
    await Promise.resolve();
    expect(count()).toBeUndefined();
    remoteSessionStore.setDeviceHomeSnapshot('dev-1', 'Mac', [],
      { format: 'active-sessions-v2', sessions: [] }, remoteSessionStore.captureActiveSessionSnapshotEpoch());
    await Promise.resolve();
    expect(count()).toBe(0);
    expect(seen).toContain(0);
    unsubscribe();
  });

  // Unit regression #9547: publishInitial can precede teammate enrichment and
  // maker:list-active. List-only coverage cannot prove that a zero is complete.
  it('preserves the badge until the complete Home list and activity snapshot arrive', () => {
    const count = () => readTaskBadgeCount(remoteSessionStore.getHomeSessions(), 'user-1',
      remoteSessionStore.getSessionSnapshotDeviceIds(), remoteSessionStore.isDeviceHomeSnapshotReady,
      row => remoteSessionStore.getSessionLiveActivity(row.id, row.deviceLinkDeviceId));
    const rows = [session('ordinary'), session('teammate')];
    const activity = { format: 'active-sessions-v2', sessions: [
      { sessionId: 'teammate', isTurnRunning: false, activityPhase: 'needs-interaction', activityAttention: true },
    ] };
    const publish = (response: unknown = activity) => remoteSessionStore.setDeviceHomeSnapshot(
      'dev-1', 'Mac', rows, response, remoteSessionStore.captureActiveSessionSnapshotEpoch());
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('ordinary')]);
    expect(count()).toBeUndefined();
    // A detail-page activity read cannot declare Home's teammate enrichment done.
    remoteSessionStore.setActiveSessionSnapshots('dev-1', activity);
    expect(count()).toBeUndefined();
    publish();
    expect(count()).toBe(1);
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', rows);
    expect(count()).toBeUndefined();
    publish();
    expect(count()).toBe(1);
    remoteSessionStore.markDeviceOffline('dev-1');
    expect(count()).toBeUndefined();
    // Unsupported, legacy and malformed responses cannot certify missing activity.
    for (const response of [null, [], { format: 'active-sessions-v2' }]) {
      publish(response);
      expect(count()).toBeUndefined();
    }
    publish();
    expect(count()).toBe(1);
    publish({ format: 'active-sessions-v2', sessions: [] });
    expect(count()).toBe(0);
    remoteSessionStore.removeDevice('dev-1');
    expect(count()).toBeUndefined();
    publish();
    remoteSessionStore.clear();
    expect(count()).toBeUndefined();
  });

  it('keeps unread completed/error live activity for the right-slot dots and clears once read', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);

    // 完成未读:条目保留(右槽绿点靠 phase+attention 点亮),运行态收敛为 false
    remoteSessionStore.applyRemotePush('dev-1', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: 'run tests',
      attention: true,
    });
    expect(remoteSessionStore.getSessionLiveActivity('s1')).toMatchObject({
      phase: 'completed',
      attention: true,
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);

    // 出错未读同理(右槽红点)
    remoteSessionStore.applyRemotePush('dev-1', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 's1',
      phase: 'error',
      compactDetail: '',
      attention: true,
    });
    expect(remoteSessionStore.getSessionLiveActivity('s1')).toMatchObject({
      phase: 'error',
      attention: true,
    });

    // 已读(attention=false 的收尾包)→ 条目清除,右槽回落时间
    remoteSessionStore.applyRemotePush('dev-1', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: false,
    });
    expect(remoteSessionStore.getSessionLiveActivity('s1')).toBeNull();
  });

  it('surfaces sessions-stream compactDetail as the running Home row preview', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.applyRemotePush('dev-1', SESSION_ACTIVITY_CHANNEL, {
      sessionId: 's1',
      phase: 'running',
      compactDetail: '正在检查失败测试',
    });

    const sessions = remoteSessionStore.getSessions();
    const home = buildMobileHomePresentation({
      devices: [{
        canOpen: true,
        deviceId: 'dev-1',
        name: 'Mac',
        state: 'ready',
        statusLabel: '已同步',
      }],
      liveActivityIndex: buildLiveActivityIndex(sessions),
      now: Date.parse('2026-01-01T00:00:10.000Z'),
      sessions,
    });
    const item = home.projects[0]?.sessions[0];

    expect(item?.liveActivity?.compactDetail).toBe('正在检查失败测试');
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(item ? buildRemoteSessionCardPreview(item, { running: true }) : null).toBe('正在检查失败测试');
  });

  it('preserves a real project basename that matches the shared fallback copy', async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage('en');
      const home = buildMobileHomePresentation({
        devices: [{ canOpen: true, deviceId: 'dev-1', name: 'Mac' }],
        sessions: [session('same-as-fallback', {
          deviceLinkDeviceId: 'dev-1',
          deviceLinkDeviceName: 'Mac',
          workingDir: '/repo/未分类项目',
        })],
      });

      expect(home.projects[0]?.title).toBe('未分类项目');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('preserves a real device name that matches the shared fallback copy', async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage('en');
      const home = buildMobileHomePresentation({
        devices: [{ canOpen: true, deviceId: 'dev-1', name: '未知电脑' }],
        sessions: [session('device-name-matches-fallback', {
          deviceLinkDeviceId: 'dev-1',
        })],
      });

      expect(home.projects[0]?.deviceName).toBe('未知电脑');
      expect(home.projects[0]?.subtitle).toContain('未知电脑');
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});
