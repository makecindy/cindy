import { describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  createOrcaWorkerReportQueue,
  type OrcaWorkerReportQueueDeps,
} from '../orcaWorkerReportQueue.js';
import type { WorkerReportWithdrawalStanding } from '../orcaTeamService.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：createOrcaWorkerReportQueue 的 list / update / cancel / merge——
 *   Worker 能看到、改到 Lead 队列里的哪些消息，以及改完后 Lead 实际会读到什么。
 * - Bug／规则依据：2026-11-10 一个 reviewer Worker 往忙碌的 Lead 连发三条回报，无法查看或
 *   撤回，只能再发一条「请跳过前面三条」；规则见 orca-team-architecture.md
 *   「消息派发与 auto-bridge」第 12 条。
 * - 现有覆盖缺口：既有用例只覆盖 Lead 管理自己发给 Worker 的排队消息，这个方向是新模块。
 * - 最小失败输入：见各用例的队列。
 * - tier：unit（进程内内存队列，不启动 coordinator）。
 */

const WORKER = { workerId: 'w-review', workerSessionId: 'worker-session', leadSessionId: 'lead-session' };

function queued(
  clientId: string,
  text: string,
  origin: AgentInputQueuedMessage['origin'],
): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'm',
    effort: '',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: { clientId, role: 'user', content: text, createdAt: '2026-11-10T00:00:00.000Z' },
    createOpts: { agentKind: 'claude-code', workingDir: '/repo', model: 'm' },
    ...(origin ? { origin } : {}),
  } as AgentInputQueuedMessage;
}

const ownReport = (clientId: string, text: string) =>
  queued(clientId, text, {
    kind: 'orca',
    senderLabel: 'reviewer',
    displayText: text,
    senderSessionId: WORKER.workerSessionId,
  });
const otherWorkerReport = (clientId: string, text: string) =>
  queued(clientId, text, {
    kind: 'orca',
    senderLabel: 'developer',
    displayText: text,
    senderSessionId: 'other-worker-session',
  });
const typedByUser = (clientId: string, text: string) => queued(clientId, text, undefined);

/** The Lead's queue with the coordinator's documented rules: identity-preserving replace, merge of consecutive rows only. */
function makeLeadQueue(
  initial: AgentInputQueuedMessage[],
  opts: { standing?: (queuedIds: string[]) => WorkerReportWithdrawalStanding } = {},
) {
  const adopted: string[] = [];
  let queue = [...initial];
  const withdrawn: string[] = [];
  const deps: OrcaWorkerReportQueueDeps = {
    getSessionQueueSnapshot: async () => ({
      pendingQueue: [...queue],
      consumingClientIds: [],
      isWorking: true,
      willQueue: true,
      queuePaused: false,
    }),
    ensureQueueRestored: async () => true,
    replaceQueuedMessage: (_sessionId, clientId, next, expected) => {
      const index = queue.findIndex((item) => item.clientId === clientId);
      if (index < 0 || (expected && queue[index] !== expected)) return false;
      queue[index] = next;
      return true;
    },
    removeQueuedMessage: (_sessionId, clientId) => {
      const index = queue.findIndex((item) => item.clientId === clientId);
      if (index < 0) return false;
      queue.splice(index, 1);
      withdrawn.push(clientId);
      return true;
    },
    mergeQueuedMessages: (_sessionId, clientIds, buildReplacement) => {
      const first = queue.findIndex((item) => item.clientId === clientIds[0]);
      const targets = clientIds.map((_id, offset) => queue[first + offset]);
      if (first < 0 || targets.some((item, offset) => item?.clientId !== clientIds[offset])) return false;
      const replacement = buildReplacement(targets as AgentInputQueuedMessage[]);
      if (!replacement) return false;
      queue = [...queue.slice(0, first), replacement, ...queue.slice(first + clientIds.length)];
      return true;
    },
    resolveWorkerRole: async () => 'reviewer',
    // Default: no Lead assignment is running, so only the queue itself can be consulted.
    adoptQueuedReport: (_workerSessionId, queuedMessageId) => {
      adopted.push(queuedMessageId);
    },
    reportWithdrawalStanding: () =>
      opts.standing?.(queue.map((item) => item.clientId)) ?? 'untracked',
    log: { info: () => undefined },
  };
  return {
    service: createOrcaWorkerReportQueue(deps),
    /** What the Lead would read, in order. */
    leadReads: () => queue.map((item) => `${item.clientId}:${item.text}`),
    withdrawn,
    adopted,
  };
}

