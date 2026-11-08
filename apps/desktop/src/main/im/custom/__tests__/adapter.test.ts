/**
 * 自定义渠道的伙伴落点: 指定的 ownerConversationId 走伙伴主任务,
 * 其余 conversationId 各走一条隐藏专线(与其它 IM 渠道同一套语义)。
 */

import { describe, expect, it } from 'vitest';
import type { CustomIM } from '@cindy/im';

import { buildCustomAdapter } from '../adapter';
import type { ImOrchestratorConfig } from '../../shared/types';

const config: ImOrchestratorConfig = {
  agentKind: 'claude-code',
  defaultModel: 'claude-x',
  defaultPermissionMode: 'auto',
};

const fakeIm = {} as CustomIM;

describe('custom adapter companion lanes', () => {
  it('指定主会话时走 owner-dm, 其余走 guest-dm', () => {
    const adapter = buildCustomAdapter(fakeIm, config, {
      connectionId: 'c1',
      displayName: 'ERP',
      ownerConversationId: 'cli-1',
    });
    expect(adapter.companionLane?.('cli-1')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('cli-2')).toEqual({ kind: 'guest-dm', userId: 'cli-2' });
  });

  it('没配主会话时全部走 guest-dm', () => {
    const adapter = buildCustomAdapter(fakeIm, config, {
      connectionId: 'c1',
      displayName: 'ERP',
    });
    expect(adapter.companionLane?.('cli-1')).toEqual({ kind: 'guest-dm', userId: 'cli-1' });
  });
});
