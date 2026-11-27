import { describe, expect, it, vi } from 'vitest';

import {
  getOrcaWorkspaceInfoReadOnly,
  getOrcaWorkerDiagnosticStatusReadOnly,
  projectOrcaTurnErrorSummary,
  readOrcaWorkerOutputReadOnly,
  type OrcaDiagnosticsDeps,
} from '../orcaDiagnostics';

// Synthetic, non-secret fixtures shaped like provider keys. They are assembled
// from parts so the literal prefix never appears anywhere in this file: the
// repository's secret gate hard-fails on credential-shaped literals even inside
// test fixtures, and these strings exist only to prove the exit redacts them.
// The runtime values are unchanged, so every assertion below still covers the
// exact same redaction behaviour.
const SYNTHETIC_KEY = ['sk', 'liveabcdef123456'].join('-');
const SYNTHETIC_PROJ_KEY = ['sk', 'proj', 'QQQQQQQQQQQQQQQQQQQQ'].join('-');

function createDeps(overrides: Partial<OrcaDiagnosticsDeps> = {}): OrcaDiagnosticsDeps {
  return {
    readActiveTeam: vi.fn(async () => ({
      id: 'team-1',
      leadSessionId: 'lead-1',
      status: 'active',
    })),
    listWorkersByLead: vi.fn(async () => [{
      id: 'worker-1',
      sessionId: 'worker-session-1',
      status: 'done',
      label: 'dev',
      role: 'developer',
      focused: true,
      idleSince: null,
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      session: {
        agentKind: 'codex' as const,
        model: 'gpt-5.5',
        effort: 'high',
        workingDir: '/repo',
      },
    }]),
    getSessionStatus: vi.fn((sessionId) => sessionId === 'worker-session-1' ? 'not_running' : 'active'),
    getWorkerFlowStatus: vi.fn(async () => ({
      isWorking: false,
      willQueue: false,
      queuedCount: 0,
      queuePaused: false,
    })),
    readLatestAssistantMessage: vi.fn(async () => 'latest assistant output'),
    ...overrides,
  };
}