describe('Worker management of its own reports queued at the Lead', () => {
  it('shows a Worker only its own reports and counts everything else', async () => {
    const { service } = makeLeadQueue([
      typedByUser('user-1', 'private note from the user'),
      ownReport('r1', 'Full report'),
      otherWorkerReport('o1', 'Another worker result'),
      ownReport('r2', 'Verdict unchanged'),
    ]);

    await expect(service.list(WORKER)).resolves.toEqual({
      leadIsWorking: true,
      willQueue: true,
      queuePaused: false,
      queuedCount: 4,
      reports: [
        { queuedMessageId: 'r1', position: 1, content: 'Full report', consuming: false },
        { queuedMessageId: 'r2', position: 3, content: 'Verdict unchanged', consuming: false },
      ],
    });
  });

  it('rewrites an own report in place and refuses anyone else\'s message', async () => {
    const { service, leadReads } = makeLeadQueue([
      typedByUser('user-1', 'typed'),
      ownReport('r1', 'Full report'),
      otherWorkerReport('o1', 'Another worker result'),
    ]);

    await expect(service.update({ ...WORKER, queuedMessageId: 'r1', message: 'Blocking issues only' }))
      .resolves.toEqual({ ok: true, queuedMessageId: 'r1' });
    for (const queuedMessageId of ['user-1', 'o1']) {
      await expect(service.update({ ...WORKER, queuedMessageId, message: 'hijacked' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'NOT_YOUR_MESSAGE' });
    }
    await expect(service.cancel({ ...WORKER, queuedMessageId: 'o1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'NOT_YOUR_MESSAGE' });

    // Same id and position, in the worker→lead wire format the Lead prompt describes.
    expect(leadReads()).toEqual([
      'user-1:typed',
      'r1:[From Orca Worker reviewer (worker_id: w-review)]\nBlocking issues only',
      'o1:Another worker result',
    ]);
  });

  it.each<{ name: string; queue: string[]; standing: WorkerReportWithdrawalStanding; allowed: boolean }>([
    { name: 'the assignment has another accepted report', queue: ['r1'], standing: 'covered', allowed: true },
    { name: 'it belongs to an earlier assignment', queue: ['r1'], standing: 'other-assignment', allowed: true },
    { name: 'no assignment is running but another report stays queued', queue: ['r1', 'r2'], standing: 'untracked', allowed: true },
    // Review case: an earlier assignment's report still queued does not cover this one.
    { name: 'it is the assignment\'s only report', queue: ['r1', 'older'], standing: 'last', allowed: false },
    { name: 'no assignment is running and nothing else is queued', queue: ['r1'], standing: 'untracked', allowed: false },
  ])('withdraws a queued report only while the Lead still gets one: $name', async ({ queue, standing, allowed }) => {
    const { service, withdrawn } = makeLeadQueue(
      queue.map((id) => ownReport(id, `report ${id}`)),
      { standing: () => standing },
    );

    const result = await service.cancel({ ...WORKER, queuedMessageId: 'r1' });
    if (allowed) {
      expect(result).toEqual({ ok: true, queuedMessageId: 'r1' });
      expect(withdrawn).toEqual(['r1']);
    } else {
      // Accepting a report already settled the Worker's reporting duty, so nothing would be auto-bridged later.
      expect(result).toMatchObject({ ok: false, errorCode: 'LAST_REPORT' });
      expect(withdrawn).toEqual([]);
    }
  });

  it('keeps one report when two withdrawals are issued in the same tool batch', async () => {
    // The host forgets a report the moment it is withdrawn, so the second call sees one left.
    const { service, leadReads } = makeLeadQueue(
      [ownReport('r1', 'first'), ownReport('r2', 'second')],
      { standing: (queuedIds) => (queuedIds.length > 1 ? 'covered' : 'last') },
    );

    const results = await Promise.all([
      service.cancel({ ...WORKER, queuedMessageId: 'r1' }),
      service.cancel({ ...WORKER, queuedMessageId: 'r2' }),
    ]);

    expect(results.map((result) => (result.ok ? 'ok' : result.errorCode))).toEqual(['ok', 'LAST_REPORT']);
    expect(leadReads()).toEqual(['r2:second']);
  });

  // Review finding: a failed Lead turn's retry / auto-resume copies the failed input, origin
  // included. Those rows are the Lead's own recovery; treating them as Worker reports would let
  // a Worker rewrite or cancel the Lead's resume.
  it.each([
    { name: 'hidden continue instruction', patch: { originalSyntheticTrigger: 'continue' as const, autoResume: true } },
    { name: 'zero-output resend', patch: { supersedesUserClientId: 'r0', retrySourceClientId: 'r0' } },
  ])('does not expose the Lead\'s own recovery input as a Worker report: $name', async ({ patch }) => {
    const { service, leadReads, withdrawn } = makeLeadQueue([
      { ...ownReport('recovery', 'report being retried'), ...patch },
      ownReport('r1', 'Full report'),
    ]);

    expect((await service.list(WORKER)).reports.map((report) => report.queuedMessageId)).toEqual(['r1']);
    await expect(service.update({ ...WORKER, queuedMessageId: 'recovery', message: 'hijacked' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'NOT_YOUR_MESSAGE' });
    await expect(service.cancel({ ...WORKER, queuedMessageId: 'recovery' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'NOT_YOUR_MESSAGE' });
    expect(leadReads()[0]).toBe('recovery:report being retried');
    expect(withdrawn).toEqual([]);
  });

  // Review finding (#9594): merging an earlier assignment's report with the current assignment's
  // only report keeps the first id, so the survivor must take over the current assignment's
  // record — otherwise it reads as "earlier assignment" and can be withdrawn, leaving the Lead
  // with nothing from this assignment. Unit tier.
  it.each([
    { name: 'a merged report is the current assignment\'s', standing: 'last' as const, adopts: true },
    { name: 'all merged reports belong to earlier assignments', standing: 'other-assignment' as const, adopts: false },
  ])('hands the current assignment\'s report record to the merge survivor: $name', async ({ standing, adopts }) => {
    const { service, adopted } = makeLeadQueue(
      [ownReport('r1', 'earlier'), ownReport('r2', 'current')],
      { standing: () => standing },
    );

    await expect(service.merge({ ...WORKER, queuedMessageIds: ['r1', 'r2'], message: 'one report' }))
      .resolves.toMatchObject({ ok: true, queuedMessageId: 'r1' });
    expect(adopted).toEqual(adopts ? ['r1'] : []);

    // A refused merge must not move the record.
    const refused = makeLeadQueue(
      [ownReport('r1', 'earlier'), typedByUser('user-1', 'typed'), ownReport('r2', 'current')],
      { standing: () => 'last' },
    );
    await refused.service.merge({ ...WORKER, queuedMessageIds: ['r1', 'r2'], message: 'one report' });
    expect(refused.adopted).toEqual([]);
  });

  it('merges adjacent own reports into one and leaves the queue untouched when they are not adjacent', async () => {
    const adjacent = makeLeadQueue([
      ownReport('r1', 'Full report'),
      ownReport('r2', 'Verdict unchanged'),
      typedByUser('user-1', 'typed'),
    ]);
    await expect(adjacent.service.merge({ ...WORKER, queuedMessageIds: ['r1', 'r2'], message: 'One current report' }))
      .resolves.toMatchObject({ ok: true, queuedMessageId: 'r1', status: { reports: [{ queuedMessageId: 'r1', position: 0 }] } });
    expect(adjacent.leadReads()).toEqual([
      'r1:[From Orca Worker reviewer (worker_id: w-review)]\nOne current report',
      'user-1:typed',
    ]);

    // Folding r2 into r1 across the user's message would move its content ahead of that message.
    const split = makeLeadQueue([
      ownReport('r1', 'Full report'),
      typedByUser('user-1', 'typed'),
      ownReport('r2', 'Verdict unchanged'),
    ]);
    const before = split.leadReads();
    await expect(split.service.merge({ ...WORKER, queuedMessageIds: ['r1', 'r2'], message: 'One current report' }))
      .resolves.toMatchObject({
        ok: false,
        errorCode: 'QUEUE_CHANGED',
        status: { reports: [{ queuedMessageId: 'r1', position: 0 }, { queuedMessageId: 'r2', position: 2 }] },
      });
    expect(split.leadReads()).toEqual(before);
  });
});
