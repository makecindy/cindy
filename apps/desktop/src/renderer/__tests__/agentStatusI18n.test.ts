import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { hasTurnResponse, localizeAgentStatus, remoteResponsePendingStatus, statusAgentLocation } from '@/features/cc-agent/lib/localizeAgentStatus';
import type { ChatMessage } from '@/lib/makerChatStore';

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('localizeAgentStatus', () => {
  it('uses the pending location only for the next send, with null meaning local', () => {
    expect(statusAgentLocation(null, 'remote', false)).toBe('remote');
    expect(statusAgentLocation('remote', null, false)).toBeNull();
    expect(statusAgentLocation('remote', undefined, false)).toBe('remote');
    expect(statusAgentLocation(null, 'remote', true)).toBeNull();
    expect(statusAgentLocation('remote', null, true)).toBe('remote');
  });
  // Regression: a remote turn with no response looked identical to local thinking.
  // Production status selector + localizer; unit tier, no transport or timer changes.
  it('distinguishes remote response waiting without changing local or terminal states', () => {
    const status = (device: string | null, running = true, raw = 'Thinking...') =>
      localizeAgentStatus(remoteResponsePendingStatus(raw, device, running, []), i18n.t);
    expect(status('remote-device')).toBe('正在等待远端响应…');
    expect(status('provider-share:share')).toBe('正在等待远端响应…');
    expect(status('remote-device', true, 'Alice,试试 /issue 给我们提反馈或建议')).toBe('正在等待远端响应…');
    expect(status(null)).toBe('正在思考…');
    expect(status('remote-device', false, 'Done')).toBe('已完成');
    expect(status('remote-device', true, 'Compacting...')).toBe('正在压缩上下文…');
    expect(status('remote-device', true, 'Waiting on approval')).toBe(localizeAgentStatus('Waiting on approval', i18n.t));
  });

  it.each(['assistant', 'thinking', 'tool_use', 'tool_result'] as const)(
    'restores normal status after remote %s activity, including after a steer', (role) => {
      const message = { clientId: 'activity', role, content: 'response', createdAt: new Date(1100).toISOString() } as ChatMessage;
      const steer = { clientId: 'steer', role: 'user', delivery: 'steer', content: 'more', createdAt: new Date(1200).toISOString() } as ChatMessage;
      expect(remoteResponsePendingStatus('Thinking...', 'remote', true, [message, steer])).toBe('Thinking...');
      expect(hasTurnResponse([message, steer])).toBe(true);
      expect(hasTurnResponse([message, steer], 'steer')).toBe(true);
      const nextInput = { ...steer, clientId: 'next', delivery: undefined };
      // #11113 / unit: send is marked before its user row echoes from main.
      // Old transcript activity must not absorb the newly submitted input.
      expect(hasTurnResponse([message], 'next')).toBe(false);
      expect(hasTurnResponse([message, nextInput], 'next')).toBe(false);
      expect(hasTurnResponse([message, nextInput, message], 'next')).toBe(true);
      expect(remoteResponsePendingStatus('Thinking...', 'remote', true, [message, nextInput])).toBe('Waiting for remote response');
      expect(hasTurnResponse([message, nextInput])).toBe(false);
      // A previous turn's background child can continue after the new user boundary.
      const background = { ...message, parentToolUseId: 'toolu_previous_background' };
      expect(hasTurnResponse([nextInput, background, steer])).toBe(false);
      expect(remoteResponsePendingStatus('Thinking...', 'remote', true, [nextInput, background])).toBe('Waiting for remote response');
      expect(hasTurnResponse([nextInput, background, message])).toBe(true);
    },
  );

  it('localizes Cindy-owned static status labels', () => {
    expect(localizeAgentStatus('Thinking...', i18n.t)).toBe('正在思考…');
    expect(localizeAgentStatus('Editing files...', i18n.t)).toBe('正在编辑文件…');
    expect(localizeAgentStatus('Working', i18n.t)).toBe('正在工作…');
    expect(localizeAgentStatus('Running', i18n.t)).toBe('运行中…');
    expect(localizeAgentStatus('Spawning agent...', i18n.t)).toBe('正在启动 Subagent…');
    expect(localizeAgentStatus('Done', i18n.t)).toBe('已完成');
  });

  it('keeps the command or tool name while localizing the running suffix', () => {
    expect(localizeAgentStatus('powershell running...', i18n.t)).toBe('powershell 运行中…');
    expect(localizeAgentStatus('mcp__cindy__tool running…', i18n.t)).toBe(
      'mcp__cindy__tool 运行中…',
    );
  });

  it('localizes Cindy-owned turn-start phrases without changing the user name', () => {
    expect(localizeAgentStatus('Just Wait ...', i18n.t)).toBe('请稍候…');
    expect(localizeAgentStatus('Nice day, Alice!', i18n.t)).toBe('正在处理，Alice');
    expect(localizeAgentStatus('Working on it, Alice', i18n.t)).toBe('正在处理，Alice');
    expect(localizeAgentStatus('Alice,试试 /issue 给我们提反馈或建议', i18n.t)).toBe(
      'Alice，试试用 /issue 给我们提反馈或建议',
    );
  });

  it('preserves arbitrary vendor status text verbatim', () => {
    expect(localizeAgentStatus('Still running', i18n.t)).toBe('Still running');
    expect(localizeAgentStatus('正在检查测试', i18n.t)).toBe('正在检查测试');
  });
});
