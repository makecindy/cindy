/** create_workers 批量编排回归：真实汇总、hard-limit 短路与连续失败。 */

import { describe, expect, it, vi } from 'vitest';

import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerCreateWorkersTool } from '../xdt-helper/create_workers.js';
import type { CreateWorkerDeps, CreateWorkerSpec } from '../xdt-helper/create_worker.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected first MCP content block to be text');
  return JSON.parse(block.text);
}

function worker(index: number): CreateWorkerSpec {
  return {
    role: 'developer',
    agent: 'codex',
    label: `worker_${index}`,
    initial_task: `task ${index}`,
  };
}

function setup(createWorker: CreateWorkerDeps['createWorker']) {
  const registry = new XdtHelperToolRegistry();
  registerCreateWorkersTool(registry, { sessionId: 'lead-1', createWorker });
  return registry;
}

function created(index: number, hardLimit: number) {
  return {
    ok: true as const,
    workerId: `worker-id-${index}`,
    workerSessionId: `worker-session-${index}`,
    limit: {
      workerHardLimit: hardLimit,
      occupiedSlots: index,
      remainingSlots: hardLimit - index,
    },
  };
}

function hardLimitFailure(hardLimit: number) {
  return {
    ok: false as const,
    errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' as const,
    message: `hard limit ${hardLimit} reached`,
    limit: {
      workerHardLimit: hardLimit,
      occupiedSlots: hardLimit,
      remainingSlots: 0,
    },
  };
}

