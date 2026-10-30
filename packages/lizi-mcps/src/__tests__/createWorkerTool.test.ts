/**
 * create_worker 工具单测 —— schema 校验 + host 透传。
 * label 是 switch_focus 的稳定定位键，工具层要和 desktop 创建边界共用同一组约束。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerCreateWorkerTool, type CreateWorkerDeps } from '../xdt-helper/create_worker.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function setup() {
  const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => ({
    ok: true as const,
    workerId: 'worker-1',
    workerSessionId: 'worker-session-1',
  }));
  const registry = new XdtHelperToolRegistry();
  registerCreateWorkerTool(registry, {
    sessionId: 'lead-1',
    createWorker,
  });
  return { registry, createWorker };
}

function setupWorkerSession() {
  const createWorker = vi.fn(async () => ({
    ok: true as const,
    workerId: 'worker-1',
    workerSessionId: 'worker-session-1',
  }));
  const registry = new XdtHelperToolRegistry();
  registerCreateWorkerTool(registry, {
    sessionId: 'worker-session-1',
    getSessionContext: () => ({
      sessionId: 'worker-session-1',
      vendorOptions: { orcaRole: 'worker' },
    }),
    createWorker,
  });
  return { registry, createWorker };
}

describe('create_worker tool', () => {
  // PR2: the public tool must preserve a new worktree request and return actual spawn facts.
  // Existing directory tests only cover an explicit existing path. Unit, real registry schema.
  it.each([{}, { source_branch: 'release' }])('passes new_worktree %j and returns the actual directory and owned checkout', async (request) => {
    const registry = new XdtHelperToolRegistry();
    const createWorker = vi.fn(async () => ({ ok: true as const, workerId: 'worker', workerSessionId: 'session',
      workingDir: '/repo/.cindy-worktrees/new/apps/web', worktree: { path: '/repo/.cindy-worktrees/new', branch: 'cindy/new' } }));
    registerCreateWorkerTool(registry, { sessionId: 'lead', createWorker });
    const result = parse(await registry.call('create_worker', { role: 'developer', agent: 'codex', label: 'worker', new_worktree: request }));
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({worktree: request.source_branch === undefined ? {} : { sourceBranch: request.source_branch }}));
    expect(result).toMatchObject({working_dir: '/repo/.cindy-worktrees/new/apps/web', worktree: {path: '/repo/.cindy-worktrees/new', branch: 'cindy/new'}});
  });

  it.each([null, true, {source_branch: ''}, {source_branch: '-unsafe'}, {source_branch: 'bad\nbranch'}, {unknown: true}])('rejects malformed new_worktree %j before host creation', async new_worktree => {
    const {registry, createWorker} = setup();
    const result = await registry.call('create_worker', {role: 'developer', agent: 'codex', label: 'worker', new_worktree});
    expect(result.isError).toBe(true);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('forwards the explicit working_dir to the host', async () => {
    const { registry, createWorker } = setup();
    const result = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker', working_dir: '/tmp/candidate with spaces ',
    });
    expect(result.isError).toBeUndefined();
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({ workingDir: '/tmp/candidate with spaces ' }));
  });

  it('forwards the Worker Agent location ("local" = the task computer, omitted = same as the Lead)', async () => {
    const { registry, createWorker } = setup();
    await registry.call('create_worker', { role: 'developer', agent: 'codex', label: 'remote', agent_device_id: 'share:s1' });
    expect(createWorker).toHaveBeenLastCalledWith(expect.objectContaining({ agentDeviceId: 'share:s1' }));
    await registry.call('create_worker', { role: 'developer', agent: 'codex', label: 'local', agent_device_id: 'local' });
    expect(createWorker).toHaveBeenLastCalledWith(expect.objectContaining({ agentDeviceId: null }));
    await registry.call('create_worker', { role: 'developer', agent: 'codex', label: 'lead' });
    expect((createWorker.mock.calls.at(-1) as unknown[])[0]).not.toHaveProperty('agentDeviceId');
  });

  it('rejects an empty explicit directory instead of silently inheriting', async () => {
    const { registry, createWorker } = setup();
    const result = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker', working_dir: '  ',
    });
    expect(result.isError).toBe(true);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('forwards initial_task images to the host and omits them when absent', async () => {
    const { registry, createWorker } = setup();
    await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker',
      initial_task: 'review the screenshots', images: ['/tmp/a.png'],
    });
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      initialTask: 'review the screenshots',
      initialTaskImages: ['/tmp/a.png'],
    }));

    await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker2', initial_task: 'text only',
    });
    expect(vi.mocked(createWorker).mock.calls[1]?.[0]).not.toHaveProperty('initialTaskImages');
  });

  it('flattens a one-level-nested images array instead of failing schema validation', async () => {
    // 模型常见误传是多套一层([[/a.png],[/b.png]]); 接口要自愈而不是报参数错。
    const { registry, createWorker } = setup();
    const result = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker',
      initial_task: 'review', images: [['/tmp/a.png'], ['/tmp/b.png']],
    });
    expect(result.isError).toBeFalsy();
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      initialTaskImages: ['/tmp/a.png', '/tmp/b.png'],
    }));
  });

  it('unwraps the XML-style {item:[...]} wrapper instead of failing schema validation', async () => {
    // 实测形态: 模型/兼容层把数组参数输出成 {item:[...]}(TapTap 会话 5 连败的元凶)。
    const { registry, createWorker } = setup();
    const result = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker',
      initial_task: 'review',
      images: { item: ['cindy-media://blobs/a.png', 'cindy-media://blobs/b.png'] },
    });
    expect(result.isError).toBeFalsy();
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      initialTaskImages: ['cindy-media://blobs/a.png', 'cindy-media://blobs/b.png'],
    }));
  });

  it('wraps a single-element-collapsed {item:string} and bare string into an array', async () => {
    // 实测形态: 单图时 <item> 单实例被兼容层折叠成标量 —— scout 单图 4 连拒的根因。
    const { registry, createWorker } = setup();
    const wrapped = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'w1',
      initial_task: 'review', images: { item: 'cindy-media://blobs/a.png' },
    });
    expect(wrapped.isError).toBeFalsy();
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      initialTaskImages: ['cindy-media://blobs/a.png'],
    }));

    const bare = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'w2',
      initial_task: 'review', images: 'cindy-media://blobs/a.png',
    });
    expect(bare.isError).toBeFalsy();
    expect(vi.mocked(createWorker).mock.calls[1]?.[0]).toMatchObject({
      initialTaskImages: ['cindy-media://blobs/a.png'],
    });
  });

  it('still rejects non-string image entries after flattening', async () => {
    const { registry, createWorker } = setup();
    const result = await registry.call('create_worker', {
      role: 'developer', agent: 'codex', label: 'worker',
      initial_task: 'review', images: [{ uri: '/tmp/a.png' }],
    });
    expect(result.isError).toBe(true);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('describes the subagent distinction before creating a worker', () => {
    const { registry } = setup();

    expect(registry.get('create_worker')?.description).toContain(
      '注:create_worker 建的是 Orca worker(session 级、持久、UI 可见),不是 subagent。若用户要的是 subagent(一次性、用完即弃),请用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task 工具),不要用 create_worker。'
        + 'Orca worker 永远不是 subagent 的替代品;你没有原生 subagent 机制时,如实告知用户并请他决定,不要拿 worker 顶替。',
    );
    expect(registry.get('create_worker')?.description).toContain(
      '用户一次要求创建 2 个及以上 Worker 时必须改用 create_workers；不要并行或连续多次调用 create_worker。',
    );
  });

  it('surfaces structured hard-limit details to the lead', async () => {
    const createWorker = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' as const,
      message: 'hard limit 3 reached',
      limit: { workerHardLimit: 3, occupiedSlots: 3, remainingSlots: 0 },
    }));
    const registry = new XdtHelperToolRegistry();
    registerCreateWorkerTool(registry, { sessionId: 'lead-1', createWorker });

    const result = await registry.call('create_worker', {
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer_1',
    });

    expect(parse(result)).toMatchObject({
      ok: false,
      errorCode: 'WORKER_LIMIT_HARD_EXCEEDED',
      data: {
        hint: 'hard limit 3 reached',
        limit: { hard_limit: 3, occupied_slots: 3, remaining_slots: 0 },
      },
    });
  });

  it('rejects non-slug labels at schema boundary before calling host', async () => {
    const { registry, createWorker } = setup();

    for (const label of ['bad label', '中文', 'x'.repeat(33)]) {
      const res = await registry.call('create_worker', {
        role: 'reviewer',
        agent: 'codex',
        label,
      });
      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    }
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects minimal effort for all worker agents at schema boundary before calling host', async () => {
    const { registry, createWorker } = setup();

    for (const agent of ['codex', 'claude-code'] as const) {
      const res = await registry.call('create_worker', {
        role: 'reviewer',
        agent,
        label: `reviewer_${agent === 'codex' ? 'codex' : 'claude'}`,
        effort: 'minimal',
      });

      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    }
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('passes valid labels through to host unchanged', async () => {
    const { registry, createWorker } = setup();

    const res = await registry.call('create_worker', {
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer_1',
    });

    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      worker_session_id: 'worker-session-1',
      label: 'reviewer_1',
    });
    expect(createWorker).toHaveBeenCalledWith({
      leadSessionId: 'lead-1',
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer_1',
      model: undefined,
      providerId: undefined,
      effort: undefined,
      fast: undefined,
      initialTask: undefined,
    });
  });

  it('trims and forwards provider_id to the host creation boundary', async () => {
    const { registry, createWorker } = setup();

    const res = await registry.call('create_worker', {
      role: 'reviewer',
      agent: 'codex',
      model: 'deepseek/deepseek-v4-pro',
      provider_id: ' xd ',
      label: 'reviewer_1',
    });

    expect(res.isError).toBeUndefined();
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek/deepseek-v4-pro',
      providerId: 'xd',
    }));
  });

  it('accepts pi as a first-class worker agent and passes it through to host', async () => {
    const { registry, createWorker } = setup();

    const res = await registry.call('create_worker', {
      role: 'developer',
      agent: 'pi',
      label: 'pi_dev_1',
    });

    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({ ok: true, label: 'pi_dev_1' });
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'pi',
      label: 'pi_dev_1',
    }));
  });

  it('trims valid labels before validating and calling host', async () => {
    const { registry, createWorker } = setup();

    const res = await registry.call('create_worker', {
      role: 'reviewer',
      agent: 'codex',
      label: ' reviewer_1 ',
    });

    expect(res.isError).toBeUndefined();
    expect(parse(res)).toMatchObject({
      ok: true,
      label: 'reviewer_1',
    });
    expect(createWorker).toHaveBeenCalledWith(expect.objectContaining({
      label: 'reviewer_1',
    }));
  });

  it('rejects worker sessions with subagent routing hint before calling host', async () => {
    const { registry, createWorker } = setupWorkerSession();

    const res = await registry.call('create_worker', {
      role: 'reviewer',
      agent: 'codex',
      label: 'reviewer_1',
    });

    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({
      ok: false,
      errorCode: 'WORKER_CANNOT_NEST',
      data: {
        hint: 'create_worker 是 Orca Lead 创建 worker session 的入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task/Agent 工具),不要使用 Orca create_worker / start_team。没有原生 subagent 机制时如实告知用户,Orca worker 不是它的替代品。',
      },
    });
    expect(createWorker).not.toHaveBeenCalled();
  });
});
