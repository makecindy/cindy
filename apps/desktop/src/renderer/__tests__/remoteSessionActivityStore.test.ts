/**
 * remoteSessionActivityStore.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖:控制端 device-link 远程会话活动镜像的保留语义(与手机端
 * remoteSessionStore.applySessionActivity 对齐)——
 *   running / needs-interaction 写入;completed / error 未读(attention=true)保留;
 *   已读收尾包删除;设备级清扫与全清。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
  dropStaleRemoteTerminalActivity,
  getRemoteSessionActivity,
  isRemoteSessionActivityActive,
  removeRemoteSessionActivityEntry,
  removeRemoteSessionActivityForDevice,
} from '../features/device-link/remoteSessionActivityStore';

describe('remoteSessionActivityStore', () => {
  beforeEach(() => clearRemoteSessionActivity());

  it('keeps active phases and unread terminal phases, drops read terminals', () => {
    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'running',
      compactDetail: 'run tests',
    });
    expect(getRemoteSessionActivity('s1')).toMatchObject({ phase: 'running', attention: false });

    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'needs-interaction',
      compactDetail: '',
      interactionKind: 'ask_user_question',
      attention: true,
    });
    expect(getRemoteSessionActivity('s1')).toMatchObject({
      phase: 'needs-interaction',
      interactionKind: 'ask_user_question',
    });

    // 完成未读:保留(右槽绿点)
    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: true,
    });
    expect(getRemoteSessionActivity('s1')).toMatchObject({ phase: 'completed', attention: true });

    // 出错未读:保留(右槽红点)
    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'error',
      compactDetail: '',
      attention: true,
    });
    expect(getRemoteSessionActivity('s1')).toMatchObject({ phase: 'error', attention: true });

    // 已读收尾包(attention=false 终态)→ 删除,行回落时间
    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: false,
    });
    expect(getRemoteSessionActivity('s1')).toBeUndefined();
  });

  it('classifies only in-flight phases as active turns', () => {
    expect(
      isRemoteSessionActivityActive({
        sessionId: 's1',
        phase: 'running',
        compactDetail: '',
        attention: false,
      }),
    ).toBe(true);
    expect(
      isRemoteSessionActivityActive({
        sessionId: 's1',
        phase: 'needs-interaction',
        compactDetail: '',
        attention: true,
      }),
    ).toBe(true);
    expect(
      isRemoteSessionActivityActive({
        sessionId: 's1',
        phase: 'completed',
        compactDetail: '',
        attention: true,
      }),
    ).toBe(false);
    expect(
      isRemoteSessionActivityActive({
        sessionId: 's1',
        phase: 'error',
        compactDetail: '',
        attention: true,
      }),
    ).toBe(false);
    expect(isRemoteSessionActivityActive(undefined)).toBe(false);
  });

  it('ignores malformed payloads', () => {
    applyRemoteSessionActivity('dev-1', null);
    applyRemoteSessionActivity('dev-1', { phase: 'running' });
    applyRemoteSessionActivity('dev-1', { sessionId: 's1', phase: 'nope' });
    expect(getRemoteSessionActivity('s1')).toBeUndefined();
  });

  it('sweeps entries per device and per session', () => {
    applyRemoteSessionActivity('dev-1', { sessionId: 's1', phase: 'running', compactDetail: '' });
    applyRemoteSessionActivity('dev-2', { sessionId: 's2', phase: 'running', compactDetail: '' });

    removeRemoteSessionActivityForDevice('dev-1');
    expect(getRemoteSessionActivity('s1')).toBeUndefined();
    expect(getRemoteSessionActivity('s2')).toMatchObject({ phase: 'running' });

    removeRemoteSessionActivityEntry('s2');
    expect(getRemoteSessionActivity('s2')).toBeUndefined();
  });

  it('drops unread completed/error mirrors but keeps an in-flight remote turn', () => {
    applyRemoteSessionActivity('dev-1', {
      sessionId: 'done',
      phase: 'completed',
      compactDetail: '',
      attention: true,
    });
    applyRemoteSessionActivity('dev-1', {
      sessionId: 'err',
      phase: 'error',
      compactDetail: '',
      attention: true,
    });
    applyRemoteSessionActivity('dev-1', {
      sessionId: 'run',
      phase: 'running',
      compactDetail: '',
    });
    dropStaleRemoteTerminalActivity('done');
    dropStaleRemoteTerminalActivity('err');
    dropStaleRemoteTerminalActivity('run');
    expect(getRemoteSessionActivity('done')).toBeUndefined();
    expect(getRemoteSessionActivity('err')).toBeUndefined();
    expect(getRemoteSessionActivity('run')).toMatchObject({ phase: 'running' });
  });

  it('keeps snapshot reference stable when payload content is unchanged', () => {
    applyRemoteSessionActivity('dev-1', { sessionId: 's1', phase: 'running', compactDetail: 'x' });
    const first = getRemoteSessionActivity('s1');
    applyRemoteSessionActivity('dev-1', { sessionId: 's1', phase: 'running', compactDetail: 'x' });
    expect(getRemoteSessionActivity('s1')).toBe(first);
  });
});
