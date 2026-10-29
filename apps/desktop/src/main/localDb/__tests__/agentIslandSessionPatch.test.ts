/**
 * agentIslandSessionPatch —— sessions patch 里灵动岛关心字段的转发口径。
 *
 * 「消息免打扰」只挡展示面：任务可能已经上岛了，静音后岛面要收起它；但事件摄取
 * 不能跟着断——侧栏卡片的实时活动、等待交互态与远端活动镜像都长在岛的状态机上。
 * 所以静音走的是「重发一次展示面」，而不是 archive/hidden 那样的 handleSessionClosed。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handleSessionClosed: vi.fn(),
  handleSessionMetadataPatch: vi.fn(),
  handleNotificationMuteChanged: vi.fn(),
  getAgentIslandService: vi.fn(),
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: h.getAgentIslandService,
}));

import { notifyAgentIslandSessionPatch } from '../agentIslandSessionPatch';

async function notify(patch: Record<string, unknown>): Promise<void> {
  notifyAgentIslandSessionPatch('session-1', patch);
  // 模块用动态 import 解耦，断言前把微任务队列排空。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getAgentIslandService.mockReturnValue({
    handleSessionClosed: h.handleSessionClosed,
    handleSessionMetadataPatch: h.handleSessionMetadataPatch,
    handleNotificationMuteChanged: h.handleNotificationMuteChanged,
  });
});

describe('notifyAgentIslandSessionPatch', () => {
  it('republishes the island so a muted task drops off it, without closing the session', async () => {
    await notify({ notificationsMuted: true });

    expect(h.handleNotificationMuteChanged).toHaveBeenCalledWith();
    // 关键：静音不是「关掉这个任务」，删条目会把侧栏实时活动一起带走。
    expect(h.handleSessionClosed).not.toHaveBeenCalled();
  });

  it('republishes again on unmute so the task can come back', async () => {
    await notify({ notificationsMuted: false });

    expect(h.handleNotificationMuteChanged).toHaveBeenCalledWith();
    expect(h.handleSessionClosed).not.toHaveBeenCalled();
    expect(h.handleSessionMetadataPatch).not.toHaveBeenCalled();
  });

  it('still closes archived, deleted and hidden tasks', async () => {
    await notify({ status: 'deleted' });
    await notify({ status: 'archived' });
    await notify({ hiddenAt: new Date(1).toISOString() });

    expect(h.handleSessionClosed).toHaveBeenCalledTimes(3);
    expect(h.handleSessionClosed).toHaveBeenCalledWith('session-1');
  });

  it('still forwards metadata patches', async () => {
    await notify({ title: 'Renamed' });

    expect(h.handleSessionClosed).not.toHaveBeenCalled();
    expect(h.handleSessionMetadataPatch).toHaveBeenCalledWith('session-1', {
      title: 'Renamed',
      workingDir: undefined,
      workspaceKind: undefined,
    });
  });
});
