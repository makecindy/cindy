/**
 * pendingInteractions — 交互被作废时必须把卡片地址交还给调用方。
 *
 * 背景(2026-08 实测): 群里的活触发权限确认时, 授权卡会转投宿主私聊。那轮活一旦
 * 收口(正常结束 / 出错 / session 清理 / 抢跑), route 释放会 cancelPending 掉这次
 * 交互 —— 但旧实现只返回 boolean, 卡片地址被丢掉, 于是私聊里那张卡原样留着、按钮
 * 照旧可点。用户点下去不会有任何反应, 群里也不会动。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelPending,
  getPendingCount,
  registerPendingExternal,
  resolvePending,
} from '../pendingInteractions';

function register(
  requestId: string,
  kind: 'permission' | 'plan_review' | 'ask_user_question',
  messageId: string,
): { resolve: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn();
  const reject = vi.fn();
  registerPendingExternal(requestId, kind, messageId, resolve, reject);
  return { resolve, reject };
}

beforeEach(() => {
  // 表是模块级单例 — 逐个清掉上一条用例的残留, 否则 requestId 会撞 already exists。
  for (const id of ['req-perm', 'req-plan', 'req-ask', 'req-gone']) {
    cancelPending(id, 'test_cleanup');
  }
});

describe('cancelPending 交还卡片地址', () => {
  it('permission: 按 deny 收口并交还 messageId, 供调用方收口卡片', () => {
    const { resolve } = register('req-perm', 'permission', 'chat|555');

    const cancelled = cancelPending('req-perm', 'interaction_route_released');

    expect(cancelled).toEqual({ messageId: 'chat|555' });
    expect(resolve).toHaveBeenCalledWith({
      kind: 'permission',
      behavior: 'deny',
      reason: 'interaction_route_released',
    });
    expect(getPendingCount()).toBe(0);
  });

  it('permission: 登记原始卡片正文, resolve 时交还供收口卡保留决策正文', () => {
    const { resolve } = register('req-perm', 'permission', 'chat|555');
    // register 走了默认 extras; 这里补登记带 permissionCard 的版本(新 requestId)。
    const resolve2 = vi.fn();
    registerPendingExternal('req-perm2', 'permission', 'chat|666', resolve2, vi.fn(), {
      toolName: 'Bash',
      permissionCard: { title: '🔧 工具调用：Bash', body: '**参数预览**\n```json\n{"cmd": "ls"}\n```' },
    });

    const resolved = resolvePending('req-perm2', { kind: 'permission', behavior: 'allow' });

    expect(resolved).toEqual({
      messageId: 'chat|666',
      permissionCard: {
        title: '🔧 工具调用：Bash',
        body: '**参数预览**\n```json\n{"cmd": "ls"}\n```',
      },
    });
    expect(getPendingCount()).toBe(1); // 只剩 req-perm 那条
    cancelPending('req-perm', 'cleanup');
  });

  it('plan_review 与 ask_user_question 同样交还地址', () => {
    register('req-plan', 'plan_review', 'chat|556');
    register('req-ask', 'ask_user_question', 'chat|557');

    expect(cancelPending('req-plan', 'turn_terminal')).toEqual({ messageId: 'chat|556' });
    expect(cancelPending('req-ask', 'turn_terminal')).toEqual({ messageId: 'chat|557' });
  });

  it('没有这条 pending 时返回 null(不谎报收口)', () => {
    expect(cancelPending('req-gone', 'turn_terminal')).toBeNull();
  });

  it('与 resolvePending 形状一致 — 两条路径都能拿到卡片去收口', () => {
    register('req-perm', 'permission', 'chat|558');
    const resolved = resolvePending('req-perm', {
      kind: 'permission',
      behavior: 'allow',
      updatedInput: null,
    } as never);
    expect(resolved).toEqual({ messageId: 'chat|558' });

    register('req-perm', 'permission', 'chat|559');
    expect(cancelPending('req-perm', 'turn_terminal')).toEqual({ messageId: 'chat|559' });
  });
});
