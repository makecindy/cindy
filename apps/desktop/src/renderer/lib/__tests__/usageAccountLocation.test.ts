/**
 * 底部用量 chip 读哪台电脑的账号余量(场景:2026-10-09 用户反馈远程供应商的任务一直显示
 * 「等待配额数据更新」—— chip 拿任务所在电脑的同名账号去读,Agent 实际在另一台电脑)。
 */
import { describe, expect, it } from 'vitest';

import { resolveUsageAccountLocation } from '../usageAccountLocation';

const SELF = 'device-self';

describe('resolveUsageAccountLocation', () => {
  it('Agent 就在任务所在电脑:沿用任务所在电脑(本机或被控电脑)', () => {
    for (const taskDeviceId of [null, 'device-controlled']) {
      expect(
        resolveUsageAccountLocation({
          taskDeviceId,
          agentDeviceId: null,
          providerId: 'anthropic',
          selfDeviceId: SELF,
        }),
      ).toEqual({ kind: 'task' });
    }
    // 旧版被控电脑不投影 agentDeviceId(undefined),同样按被控电脑本身。
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: 'device-controlled',
        agentDeviceId: undefined,
        providerId: 'anthropic',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'task' });
  });

  it('本机任务的 Agent 在同账号另一台电脑:读那台', () => {
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: null,
        agentDeviceId: 'device-agent',
        providerId: 'anthropic',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'device', deviceId: 'device-agent' });
  });

  it('远程控制的任务把 Agent 放在第三台电脑:读第三台,不读被控电脑', () => {
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: 'device-controlled',
        agentDeviceId: 'device-agent',
        providerId: 'anthropic',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'device', deviceId: 'device-agent' });
  });

  it('远程控制的任务把 Agent 放在本机:读本机', () => {
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: 'device-controlled',
        agentDeviceId: SELF,
        providerId: 'anthropic',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'local' });
  });

  it('跟随挂着的换位置意图(undefined = 位置不变,null = 换回任务所在电脑)', () => {
    const base = { taskDeviceId: null, providerId: 'anthropic', selfDeviceId: SELF };
    expect(
      resolveUsageAccountLocation({
        ...base,
        agentDeviceId: null,
        pendingAgentDeviceId: 'device-agent',
      }),
    ).toEqual({ kind: 'device', deviceId: 'device-agent' });
    expect(
      resolveUsageAccountLocation({
        ...base,
        agentDeviceId: 'device-agent',
        pendingAgentDeviceId: null,
      }),
    ).toEqual({ kind: 'task' });
    expect(
      resolveUsageAccountLocation({
        ...base,
        agentDeviceId: 'device-agent',
        pendingAgentDeviceId: undefined,
      }),
    ).toEqual({ kind: 'device', deviceId: 'device-agent' });
  });

  it('别人分享的供应商、共享任务访客、没指定来源:读不到,不拿别的账号凑数', () => {
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: null,
        agentDeviceId: 'share:share-1',
        providerId: 'anthropic',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'unreadable' });
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: 'device-controlled',
        agentDeviceId: 'share:share-1',
        providerId: 'anthropic',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'unreadable' });
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: 'shared-task-peer',
        agentDeviceId: 'device-owner-other',
        providerId: 'anthropic',
        selfDeviceId: SELF,
        sharedTaskGuest: true,
      }),
    ).toEqual({ kind: 'unreadable' });
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: null,
        agentDeviceId: 'device-agent',
        providerId: null,
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'unreadable' });
    // 空白来源与手机端同口径,按没指定来源处理。
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: null,
        agentDeviceId: 'device-agent',
        providerId: ' ',
        selfDeviceId: SELF,
      }),
    ).toEqual({ kind: 'unreadable' });
  });

  it('SSH 远程工作区忽略残留的 agentDeviceId(与 main 同口径)', () => {
    expect(
      resolveUsageAccountLocation({
        taskDeviceId: null,
        agentDeviceId: 'device-agent',
        providerId: 'anthropic',
        selfDeviceId: SELF,
        remoteHostId: 'ssh-host',
      }),
    ).toEqual({ kind: 'task' });
  });
});
