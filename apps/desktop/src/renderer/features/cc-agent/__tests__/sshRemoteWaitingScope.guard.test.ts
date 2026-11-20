import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { remoteWaitingScope } from '@/features/cc-agent/lib/localizeAgentStatus';

/**
 * #11720:SSH 远端会话发消息后到首帧之间,状态栏不能空着。
 *
 * SSH 会话没有 agentDeviceId(agent 跑在远端机上),以前按「本机会话」处理,
 * 于是主机侧的远端预检跑完之前既没有等待态,starting 标记也一直不收口。
 * 这里钉两件事:适用范围怎么算,以及会话视图确实按这个范围判定等待态。
 */
describe('remoteWaitingScope', () => {
  it('本机会话不算在等远端', () => {
    expect(remoteWaitingScope(null, null)).toBe(false);
    expect(remoteWaitingScope(undefined, undefined)).toBe(false);
  });

  it('device-link 会话按 agentDeviceId 算', () => {
    expect(remoteWaitingScope('remote-device', null)).toBe(true);
  });

  it('SSH 远端会话按 remoteHostId 算', () => {
    expect(remoteWaitingScope(null, 'ssh-host-1')).toBe(true);
  });
});

describe('会话视图按等待范围判定(源码级守卫)', () => {
  const source = readFileSync(
    new URL('../CCAgentSessionView.tsx', import.meta.url),
    'utf8',
  );

  it('等待范围同时认 agentDeviceId 与 remoteHostId', () => {
    expect(source).toContain(
      'const remoteWaiting = remoteWaitingScope(statusAgentDeviceId, session?.remoteHostId);',
    );
  });

  it('等待态与 starting 收口都用这个范围,不再只看 agentDeviceId', () => {
    expect(source).toContain(
      'const waitingRemoteStart = Boolean(remoteWaiting && sessionId',
    );
    expect(source).toContain(
      'remoteWaiting && sessionId && (agentStatus.isRunning || receivedRemoteResponse',
    );
    expect(source).not.toContain(
      'const waitingRemoteStart = Boolean(statusAgentDeviceId && sessionId',
    );
  });
});