describe('create_workers tool', () => {
  // PR2 unit: batch results must retain each actual cwd and optional checkout independently.
  it('keeps mixed worktree and existing-directory requests and spawn results distinct', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>()
      .mockResolvedValueOnce({...created(1, 5), workingDir: '/tree/apps/web', worktree: {path: '/tree', branch: 'cindy/new'}})
      .mockResolvedValueOnce({...created(2, 5), workingDir: '/existing'});
    const result = parse(await setup(createWorker).call('create_workers', {workers: [
      {...worker(1), working_dir: '/repo/apps/web', new_worktree: {source_branch: 'release'}},
      {...worker(2), working_dir: '/existing'},
    ]}));
    expect(createWorker).toHaveBeenNthCalledWith(1, expect.objectContaining({workingDir: '/repo/apps/web', worktree: {sourceBranch: 'release'}}));
    expect(createWorker.mock.calls[1]?.[0]).not.toHaveProperty('worktree');
    expect(result.results).toMatchObject([
      {working_dir: '/tree/apps/web', worktree: {path: '/tree', branch: 'cindy/new'}},
      {working_dir: '/existing'},
    ]);
    expect(result.results[1]).not.toHaveProperty('worktree');
  });

  it('preserves each worker directory independently in a batch', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>()
      .mockResolvedValueOnce(created(1, 5)).mockResolvedValueOnce(created(2, 5));
    const registry = setup(createWorker);
    await registry.call('create_workers', { workers: [
      { ...worker(1), working_dir: '/tmp/first' },
      { ...worker(2), working_dir: '/tmp/second with spaces ' },
    ] });
    expect(createWorker).toHaveBeenNthCalledWith(1, expect.objectContaining({ workingDir: '/tmp/first' }));
    expect(createWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({ workingDir: '/tmp/second with spaces ' }));
  });

  it('routes multi-worker requests to one deterministic batch tool', () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    expect(registry.get('create_workers')?.description).toContain(
      '用户一次要求创建多个 Worker 时必须使用本工具，不要并行或连续多次调用 create_worker。',
    );
  });

  it('rejects duplicate labels before creating any worker', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    const result = await registry.call('create_workers', {
      workers: [worker(1), { ...worker(2), label: 'WORKER_1' }],
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects unknown fields inside worker specs instead of silently dropping them', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>();
    const registry = setup(createWorker);

    const result = await registry.call('create_workers', {
      workers: [
        { ...worker(1), initialTask: 'camelCase should fail' },
        worker(2),
      ],
    });

    expect(result.isError).toBe(true);
    expect(parse(result)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('forwards each worker provider_id through the shared batch schema', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async (_params) => created(1, 8));
    const registry = setup(createWorker);

    const result = await registry.call('create_workers', {
      workers: [
        { ...worker(1), model: 'deepseek/deepseek-v4-pro', provider_id: 'xd' },
        { ...worker(2), model: 'gpt-5.5', provider_id: 'openai' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(createWorker).toHaveBeenNthCalledWith(1, expect.objectContaining({
      model: 'deepseek/deepseek-v4-pro',
      providerId: 'xd',
    }));
    expect(createWorker).toHaveBeenNthCalledWith(2, expect.objectContaining({
      model: 'gpt-5.5',
      providerId: 'openai',
    }));
  });

  // PR #7933 unit: the existing explicit-agent batch covered hard-limit stopping,
  // but omitted-agent requests must retain the same stop, skipped results and capacity report.
  it.each([false, true])('stops a hard=3 batch and summarizes all nine requests (omit agent: %s)', async (omitAgent) => {
    let call = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => {
      call += 1;
      return call <= 3 ? created(call, 3) : hardLimitFailure(3);
    });
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 9 }, (_, index) => {
        const spec = worker(index + 1);
        if (omitAgent) delete spec.agent;
        return spec;
      }),
    }));

    expect(result).toMatchObject({
      ok: true,
      request_count: 9,
      attempted_count: 4,
      success_count: 3,
      failure_count: 1,
      skipped_count: 5,
      not_created_count: 6,
      stopped_early: true,
      stop_reason: 'WORKER_LIMIT_HARD_EXCEEDED',
      limit: { hard_limit: 3, occupied_slots: 3, remaining_slots: 0 },
      user_report: '本批请求创建 9 个 Worker，实际创建成功 3 个，创建失败 1 个，未尝试 5 个，共 6 个未创建；当前 hard limit 为 3，已占用 3 个槽位。可在协同设置中提高 hard limit、复用已有 Worker，或归档不再需要的 Worker 后分批执行剩余任务。',
    });
    expect(createWorker).toHaveBeenCalledTimes(4);
    expect(result.success_count + result.failure_count + result.skipped_count).toBe(result.request_count);
    expect(result.results.map((entry: { status: string }) => entry.status)).toEqual([
      'created', 'created', 'created', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped',
    ]);
    expect(result.suggestions).toHaveLength(3);
  });

  it('reports the default hard=8 boundary for the ninth request', async () => {
    let call = 0;
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => {
      call += 1;
      return call <= 8 ? created(call, 8) : hardLimitFailure(8);
    });
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: Array.from({ length: 9 }, (_, index) => worker(index + 1)),
    }));

    expect(result).toMatchObject({
      request_count: 9,
      attempted_count: 9,
      success_count: 8,
      failure_count: 1,
      skipped_count: 0,
      not_created_count: 1,
      limit: { hard_limit: 8, occupied_slots: 8, remaining_slots: 0 },
    });
  });

  it('keeps real per-item outcomes when a non-limit failure occurs between successes', async () => {
    const outcomes = [
      created(1, 8),
      { ok: false as const, errorCode: 'DUPLICATE_LABEL' as const, message: 'duplicate label' },
      created(2, 8),
    ];
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => outcomes.shift()!);
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    }));

    expect(result).toMatchObject({
      attempted_count: 3,
      success_count: 2,
      failure_count: 1,
      skipped_count: 0,
      not_created_count: 1,
      stopped_early: false,
      user_report: '本批请求创建 3 个 Worker，实际创建成功 2 个，创建失败 1 个，未尝试 0 个，共 1 个未创建。请按逐项结果核对每个 Worker 的真实终态。',
    });
    expect(result.results).toEqual([
      expect.objectContaining({ label: 'worker_1', status: 'created', worker_id: 'worker-id-1' }),
      expect.objectContaining({ label: 'worker_2', status: 'failed', error_code: 'DUPLICATE_LABEL' }),
      expect.objectContaining({ label: 'worker_3', status: 'created', worker_id: 'worker-id-2' }),
    ]);
  });

  it('reports consecutive non-limit failures without inventing created workers', async () => {
    const outcomes = [
      { ok: false as const, errorCode: 'INVALID_PARAMS' as const, message: 'bad model' },
      { ok: false as const, errorCode: 'NO_PROVIDER_FOR_AGENT' as const, message: 'provider missing' },
      { ok: false as const, errorCode: 'INTERNAL' as const, message: 'bootstrap failed' },
    ];
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => outcomes.shift()!);
    const registry = setup(createWorker);

    const result = parse(await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    }));

    expect(result).toMatchObject({
      attempted_count: 3,
      success_count: 0,
      failure_count: 3,
      skipped_count: 0,
      not_created_count: 3,
      stopped_early: false,
    });
    expect(result.results.every((entry: { status: string }) => entry.status === 'failed')).toBe(true);
    expect(result.results.some((entry: { worker_id?: string }) => entry.worker_id)).toBe(false);
  });

  it('stops immediately and returns an explicit tool error when the host is not ready', async () => {
    const createWorker = vi.fn<CreateWorkerDeps['createWorker']>(async () => ({
      ok: false as const,
      errorCode: 'HOST_NOT_READY' as const,
      message: 'host booting',
    }));
    const registry = setup(createWorker);

    const response = await registry.call('create_workers', {
      workers: [worker(1), worker(2), worker(3)],
    });
    const result = parse(response);

    expect(response.isError).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'HOST_NOT_READY',
      data: {
        request_count: 3,
        attempted_count: 1,
        success_count: 0,
        failure_count: 1,
        skipped_count: 2,
        not_created_count: 3,
        stopped_early: true,
        stop_reason: 'HOST_NOT_READY',
        hint: expect.stringContaining('主进程协同服务尚未就绪'),
      },
    });
    expect(result.data.results.map((entry: { status: string }) => entry.status)).toEqual([
      'failed', 'skipped', 'skipped',
    ]);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});

// Unit/public batch handler: an unusable saved route must fail only its item, not the batch.
it('keeps processing after an omitted-agent default fails and returns the next actual route', async () => {
  const createWorker = vi.fn<CreateWorkerDeps['createWorker']>()
    .mockResolvedValueOnce({ ok: false, errorCode: 'INVALID_PARAMS', message: 'Saved route unavailable; specify agent and retry' })
    .mockResolvedValueOnce({ ...created(2, 5), resolved: { agent: 'pi', model: 'test-model', providerId: 'provider',
      agentDeviceId: null, effort: 'high', fastMode: false }, defaults: { source: 'original-policy', fallbackReason: 'saved provider disconnected' } });
  const result = parse(await setup(createWorker).call('create_workers', { workers: [
    { role: 'developer', label: 'one' }, { role: 'developer', label: 'two', agent: 'pi' },
  ] }));
  expect(result).toMatchObject({ success_count: 1, failure_count: 1, skipped_count: 0, results: [
    { status: 'failed', error_code: 'INVALID_PARAMS' }, { status: 'created', agent: 'pi', model: 'test-model',
      provider_id: 'provider', agent_device_id: 'local', defaults: { source: 'original-policy', fallback_reason: 'saved provider disconnected' } },
  ] });
});