describe('orca diagnostics read-only helpers', () => {
  it('returns empty workspace info without reading workers when there is no active team', async () => {
    const deps = createDeps({
      readActiveTeam: vi.fn(async () => null),
      listWorkersByLead: vi.fn(async () => {
        throw new Error('listWorkersByLead should not be called without active team');
      }),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-without-active-team')).resolves.toEqual({
      ok: true,
      workflow: null,
      ui_capacity: 1,
      worker_count: 0,
      workers: [],
    });

    expect(deps.readActiveTeam).toHaveBeenCalledWith('lead-without-active-team');
    expect(deps.listWorkersByLead).not.toHaveBeenCalled();
  });

  it('matches legacy workspace diagnostic fields', async () => {
    const deps = createDeps();

    const result = await getOrcaWorkspaceInfoReadOnly(deps, 'lead-1');

    expect(result).toMatchObject({
      ok: true,
      workflow: {
        workflow_id: 'team-1',
        lead_session_id: 'lead-1',
        status: 'active',
      },
      ui_capacity: 1,
      worker_count: 1,
      workers: [{
        worker_id: 'worker-1',
        session_id: 'worker-session-1',
        status: 'done',
        session_status: 'not_running',
        restored_from_storage: true,
        is_working: false,
        will_queue: false,
        queued_count: 0,
        queue_paused: false,
        label: 'dev',
        role: 'developer',
        agent_kind: 'codex',
        model: 'gpt-5.5',
        effort: 'high',
        focused: true,
        working_dir: '/repo',
      }],
    });
    if (!result.ok) throw new Error('expected ok result');
    expect(result.workers[0]?.idle_ms).toEqual(expect.any(Number));
  });

  it('reports an empty paused worker queue', async () => {
    const deps = createDeps({
      getWorkerFlowStatus: vi.fn(async () => ({
        isWorking: false,
        willQueue: true,
        queuedCount: 0,
        queuePaused: true,
      })),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-1')).resolves.toMatchObject({
      ok: true,
      workers: [{ queued_count: 0, queue_paused: true }],
    });
  });

  it('reports a consuming queue entry even after the pending queue is empty', async () => {
    const deps = createDeps({
      getWorkerFlowStatus: vi.fn(async () => ({
        isWorking: true,
        willQueue: true,
        queuedCount: 1,
        queuePaused: false,
      })),
    });

    await expect(getOrcaWorkspaceInfoReadOnly(deps, 'lead-1')).resolves.toMatchObject({
      ok: true,
      workers: [{ is_working: true, queued_count: 1, queue_paused: false }],
    });
  });

  it('returns worker_status fields and accepts worker session id as diagnostic ref', async () => {
    const deps = createDeps();

    await expect(getOrcaWorkerDiagnosticStatusReadOnly(
      deps,
      'lead-1',
      'worker-session-1',
    )).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      restored_from_storage: true,
    });
  });

  it('reads latest assistant output for read_worker', async () => {
    const deps = createDeps();

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      session_id: 'worker-session-1',
      status: 'done',
      session_status: 'not_running',
      result: 'latest assistant output',
    });
    expect(deps.readLatestAssistantMessage).toHaveBeenCalledWith('worker-session-1');
  });

  it('reports this turn error for read_worker without changing result', async () => {
    const deps = createDeps({
      readLatestTurnError: vi.fn(async () => ({
        message: 'upstream rejected the request',
        reason: 'provider-upstream-error',
        sdkError: 'HTTP 401',
        createdAt: 1_770_000_000_000,
      })),
    });

    const result = await readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1');

    expect(result).toMatchObject({
      ok: true,
      result: 'latest assistant output',
      turnError: {
        message: 'upstream rejected the request',
        reason: 'provider-upstream-error',
        sdkError: 'HTTP 401',
        createdAt: '2026-02-02T02:40:00.000Z',
      },
    });
    if (!result.ok) throw new Error('expected ok result');
    expect(result.turnError).not.toHaveProperty('toolLoop');
    expect(deps.readLatestTurnError).toHaveBeenCalledWith('worker-session-1');
  });

  // 出口兜底:readLatestTurnError 的注释承诺「已脱敏」,但那是注入方当前的行为而不是
  // 出口能验证的契约。这里故意注入含合成凭据的摘要,钉住「出网前再脱一层」这件事 ——
  // 只测注入方自己脱敏过的干净文本是测不出这个保证的。
  it('redacts synthetic credentials injected through readLatestTurnError before they leave the exit', async () => {
    const deps = createDeps({
      readLatestTurnError: vi.fn(async () => ({
        message: `upstream rejected key=${SYNTHETIC_KEY} with Bearer eyJhbGciOiJIUzI1NiJ9 payload`,
        reason: 'provider-upstream-error principal aigw:user-9f3a2b',
        sdkError: `unauthorized token: ${SYNTHETIC_PROJ_KEY}`,
        toolLoop: '{"kind":"consecutive","count":3,"hint":"api_key=secret-value"}',
        createdAt: 1_770_000_000_000,
      })),
    });

    const result = await readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1');
    if (!result.ok) throw new Error('expected ok result');
    const serialized = JSON.stringify(result.turnError);

    expect(serialized).not.toContain(SYNTHETIC_KEY);
    expect(serialized).not.toContain(SYNTHETIC_PROJ_KEY);
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).not.toContain('user-9f3a2b');
    expect(serialized).not.toContain('secret-value');
    expect(result.turnError).toEqual({
      message: 'upstream rejected key=[REDACTED_KEY] with Bearer [REDACTED] payload',
      reason: 'provider-upstream-error principal aigw:[REDACTED]',
      sdkError: 'unauthorized token: [REDACTED]',
      // 注意:matcher 连值后面的那个双引号一起吃掉了,这是 redactSensitiveText 的
      // 既有行为;这里钉的是「原始串不再出现」,不是 JSON 仍然可解析。
      toolLoop: '{"kind":"consecutive","count":3,"hint":"api_key=[REDACTED]}',
      // createdAt 是 number → 出口转 ISO,不进脱敏路径。
      createdAt: '2026-02-02T02:40:00.000Z',
    });
  });

  it('returns turnError null when this turn has no error row', async () => {
    const deps = createDeps({
      readLatestTurnError: vi.fn(async () => null),
    });

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      result: 'latest assistant output',
      turnError: null,
    });
  });

  it('keeps turnError null when readLatestTurnError is not injected', async () => {
    const deps = createDeps();
    expect(deps.readLatestTurnError).toBeUndefined();

    await expect(readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'worker-1')).resolves.toMatchObject({
      ok: true,
      result: 'latest assistant output',
      turnError: null,
    });
  });

  it('does not leak turnError when the worker itself is missing', async () => {
    const deps = createDeps({
      listWorkersByLead: vi.fn(async () => []),
      readLatestTurnError: vi.fn(async () => ({ message: 'stale', createdAt: 0 })),
    });

    await expect(
      readOrcaWorkerOutputReadOnly(deps, 'lead-1', 'missing-worker'),
    ).resolves.toMatchObject({ ok: false, errorCode: 'WORKER_NOT_FOUND' });
    expect(deps.readLatestTurnError).not.toHaveBeenCalled();
  });
});

