import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllPendingInteractionCollapse,
  getCollapsedPendingRequestIds,
  prunePendingInteractionCollapse,
  subscribeCollapsedPendingRequestIds,
  togglePendingInteractionCollapse,
} from '@/session/pendingInteractionCollapseStore';
import type { PendingInteraction } from '@/session/types';

const askCard = (requestId: string) => ({
  request: { kind: 'ask_user_question', requestId, questions: [{ question: '还在等回答' }] },
} as unknown as PendingInteraction);

const AUTHORITATIVE = { authoritative: true } as const;
const NOT_AUTHORITATIVE = { authoritative: false } as const;

afterEach(() => {
  clearAllPendingInteractionCollapse();
});

describe('pendingInteractionCollapseStore', () => {
  it('keeps the collapse intent across page unmount and remount', () => {
    // 「收起 → 离开任务(页面卸载) → 再进来」在 store 层就是「写入 → 重新读取」:
    // 契约要求同一条仍在 pending 的请求依旧是收起的,不能因为页面重挂载又展开占满屏。
    togglePendingInteractionCollapse('session-1', 'ask-1');
    expect(getCollapsedPendingRequestIds('session-1')).toEqual(['ask-1']);

    // 重挂载后 pending 里这条还在(权威快照),prune 不得把它清掉。
    prunePendingInteractionCollapse('session-1', [askCard('ask-1')], AUTHORITATIVE);
    expect(getCollapsedPendingRequestIds('session-1')).toEqual(['ask-1']);
  });

  it('drops the intent once an authoritative snapshot says the request is gone', () => {
    togglePendingInteractionCollapse('session-1', 'ask-1');

    // 非权威的空快照(离线清空投影 / 全量快照未到)不算终结,收起意图必须留着。
    prunePendingInteractionCollapse('session-1', [], NOT_AUTHORITATIVE);
    expect(getCollapsedPendingRequestIds('session-1')).toEqual(['ask-1']);

    // 权威快照确认已回答 / 撤销 → 清掉;此后重挂载不再是收起态。
    prunePendingInteractionCollapse('session-1', [], AUTHORITATIVE);
    expect(getCollapsedPendingRequestIds('session-1')).toEqual([]);
    // 清空后 key 应被回收,空快照走共享引用(useSyncExternalStore 用 Object.is 比较)。
    expect(getCollapsedPendingRequestIds('session-1')).toBe(getCollapsedPendingRequestIds('session-2'));
  });

  it('isolates sessions so switching tasks never leaks the intent', () => {
    togglePendingInteractionCollapse('session-1', 'ask-1');
    expect(getCollapsedPendingRequestIds('session-2')).toEqual([]);

    togglePendingInteractionCollapse('session-2', 'perm-2');
    expect(getCollapsedPendingRequestIds('session-1')).toEqual(['ask-1']);
    expect(getCollapsedPendingRequestIds('session-2')).toEqual(['perm-2']);

    // 一个会话的权威回收不得动到另一个会话。
    prunePendingInteractionCollapse('session-1', [], AUTHORITATIVE);
    expect(getCollapsedPendingRequestIds('session-1')).toEqual([]);
    expect(getCollapsedPendingRequestIds('session-2')).toEqual(['perm-2']);
  });

  it('toggles back and notifies subscribers only on real changes', () => {
    let notifications = 0;
    const unsubscribe = subscribeCollapsedPendingRequestIds(() => { notifications += 1; });
    try {
      togglePendingInteractionCollapse('session-1', 'ask-1');
      expect(notifications).toBe(1);
      // 再点一次 = 展开,记录移除。
      togglePendingInteractionCollapse('session-1', 'ask-1');
      expect(getCollapsedPendingRequestIds('session-1')).toEqual([]);
      expect(notifications).toBe(2);

      // 空集合上跑 prune 不产生写入,也就不该通知(否则 effect 每帧重入)。
      prunePendingInteractionCollapse('session-1', [], AUTHORITATIVE);
      expect(notifications).toBe(2);
      // 无变化的 prune(该条仍在权威快照里)同样不通知。
      togglePendingInteractionCollapse('session-1', 'ask-1');
      expect(notifications).toBe(3);
      prunePendingInteractionCollapse('session-1', [askCard('ask-1')], AUTHORITATIVE);
      expect(notifications).toBe(3);
    } finally {
      unsubscribe();
    }
  });

  it('bounds the number of tracked sessions', () => {
    for (let i = 0; i < 40; i++) togglePendingInteractionCollapse(`session-${i}`, `ask-${i}`);
    // 最旧的按插入序被淘汰,最近的保留 —— Map 不能随会话数无界增长。
    expect(getCollapsedPendingRequestIds('session-0')).toEqual([]);
    expect(getCollapsedPendingRequestIds('session-39')).toEqual(['ask-39']);
  });

  it('is owned by the store, not by session page component state', () => {
    const sessionScreenSource = readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');

    // 页面组件不得再自持收起态:它会随「离开任务」卸载一起丢(#1493 review)。
    expect(sessionScreenSource).toContain('useCollapsedPendingRequestIds(sessionId)');
    expect(sessionScreenSource).toContain('prunePendingInteractionCollapse(sessionId, pending, {');
    expect(sessionScreenSource).not.toContain('setCollapsedPendingRequestIds');
    expect(sessionScreenSource).not.toContain('useState<readonly string[]>([])');
  });
});
