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
