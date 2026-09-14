/**
 * send_to_session 工具单测 —— schema 校验 + create/jump 透传 + 错误码整形。
 * host 回调(sendToSession)mock 掉;验证工具层契约:参数边界、dispatcherSessionId
 * 透传、ok/错误码透传。jump/create 由 host 按 targetSessionId 有无判定,工具层不短路
 * sessionId(无 dispatcher ctx 时仍调 host,由 host 返 LEAD_NOT_SUPPORTED)。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import {
  registerSendToSessionTool,
  type SendToSessionCallback,
} from '../xdt-helper/send_to_session.js';

type SendResult = Awaited<ReturnType<SendToSessionCallback>>;

const UUID = '11111111-1111-4111-8111-111111111111';

function setup(opts?: { sessionId?: string | undefined; result?: SendResult }) {
  const sessionId = 'sessionId' in (opts ?? {}) ? opts?.sessionId : 'disp-1';
  const sendToSession = vi.fn(
    async (): Promise<SendResult> =>
      opts?.result ?? {
        ok: true,
        targetSessionId: 'tgt-1',
        agentKind: 'claude-code',
        wakeKind: 'created',
        targetTitle: 'issue #1',
        targetLastUserSendAt: null,
      },
  );
  const registry = new XdtHelperToolRegistry();
  registerSendToSessionTool(registry, {
    getSessionContext: () => ({
      sessionId,
      agentKind: 'claude-code',
      workingDir: '/tmp/wd',
    }),
    sendToSession,
  });
  return { registry, sendToSession };
}

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (!block || block.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

describe('send_to_session tool', () => {
  it('注册到 handoff 类目, 不混入 control(改名场景选错隔离的核心)', () => {
    const { registry } = setup();
    const handoff = registry.list('handoff').map((t) => t.name);
    const control = registry.list('control').map((t) => t.name);
    expect(handoff).toContain('send_to_session');
    expect(control).not.toContain('send_to_session');
  });

  it('缺 message → INVALID_ARGS, host 不被调', async () => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', { title: 'x' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it('未知字段 → INVALID_ARGS (strictObject), host 不被调', async () => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', { message: 'hi', foo: 1 });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it('target_session_id 非 uuid → INVALID_ARGS', async () => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', {
      target_session_id: 'not-a-uuid',
      message: 'hi',
    });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it('create: 不传 target_session_id → host 收到 undefined + dispatcherSessionId, 返回透传', async () => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', {
      message: '首次处理',
      title: 'issue #1',
    });
    expect(sendToSession).toHaveBeenCalledWith({
      targetSessionId: undefined,
      message: '首次处理',
      dispatcherSessionId: 'disp-1',
      title: 'issue #1',
      useWorktree: undefined,
    });
    expect(res.isError).toBeUndefined();
    expect(parse(res)).toEqual({
      ok: true,
      target_session_id: 'tgt-1',
      agent_kind: 'claude-code',
      wake_kind: 'created',
      target_title: 'issue #1',
      target_last_user_send_at: null,
      worktree_path: null,
    });
  });

  it('create + use_worktree=true → host 收到 useWorktree=true, worktree_path 回显', async () => {
    const { registry, sendToSession } = setup({
      result: {
        ok: true,
        targetSessionId: 'tgt-2',
        agentKind: 'claude-code',
        wakeKind: 'created',
        targetTitle: 'PR #638',
        targetLastUserSendAt: null,
        worktreePath: '/repo/.cindy-worktrees/auto-abc123',
      },
    });
    const res = await registry.call('send_to_session', {
      message: '跟进修复 PR #638',
      title: 'PR #638',
      use_worktree: true,
    });
    expect(sendToSession).toHaveBeenCalledWith(
      expect.objectContaining({ useWorktree: true, targetSessionId: undefined }),
    );
    expect(parse(res)).toMatchObject({
      ok: true,
      wake_kind: 'created',
      worktree_path: '/repo/.cindy-worktrees/auto-abc123',
    });
  });

  it('create: 显式执行配置完整透传并回显 host 的实际解析结果', async () => {
    const { registry, sendToSession } = setup({
      result: {
        ok: true,
        targetSessionId: 'tgt-codex',
        agentKind: 'codex',
        wakeKind: 'created',
        targetTitle: 'PR implementation',
        targetLastUserSendAt: null,
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        fastMode: false,
        providerId: null,
      },
    });
    const res = await registry.call('send_to_session', {
      message: '实现 PR',
      agent_kind: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      fast: false,
    });

    expect(sendToSession).toHaveBeenCalledWith({
      targetSessionId: undefined,
      message: '实现 PR',
      dispatcherSessionId: 'disp-1',
      title: undefined,
      useWorktree: undefined,
      workingDir: undefined,
      agentKind: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      fast: false,
    });
    expect(parse(res)).toMatchObject({
      ok: true,
      agent_kind: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      fast_mode: false,
      provider_id: null,
    });
  });

  it('create: Pi Agent 配置通过 schema 并完整透传', async () => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', {
      message: '交给 Pi 实现',
      agent_kind: 'pi',
      model: 'pi-model',
      effort: 'max',
      fast: true,
    });

    expect(res.isError).toBeUndefined();
    expect(sendToSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'pi',
      model: 'pi-model',
      effort: 'max',
      fast: true,
    }));
  });

  it.each([
    { agent_kind: 'not-an-agent' },
    { effort: 'extreme' },
  ])('非法执行配置 %# → INVALID_ARGS, host 不被调', async (invalid) => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', { message: 'x', ...invalid });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it('jump: 执行配置字段继续透传给 host，由 host 忽略且不改目标 session', async () => {
    const { registry, sendToSession } = setup({
      result: {
        ok: true,
        targetSessionId: UUID,
        agentKind: 'claude-code',
        wakeKind: 'already-active',
        targetTitle: 'Existing',
        targetLastUserSendAt: null,
      },
    });
    await registry.call('send_to_session', {
      target_session_id: UUID,
      message: '增量',
      agent_kind: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    expect(sendToSession).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: UUID,
      agentKind: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    }));
  });

  it('host 返 WORKTREE_UNAVAILABLE → 错误码透传, isError=true', async () => {
    const { registry } = setup({
      result: {
        ok: false,
        errorCode: 'WORKTREE_UNAVAILABLE',
        message: 'workingDir 不是 git 仓库',
      },
    });
    const res = await registry.call('send_to_session', {
      message: 'x',
      use_worktree: true,
    });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'WORKTREE_UNAVAILABLE' });
  });

  it('jump: 传 target_session_id → host 收到该 id, 返回透传', async () => {
    const { registry, sendToSession } = setup({
      result: {
        ok: true,
        targetSessionId: UUID,
        agentKind: 'codex',
        wakeKind: 'resumed',
        targetTitle: null,
        targetLastUserSendAt: '2026-06-24T00:00:00.000Z',
      },
    });
    const res = await registry.call('send_to_session', {
      target_session_id: UUID,
      message: '增量',
    });
    expect(sendToSession).toHaveBeenCalledWith({
      targetSessionId: UUID,
      message: '增量',
      dispatcherSessionId: 'disp-1',
      title: undefined,
    });
    expect(parse(res)).toMatchObject({ ok: true, wake_kind: 'resumed', target_title: null });
  });

  it('jump 排队时返回可供后续修改或撤回的 queued_message_id', async () => {
    const { registry } = setup({
      result: {
        ok: true,
        targetSessionId: UUID,
        agentKind: 'codex',
        wakeKind: 'queued',
        queuedMessageId: 'queued-by-session-1',
        targetTitle: 'Busy target',
        targetLastUserSendAt: '2026-08-16T01:00:00.000Z',
      },
    });

    const res = await registry.call('send_to_session', {
      target_session_id: UUID,
      message: '稍后处理这条',
    });

    expect(parse(res)).toMatchObject({
      ok: true,
      wake_kind: 'queued',
      queued_message_id: 'queued-by-session-1',
    });
  });

  it('无 dispatcher sessionId → host 仍被调(dispatcherSessionId=undefined), host 返 LEAD_NOT_SUPPORTED 透传', async () => {
    const { registry, sendToSession } = setup({
      sessionId: undefined,
      result: { ok: false, errorCode: 'LEAD_NOT_SUPPORTED', message: 'no dispatcher ctx' },
    });
    const res = await registry.call('send_to_session', { message: 'x' });
    expect(sendToSession).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcherSessionId: undefined }),
    );
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'LEAD_NOT_SUPPORTED' });
  });

  it('host 错误码透传 (NOT_FOUND / ARCHIVED / BUSY), isError=true', async () => {
    for (const errorCode of ['NOT_FOUND', 'ARCHIVED', 'BUSY'] as const) {
      const { registry } = setup({
        result: { ok: false, errorCode, message: `msg:${errorCode}` },
      });
      const res = await registry.call('send_to_session', {
        target_session_id: UUID,
        message: 'x',
      });
      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ ok: false, errorCode });
    }
  });

  it('host 返 HOST_NOT_READY → 友好提示透传', async () => {
    const { registry } = setup({
      result: { ok: false, errorCode: 'HOST_NOT_READY', message: 'not ready' },
    });
    const res = await registry.call('send_to_session', { message: 'x' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'HOST_NOT_READY' });
  });
});

describe('send_to_session · working_dir (#811)', () => {
  it('create + working_dir → host 收到 workingDir 覆盖', async () => {
    const { registry, sendToSession } = setup();
    const res = await registry.call('send_to_session', {
      message: '请接手项目 B 的任务',
      title: '项目 B · 任务交接',
      working_dir: '/abs/path/project-b',
    });
    expect(sendToSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDir: '/abs/path/project-b',
        targetSessionId: undefined,
      }),
    );
    expect(parse(res)).toMatchObject({ ok: true, wake_kind: 'created' });
  });

  it('working_dir 与 use_worktree 可组合透传', async () => {
    const { registry, sendToSession } = setup();
    await registry.call('send_to_session', {
      message: 'x',
      working_dir: '/abs/path/project-b',
      use_worktree: true,
    });
    expect(sendToSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/abs/path/project-b', useWorktree: true }),
    );
  });

  it('省略 working_dir → host 收到 undefined(继承 dispatcher 目录的既有行为不变)', async () => {
    const { registry, sendToSession } = setup();
    await registry.call('send_to_session', { message: 'x' });
    expect(sendToSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: undefined }),
    );
  });

  it('host 返 INVALID_ARGS(路径校验失败)→ 错误码透传', async () => {
    const { registry } = setup({
      result: {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: 'working_dir 不存在或不可访问:/nope',
      },
    });
    const res = await registry.call('send_to_session', {
      message: 'x',
      working_dir: '/nope',
    });
    expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
  });
});
