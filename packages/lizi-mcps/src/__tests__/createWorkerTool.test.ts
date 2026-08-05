/**
 * create_worker 工具单测 —— schema 校验 + host 透传。
 * label 是 switch_focus 的稳定定位键，工具层要和 desktop 创建边界共用同一组约束。
 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerCreateWorkerTool } from '../xdt-helper/create_worker.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') {
    throw new Error('Expected first MCP content block to be text');
  }
  return JSON.parse(block.text);
}

function setup() {
  const createWorker = vi.fn(async () => ({
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
  it('describes the subagent distinction before creating a worker', () => {
    const { registry } = setup();

    expect(registry.get('create_worker')?.description).toContain(
      '注:create_worker 建的是 Orca worker(session 级、持久、UI 可见),不是 subagent。若用户要的是 subagent(一次性、用完即弃),请用原生 subagent 机制(Codex:spawn_agent;Claude Code:Task 工具),不要用 create_worker。',
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
      effort: undefined,
      fast: undefined,
      initialTask: undefined,
    });
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
        hint: 'create_worker 是 Orca Lead 创建 worker session 的入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(Codex:spawn_agent;Claude Code:Task/Agent 工具),不要使用 Orca create_worker / start_team。',
      },
    });
    expect(createWorker).not.toHaveBeenCalled();
  });
});