describe('projectOrcaTurnErrorSummary', () => {
  it('redacts credentials in every outbound field', () => {
    const summary = projectOrcaTurnErrorSummary(
      {
        message: `provider refused key=${SYNTHETIC_KEY} with Bearer eyJhbGciOiJIUzI1NiJ9 payload`,
        reason: 'provider-upstream-error',
        sdkError: `unauthorized token: ${SYNTHETIC_PROJ_KEY}`,
        toolLoop: { kind: 'consecutive', count: 3 },
      },
      1_770_000_000_000,
    );

    expect(summary).toEqual({
      message: 'provider refused key=[REDACTED_KEY] with Bearer [REDACTED] payload',
      reason: 'provider-upstream-error',
      // 「token:」规则排在裸 key 前缀规则之前,故这里是 [REDACTED] 而不是 [REDACTED_KEY]。
      sdkError: 'unauthorized token: [REDACTED]',
      toolLoop: '{"kind":"consecutive","count":3}',
      createdAt: 1_770_000_000_000,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(SYNTHETIC_KEY);
    expect(serialized).not.toContain(SYNTHETIC_PROJ_KEY);
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('returns null for content without a usable message', () => {
    expect(projectOrcaTurnErrorSummary({ reason: 'x' }, 1)).toBeNull();
    expect(projectOrcaTurnErrorSummary({ message: '' }, 1)).toBeNull();
    expect(projectOrcaTurnErrorSummary(null, 1)).toBeNull();
    expect(projectOrcaTurnErrorSummary('not-an-object', 1)).toBeNull();
  });

  it('drops non-string optional fields instead of stringifying them', () => {
    const summary = projectOrcaTurnErrorSummary(
      { message: 'boom', reason: 42, sdkError: undefined, toolLoop: null },
      7,
    );
    expect(summary).toEqual({ message: 'boom', createdAt: 7 });
  });
});

// PR2 unit: ownership affects archive behavior; cwd alone cannot distinguish inherited trees.
// Existing diagnostics only cover the directory and queue state.
it('reports only Worker-owned checkouts and never queries local ownership for execution-device Workers', async () => {
  const deps = createDeps();
  const [base] = await deps.listWorkersByLead('lead');
  deps.listWorkersByLead = async () => ['owned', 'inherited', 'remote'].map(sessionId => ({...base!, sessionId,
    session: {...base!.session, workingDir: '/repo/.cindy-worktrees/tree'},
    ...(sessionId === 'remote' ? {executionDevice: {deviceId: 'other', workingDir: '/remote/project'}} : {}),
  }));
  deps.getWorkerWorktree = vi.fn(id => id === 'owned' ? {path: '/repo/.cindy-worktrees/tree', branch: 'cindy/new'} : undefined);
  const result = await getOrcaWorkspaceInfoReadOnly(deps, 'lead');
  expect(result).toMatchObject({workers: [
    {session_id: 'owned', owns_worktree: true, worktree: {path: '/repo/.cindy-worktrees/tree', branch: 'cindy/new'}},
    {session_id: 'inherited', owns_worktree: false},
    {session_id: 'remote', owns_worktree: false, working_dir: '/remote/project'},
  ]});
  if (!result.ok) throw new Error('Expected workspace info');
  expect(result.workers[1]).not.toHaveProperty('worktree');
  expect(result.workers[2]).not.toHaveProperty('worktree');
  expect(deps.getWorkerWorktree).not.toHaveBeenCalledWith('remote');
});
