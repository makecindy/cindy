import { describe, expect, it } from 'vitest';
import { eventText, formatSessionHeader, noConfiguredProviderMessage } from './terminal-chat.js';

describe('terminal chat event rendering', () => {
  it('renders the object-shaped Codex text event persisted by the runtime', () => {
    expect(eventText({
      type: 'agent_event',
      data: { type: 'text', data: { text: '你好，有什么需要我处理的？', isFinal: true } },
    })).toBe('你好，有什么需要我处理的？');
  });

  it('prints a thinking delta once and suppresses the duplicate final lifecycle event', () => {
    expect(eventText({
      type: 'agent_event',
      data: { type: 'thinking', data: { stage: 'delta', text: '正在思考' } },
    })).toBe('… 正在思考');
    expect(eventText({
      type: 'agent_event',
      data: { type: 'thinking', data: { stage: 'final', text: '正在思考' } },
    })).toBeNull();
  });

  it('explains a post-restart Cindy login expiry without suggesting a Codex login', () => {
    expect(noConfiguredProviderMessage('codex', {
      authenticated: false,
      error: 'Cindy login expired when the service restarted; run cindy login again',
    })).toContain('cindy login --sso XD');
  });

  it('renders a compact Codex-style session chrome without a You prompt', () => {
    const header = formatSessionHeader({
      id: 's1', workDir: '/srv/work/api', agentKind: 'codex', providerId: 'xd',
      model: 'gpt-5.6', effort: 'high', permissionMode: 'ask',
    });
    expect(header).toContain('/srv/work/api · codex · xd · gpt-5.6');
    expect(header).toContain('/settings');
    expect(header).not.toContain('You>');
  });
});
