/**
 * errorMessageRestore.test.ts
 * ---------------------------------------------------------------------------
 * terminal error 持久化行(role='error',main 的 onTurnErrorEvent 落库)的历史
 * 恢复路径:mapServerMessages 把 DB 行还原成 ChatMessage(content=message 文案、
 * errorReason=稳定 i18n key),供 MessageStream 渲染 ErrorMessageCard。
 *
 * 背景:error 此前只存内存,后台失败重开会话毫无痕迹(红点无从追溯)。这组用例
 * 锁住恢复形态 —— 若映射分支被删或字段漂移,失败记录又会静默退化成生 JSON 兜底行。
 * 纯 reducer,node env。
 */

import { describe, it, expect } from 'vitest';

import { makerChatStore } from '@/lib/makerChatStore';
import type { Message } from '@/lib/ccAgent.types';
import { ERROR_REASON_I18N_KEYS } from '@/components/chat/ErrorMessageCard';
import { UPSTREAM_OVERLOAD_REASON } from '@/utils/overloadError';

const SESSION_ID = 's-err';

function errorRow(clientId: string, content: unknown): Message {
  return {
    id: `row-${clientId}`,
    clientId,
    sessionId: SESSION_ID,
    role: 'error',
    content,
    createdAt: '2026-07-03T00:00:00.000Z',
  } as unknown as Message;
}

describe('mapServerMessages — persisted terminal error rows', () => {
  it('maps Codex Auto reviewer failures to the stable localized reason key', () => {
    expect(ERROR_REASON_I18N_KEYS['codex-auto-review-unavailable']).toBe(
      'logic.errors.codexAutoReviewUnavailable',
    );
  });

  it('maps upstream overload to the same copy the tail banner uses', () => {
    // 本表注释的一致性诉求: 同一条过载错误不能出现「尾部红条本地化、历史静态卡
    // 英文原文」的分裂。复用 banner 那条 key(不新增文案), 且 codex 改措辞也不影响
    // —— 判定走的是稳定 reason key, 不是原文。
    expect(ERROR_REASON_I18N_KEYS[UPSTREAM_OVERLOAD_REASON]).toBe(
      'chat.errorBanner.overloadBusyNoRetry',
    );
  });

  it('restores the overload reason from persisted rows so history can localize it', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      errorRow('e-overload', {
        // 文案故意不含 `at capacity`: codex 改了措辞后历史行仍要能本地化。
        message: 'The upstream declined this request.',
        reason: UPSTREAM_OVERLOAD_REASON,
      }),
    ]);
    expect(mapped[0]).toMatchObject({
      clientId: 'e-overload',
      role: 'error',
      errorReason: UPSTREAM_OVERLOAD_REASON,
    });
  });

  it('restores message text and errorReason from structured content', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      errorRow('e1', {
        message: '任务执行失败（模型未返回错误详情）。',
        reason: 'turn-failed',
        sdkError: 'invalid_request',
      }),
    ]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      clientId: 'e1',
      role: 'error',
      content: '任务执行失败（模型未返回错误详情）。',
      errorReason: 'turn-failed',
      isStreaming: false,
    });
  });

  it('omits errorReason when the row has no reason key', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      errorRow('e2', { message: 'upstream exploded' }),
    ]);
    expect(mapped[0].content).toBe('upstream exploded');
    expect(mapped[0].errorReason).toBeUndefined();
  });

  it('degrades to empty content on malformed rows instead of raw JSON', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      errorRow('e3', { unexpected: true }),
    ]);
    expect(mapped[0].role).toBe('error');
    expect(mapped[0].content).toBe('');
  });

  it('preserves string fallback content for compacted remote error rows', () => {
    const mapped = makerChatStore.__mapServerMessagesForTest([
      errorRow('e5', '[remote content truncated: payload too large]'),
    ]);
    expect(mapped[0]).toMatchObject({
      clientId: 'e5',
      role: 'error',
      content: '[remote content truncated: payload too large]',
      isStreaming: false,
    });
    expect(mapped[0].errorReason).toBeUndefined();
  });

  it('keeps timeline position relative to surrounding messages', () => {
    const user = {
      id: 'row-u1',
      clientId: 'u1',
      sessionId: SESSION_ID,
      role: 'user',
      content: 'PR #471 心跳跟进',
      createdAt: '2026-07-02T22:53:15.000Z',
    } as unknown as Message;
    const mapped = makerChatStore.__mapServerMessagesForTest([
      errorRow('e4', { message: '任务执行失败（模型未返回错误详情）。', reason: 'turn-failed' }),
      user,
    ]);
    expect(mapped.map((m) => m.role)).toEqual(['user', 'error']);
  });
});
