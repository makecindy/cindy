/**
 * Value: production tool admission + queued dispatch guards, no real account or network.
 * Regression: task actions added owner consent checks after the normal runtime permission flow;
 * 2026-10-29: missing owner provenance silently rejected routine_save and start_session_task.
 * Rule: teammate-authority.md — separate source identity, account access and explicit operation risks.
 * Gap: workbench tests cover visibility; SDK approval tests cannot prove Host consent.
 * Minimum input: non-owner provenance + runtime change; live execution modes do not review twice.
 * Tier: unit. This file isolates the process-local authorization lifetime from SQLite/IPC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoReviewDecision, PermissionMode, SendOrigin } from '@cindy/maker-core';
import { getDesktopMcpToolApprovalPolicy } from '../../maker-host/mcp-tool-approval-policy.js';
import { GoalController } from '../../goal-host/controller.js';
import type { GoalState, SessionLike } from '../../goal-host/types.js';
import { createSessionGoalCallbacks } from '../../mcp-integrations/sessionGoal.js';
import { withToolCallAuthority } from '../../../../../../packages/lizi-mcps/src/tool-call-authority.js';
import { createOrcaMcpServer } from '../../../../../../packages/lizi-mcps/src/orca/server.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  approvedTaskDelegation,
  assertTaskActionCurrent,
  bindTaskActionInput,
  createTaskActionAuthorizer,
  taskActionInputGuard,
  taskActionPrincipal,
  taskActionRoutineRevision,
  type TaskActionScheduleDefinition,
  hasTaskActionAuthorization,
  TASK_ACTION_TOOLS,
  ORCA_TASK_ACTION_TOOLS,
  captureTaskActionSyncGuard,
  captureTaskActionGuard,
  captureTaskActionDeliveryGuard,
  taskActionGoalSnapshot,
  isTaskActionRevoked,
} from '../taskActionAuthorization.js';

function fixture(ownerInput = false, delegated = false) {
  let current = true;
  const confirm = vi.fn(async () => true);
  const authorize = createTaskActionAuthorizer({
    capture: async () => ({
      key: 'accepted-input',
      ownerInput,
      delegated,
      assertCurrent: async () => {
        if (!current) throw new Error('revoked');
      },
    }),
    confirm,
  });
  return {
    authorize,
    confirm,
    revoke: () => {
      current = false;
    },
  };
}
const call = (tool = 'continue_workbench_task') => ({
  sessionId: 'companion',
  server: 'cindy_helper' as const,
  tool,
  args: { task_id: 'task', message: 'Continue the approved work' },
});
const input = (): AgentInputQueuedMessage => ({
  clientId: 'queued',
  text: 'Approved body',
  persistedContent: 'Approved body',
  model: 'model',
  effort: '',
  permissionMode: 'bypassPermissions',
  workingDir: '/tmp/test',
  chatMessage: { clientId: 'queued', role: 'user', content: 'Approved body' },
  createOpts: { agentKind: 'codex', workingDir: '/tmp/test', model: 'model' },
  origin: {
    kind: 'session',
    senderSessionId: 'companion',
    senderBotId: 'bot',
    displayText: 'Approved body',
  },
});

describe('Host task action authorization', () => {
  it('permits observation and notification, but rejects every alternate task-write entrance before effects', async () => {
    const h = fixture();
    const queue: string[] = [];
    let route = 'original';
    for (const tool of TASK_ACTION_TOOLS) {
      const result = await withToolCallAuthority(h.authorize, call(tool), async () => {
        queue.push('unauthorized');
        route = 'changed';
        return { ok: true };
      });
      expect(result).toMatchObject({ isError: true });
    }
    for (const tool of ORCA_TASK_ACTION_TOOLS) {
      expect(
        await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server: 'cindy_orca' },
          async () => {
            queue.push('unauthorized');
          },
        ),
      ).toMatchObject({ isError: true });
    }
    expect(queue).toEqual([]);
    expect(route).toBe('original');
    expect(h.confirm).not.toHaveBeenCalled();
    for (const tool of ['get_task_digest', 'get_workbench', 'schedule_notify_current_run']) {
      expect(
        await withToolCallAuthority(h.authorize, call(tool), async () => 'read-or-remind'),
      ).toBe('read-or-remind');
    }
  });

  it('binds a real confirmation to one exact invocation and consumes it once', async () => {
    const h = fixture(true);
    const request = call();
    const decision = await h.authorize(request);
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args);
    if (!decision.ok || !decision.run) throw new Error('missing Host grant');
    const operation = vi.fn(async () => 'sent');
    expect(await decision.run(operation)).toBe('sent');
    await expect(decision.run(operation)).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(['task_id', 'message'] as const)(
    'rejects a changed %s after confirmation',
    async (key) => {
      const h = fixture(true),
        request = call();
      const decision = await h.authorize(request);
      request.args[key] = 'different';
      const operation = vi.fn(async () => 'sent');
      if (!decision.ok || !decision.run) throw new Error('missing Host grant');
      await expect(decision.run(operation)).rejects.toThrow('AUTHORIZATION_EXPIRED');
      expect(operation).not.toHaveBeenCalled();
    },
  );

  it('does not let approval racing with revocation execute', async () => {
    const h = fixture(true);
    h.confirm.mockImplementation(async () => {
      h.revoke();
      return true;
    });
    expect(await h.authorize(call())).toMatchObject({
      ok: false,
      errorCode: 'TASK_ACTION_AUTHORIZATION_EXPIRED',
    });
  });

  it('reuses a verified delegation without another confirmation and mints creation evidence only in the Host call', async () => {
    const h = fixture(false, true);
    expect(approvedTaskDelegation('companion')).toBeUndefined();
    expect(
      await withToolCallAuthority(
        h.authorize,
        call('message_session_task'),
        async () => 'continued',
      ),
    ).toBe('continued');
    expect(h.confirm).not.toHaveBeenCalled();
    const owner = fixture(true);
    const receipt = await withToolCallAuthority(
      owner.authorize,
      call('start_session_task'),
      async () => approvedTaskDelegation('companion'),
    );
    expect(receipt).toMatchObject({
      version: 1,
      actions: expect.arrayContaining(['message_session_task']),
    });
    expect(approvedTaskDelegation('companion')).toBeUndefined();
  });

  it('checks delayed input again, rejects target/content changes and cannot restore authority from JSON', async () => {
    const h = fixture(true),
      queued = input();
    await withToolCallAuthority(h.authorize, call(), async () => {
      bindTaskActionInput('target', queued);
    });
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
    await expect(taskActionInputGuard('another', queued)!()).rejects.toThrow(
      'AUTHORIZATION_EXPIRED',
    );
    await expect(
      taskActionInputGuard('target', { ...queued, text: 'different' })!(),
    ).rejects.toThrow('AUTHORIZATION_EXPIRED');
    await expect(
      taskActionInputGuard('target', JSON.parse(JSON.stringify(queued)))!(),
    ).rejects.toThrow('AUTHORIZATION_REQUIRED');
    h.revoke();
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow('revoked');
  });

  it('holds old Bot queue rows on upgrade without deleting sent history or treating ordinary user input as automatic', async () => {
    await expect(taskActionInputGuard('target', input())!()).rejects.toThrow(
      'AUTHORIZATION_REQUIRED',
    );
    expect(taskActionInputGuard('target', { ...input(), origin: undefined })).toBeUndefined();
  });
});

// Regression #6399: the pure scope fixture above cannot detect lost group owner
// provenance or a second confirmation added to the owner's ordinary tool flow.
// Exercise the Desktop adapter + real group registry + shared helper/Orca entry.
// SQLite/account/routine IO is replaced with in-memory facts (unit tier).
const hostFacts = vi.hoisted(() => ({ getDb: vi.fn(), boundaryPending: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ tryGetDbClient: hostFacts.getDb }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: hostFacts.boundaryPending,
}));
vi.mock('../../routines/service.js', () => ({
  readActiveFollowUpRoutine: () => ({ enabled: false, revision: 1 }),
}));
import { botDelegations, orcaTeams } from '../../localDb/schema.js';
import { createDesktopTaskActionAuthorizer } from '../taskActionHost.js';
import { beginChannelToolScope } from '../../im/shared/channelToolScope.js';
import {
  registerGroupToolAuthority,
  GroupToolAuthorizationError,
} from '../botGroupToolAuthorization.js';

const releases: Array<() => void> = [];
afterEach(() => {
  releases.splice(0).forEach((release) => release());
});
function desktopFixture(kind: 'private' | 'group' | 'automatic' = 'group') {
  const caller = {
    source: 'bot',
    role: kind === 'group' ? 'group' : 'canonical',
    botId: 'bot' as string | null,
    botStatus: 'active',
    status: 'active',
    archivedAt: null,
    clearedAt: null,
  };
  const rows = {
    delegation: null as null | {
      status: string;
      runSequence: number;
      permissionSnapshotJson: string;
    },
    team: null as null | { id: string },
  };
  const db = {
    drizzle: {
      select: () => {
        let table: unknown;
        const query = {
          from: (value: unknown) => {
            table = value;
            return query;
          },
          leftJoin: () => query,
          innerJoin: () => query,
          where: () => query,
          limit: async () =>
            table === botDelegations
              ? rows.delegation
                ? [rows.delegation]
                : []
              : table === orcaTeams
                ? rows.team
                  ? [rows.team]
                  : []
                // SQL reads return value snapshots, not a shared mutable row.
                : [{ ...caller }],
        };
        return query;
      },
    },
  };
  hostFacts.getDb.mockReturnValue(db);
  hostFacts.boundaryPending.mockReturnValue(false);
  const activeInput = {
    permission: undefined as undefined | {
      permissionMode: string;
      planModeEnabled: boolean;
      isCurrent(): boolean;
    },
    orcaSenderSessionId: undefined as string | undefined,
    key: 'owner-request',
    isInputCompleted: undefined as undefined | (() => boolean),
    ownerInput: kind === 'private',
    ownerContinuation: false,
    automatic: kind !== 'private',
    boundary: 'runtime-1',
    clearBoundaryMs: null as number | null,
  };
  const confirm = vi.fn(async () => true);
  const runtime = {
    instanceId: 'instance-1',
    stablePermissionModeState: { mode: 'auto' as PermissionMode, generation: 1 },
    stablePlanModeState: { enabled: false, generation: 1 },
    getCurrentTurnOrigin: (): SendOrigin | null => null,
    reviewHostPermissionAction: vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'allow' })),
  };
  const getSession = vi.fn((): typeof runtime | undefined => runtime);
  const permissionRequest = { requestId: 'permission-1', kind: 'permission',
    toolName: 'bash', input: { command: 'echo reviewed' } };
  const capturePermissionRequest = vi.fn(async () => {
    const request = structuredClone(permissionRequest);
    return {
      details: { task: { id: 'own', title: 'Child task' }, request },
      assertCurrent() {
        if (JSON.stringify(permissionRequest) !== JSON.stringify(request))
          throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      },
    };
  });
  const routines = new Map<string, { enabled: boolean; revision: number; prompt?: string; preRunCommand?: string }>();
  const schedules = new Map<string, TaskActionScheduleDefinition>();
  const workDirs = new Map([['companion', '/companion']]);
  let goal: { status: 'active' | 'paused' | 'blocked' | 'usageLimited'; objective: string } | null = null;
  const getGoal = vi.fn(async () => goal ? { ...goal } : null);
  const getScheduleDefinition = vi.fn(async (id: string) => structuredClone(schedules.get(id) ?? null));
  const authorize = createDesktopTaskActionAuthorizer({
    input: () => ({ ...activeInput }), confirm, getSession,
    capturePermissionRequest,
    getGoal,
    getScheduleDefinition,
    getSessionWorkDir: async id => workDirs.get(id),
    captureRoutine: async (_botId, id, forExecution) => {
      const row = routines.get(id);
      if (!row) return undefined;
      const captured = { ...row };
      return { ...captured, prompt: captured.prompt ?? '', details: { routine: { id, ...captured },
        ...(forExecution && captured.preRunCommand ? { execution: {
          targetSessionId: `routine-${id}`, workingDir: workDirs.get(`routine-${id}`),
        } } : {}) }, assertCurrent() {
        if (routines.get(id)?.revision !== captured.revision)
          throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      } };
    },
  });
  return { authorize, confirm, activeInput, caller, rows, runtime, getSession,
    permissionRequest, capturePermissionRequest, routines, schedules, workDirs, getScheduleDefinition, getGoal,
    setGoal: (value: typeof goal) => { goal = value; } };
}
const ownerWrites = [
  ['cindy_helper', 'start_session_task'],
  ['cindy_helper', 'send_to_session'],
  ['cindy_helper', 'continue_workbench_task'],
  ['cindy_helper', 'set_workbench_task_responsibility'],
  ['cindy_helper', 'set_session_runtime'],
  ['cindy_helper', 'update_goal'],
  ['cindy_orca', 'create_worker'],
  ['cindy_orca', 'send_to_worker'],
  ['cindy_orca', 'switch_focus'],
] as const;

// Regression #6399 / maker-core-and-agent-behavior.md "同范围自动跟进":
// production Desktop admission must deliver a user-scheduled send after normal
// permission review. Existing Bot-only automatic fixtures miss ordinary schedules.
// Minimum: ordinary scheduled turn + approved send_to_session; unit, in-memory IO.
// Standalone Vitest run: 2.72s (4.4s command wall time on Windows).
describe('Owner-delegated scheduled task actions', () => {
  function scheduledFixture() {
    const h = desktopFixture('automatic');
    h.caller.botId = null;
    h.caller.source = 'scheduler';
    const origin: SendOrigin = { kind: 'scheduler', runId: 'run-1' };
    h.runtime.getCurrentTurnOrigin = () => origin;
    return h;
  }
  const scheduledSend = () => ({
    ...call('send_to_session'),
    args: { target_session_id: 'target', message: 'Dispatch the new PR feedback' },
  });

  it('reuses a live scheduled permission flow without invoking the recovery reviewer', async () => {
    const h = scheduledFixture();
    h.activeInput.permission = {
      permissionMode: 'auto', planModeEnabled: false, isCurrent: () => true,
    };
    expect(await withToolCallAuthority(h.authorize, scheduledSend(), async () => 'sent')).toBe('sent');
    expect(h.runtime.reviewHostPermissionAction).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['direct', 'queued', 'bound'] as const)('delivers an approved %s scheduled dispatch without another confirmation', async route => {
    const h = scheduledFixture();
    if (route === 'bound') h.caller.source = 'desktop';
    h.activeInput.automatic = route === 'queued';
    const request = scheduledSend();
    const queued = input();
    const result = await withToolCallAuthority(h.authorize, request, async () => {
      bindTaskActionInput('target', queued);
      return 'sent';
    });
    expect(result).toBe('sent');
    // The admitted message can wait behind busy work after its source turn ends.
    h.runtime.getCurrentTurnOrigin = () => null;
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
    expect(h.runtime.reviewHostPermissionAction).toHaveBeenCalledWith({
      kind: 'other',
      description: JSON.stringify({
        toolName: 'mcp__cindy_helper__send_to_session',
        input: request.args,
        context: { source: 'scheduler', phase: 'triggered-continuation' },
      }),
    });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['bot', 'forwarded', 'missing-runtime', 'plan'] as const)('does not infer consent from %s scheduled metadata', async source => {
    const h = scheduledFixture();
    if (source === 'bot') h.caller.botId = 'bot';
    if (source === 'forwarded') h.runtime.getCurrentTurnOrigin = () => null;
    if (source === 'missing-runtime') h.getSession.mockReturnValue(undefined);
    if (source === 'plan') h.runtime.stablePlanModeState.enabled = true;
    const effect = vi.fn(async () => 'sent');
    expect(await withToolCallAuthority(h.authorize, scheduledSend(), effect)).toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
    expect(h.runtime.reviewHostPermissionAction).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['block', 'ask', 'cancel'] as const)('respects a normal %s permission decision', async verdict => {
    const h = scheduledFixture();
    h.runtime.reviewHostPermissionAction.mockResolvedValue({ verdict: verdict === 'cancel' ? 'ask' : verdict });
    h.confirm.mockResolvedValue(verdict !== 'cancel');
    const effect = vi.fn(async () => 'sent');
    const result = await withToolCallAuthority(h.authorize, scheduledSend(), effect);
    if (verdict === 'ask') expect(result).toBe('sent');
    else expect(result).toMatchObject({ isError: true });
    expect(effect).toHaveBeenCalledTimes(verdict === 'ask' ? 1 : 0);
    expect(h.confirm).toHaveBeenCalledTimes(verdict === 'block' ? 0 : 1);
  });

  it.each(['message', 'target_session_id'] as const)('rejects %s rewritten while the permission review is pending', async key => {
    const h = scheduledFixture();
    const request = scheduledSend();
    h.runtime.reviewHostPermissionAction.mockImplementation(async () => {
      request.args[key] = 'unreviewed';
      return { verdict: 'allow' };
    });
    const effect = vi.fn(async () => 'sent');
    const result = await withToolCallAuthority(h.authorize, request, effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  // teammate-authority.md「延迟投递只认真实撤权」(2026-10-30): live turn facts still
  // expire the admission, but only real revocation stops a queued message. Before,
  // any of these rollovers between turns dropped every supplement still queued.
  // A held app-session boundary alone proves nothing (a same-owner Ghost projection repair holds
  // it too): the captured database client is the owner identity (review on #7969).
  it.each([
    ['permission', 'delivered'],
    ['plan', 'delivered'],
    ['instance', 'delivered'],
    ['input', 'delivered'],
    ['boundary', 'retryable'],
    ['owner', 'revoked'],
  ] as const)('invalidates admission after %s changes; delayed delivery is %s', async (changed, outcome) => {
    const h = scheduledFixture();
    const queued = input();
    const guard = await withToolCallAuthority(h.authorize, scheduledSend(), async () => {
      bindTaskActionInput('target', queued);
      return captureTaskActionSyncGuard()!;
    });
    if (typeof guard !== 'function') throw new Error('Expected an admitted delivery guard');
    await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
    expect(() => guard()).not.toThrow();
    if (changed === 'permission') h.runtime.stablePermissionModeState.generation++;
    if (changed === 'plan') h.runtime.stablePlanModeState.generation++;
    if (changed === 'instance') h.getSession.mockReturnValue({ ...h.runtime });
    if (changed === 'boundary') hostFacts.boundaryPending.mockReturnValue(true);
    if (changed === 'owner') hostFacts.getDb.mockReturnValue({});
    if (changed === 'input') h.activeInput.boundary = 'replacement-runtime';
    expect(() => guard()).toThrow('AUTHORIZATION_EXPIRED');
    const rejection = await taskActionInputGuard('target', queued)!().then(() => null, (error: unknown) => ({ error }));
    if (outcome === 'delivered') expect(rejection).toBeNull();
    else expect(rejection && isTaskActionRevoked(rejection.error)).toBe(outcome === 'revoked');
  });

  // Review on #7969: /clear moves the coordinator's boundary before cleared_at is persisted,
  // and persisting may fail, so delivery reads that boundary too. A persisted boundary the
  // coordinator merely loads late (restart) is older than the admission, not a new clear.
  it.each([
    { name: 'cleared in memory after admission', dbClearedAt: null, memoryAfter: 2_000, expired: true },
    { name: 'older persisted boundary loaded late', dbClearedAt: 1_000, memoryAfter: 1_000, expired: false },
  ])('queued delivery when $name (expired=$expired)', async ({ dbClearedAt, memoryAfter, expired }) => {
    const h = scheduledFixture();
    Object.assign(h.caller, { clearedAt: dbClearedAt });
    const queued = input();
    await withToolCallAuthority(h.authorize, scheduledSend(), async () => bindTaskActionInput('target', queued));
    h.activeInput.clearBoundaryMs = memoryAfter;
    const delivery = expect(taskActionInputGuard('target', queued)!());
    if (expired) await delivery.rejects.toThrow('AUTHORIZATION_EXPIRED');
    else await delivery.resolves.toBeUndefined();
  });

  // Only a proven revocation may destroy a queued message; a failed check keeps it for retry.
  it.each([
    [new Error('TASK_ACTION_AUTHORIZATION_EXPIRED'), true],
    [new Error('TASK_ACTION_AUTHORIZATION_REQUIRED'), true],
    [new Error('OWNER_SCOPE_CHANGED'), true],
    [Object.assign(new Error('revoked'), { code: 'GROUP_AUTHORIZATION_REQUIRED' }), true],
    [Object.assign(new Error('transport'), { code: 'GROUP_AUTHORIZATION_UNAVAILABLE' }), false],
    [new Error('DbClient not ready'), false],
  ])('classifies %s as revoked=%s', (error, revoked) => {
    expect(isTaskActionRevoked(error)).toBe(revoked);
  });

  it.each(['permission', 'account', 'turn'] as const)('does not act or prompt if %s changes during review', async changed => {
    const h = scheduledFixture();
    h.runtime.reviewHostPermissionAction.mockImplementation(async () => {
      if (changed === 'permission') h.runtime.stablePermissionModeState.generation++;
      if (changed === 'account') hostFacts.boundaryPending.mockReturnValue(true);
      if (changed === 'turn') h.runtime.getCurrentTurnOrigin = () => ({ kind: 'scheduler', runId: 'run-2' });
      return { verdict: 'ask' };
    });
    const effect = vi.fn(async () => 'sent');
    const result = await withToolCallAuthority(h.authorize, scheduledSend(), effect);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

// Review #8362 r4436235377 / teammate-authority.md: autonomous Goal edits that
// resume execution need the same risk confirmation as explicit Resume. Existing
// owner-write coverage omitted paused Goal state and confirmation replacement.
describe('Autonomous Goal edits', () => {
  function goalFixture(status: 'active' | 'paused' | 'blocked' | 'usageLimited' = 'paused') {
    const h = desktopFixture('automatic');
    h.activeInput.permission = { permissionMode: 'bypassPermissions', planModeEnabled: false, isCurrent: () => true };
    h.setGoal({ status, objective: 'old objective' });
    return h;
  }
  const edit = (objective = 'new objective') => ({ ...call('update_goal'), args: { objective } });

  // r4436295232: the real authorizer/callback/controller must preserve an admitted
  // resume across completion, but not new input or revocation. Unit, memory only.
  it.each(['owner', 'autonomous'] as const)('preserves a deferred %s Goal resume only across its originating input completion', async principal => {
    const h = goalFixture();
    h.activeInput.ownerInput = principal === 'owner';
    let running = true;
    let completed = false;
    h.activeInput.isInputCompleted = () => completed;
    let goal: GoalState = { sessionId: 'companion', objective: 'old objective', status: 'paused',
      budgetTokens: null, maxTurns: null, noProgressLimit: null, turnsUsed: 0, tokensUsed: 0,
      noProgressStreak: 0, usageResetAt: null, lastReason: null, agentKind: 'codex', startedAt: 1, updatedAt: 1 };
    h.getGoal.mockImplementation(async () => ({ status: goal.status as 'paused' | 'active', objective: goal.objective }));
    const send = vi.fn<SessionLike['send']>(async (_message, opts) => { opts?.onDispatching?.(); return { accepted: true }; });
    const session = { id: 'companion', agentKind: 'codex' as const, send,
      isTurnRunning: () => running, onEvent: () => () => {}, abort: async () => {} };
    const controller = new GoalController({
      storage: { get: async () => ({ ...goal }), upsert: async state => { goal = state; },
        update: async (_id, patch) => (goal = { ...goal, ...patch }), clear: async () => {},
        listActive: async () => [], listUsageLimited: async () => [] },
      getSession: () => session, ensureSession: async () => session, isSessionInTurn: () => false,
      stopActiveGoalTurn: () => {}, emitStatus: () => {},
      getDefaults: () => ({ maxTurns: null, budgetTokens: null, noProgressLimit: null }),
      logger: { info: () => {}, warn: () => {}, error: () => {} }, continuationDebounceMs: 0,
    });
    const callbacks = createSessionGoalCallbacks({ getController: () => controller,
      isCurrentSession: () => true, withAccess: async (_id, operation) => operation(async () => {}) });
    try {
      expect(await withToolCallAuthority(h.authorize, edit(),
        () => callbacks.update({ sessionId: 'companion', agentKind: 'codex', workingDir: '/fixture' }, 'new objective')))
        .toMatchObject({ ok: true, goal: { status: 'paused', objective: 'new objective' } });
      expect(send).not.toHaveBeenCalled();
      // The coordinator has cleared the originating input, with no replacement.
      completed = true;
      running = false;
      h.activeInput.key = 'idle';
      await controller.maybeContinueActiveGoal('companion');
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(goal.status).toBe('active');
      expect(send.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringContaining('new objective') });
      expect(h.confirm).toHaveBeenCalledTimes(principal === 'owner' ? 0 : 1);
    } finally { await controller.dispose(); }
  });

  it.each(['replacement', 'permission', 'account', 'boundary'] as const)('expires an idle Goal continuation after %s changes', async changed => {
    const h = goalFixture();
    let completed = false;
    let permissionCurrent = true;
    h.activeInput.isInputCompleted = () => completed;
    h.activeInput.permission!.isCurrent = () => permissionCurrent;
    const guard = await withToolCallAuthority(h.authorize, edit(), async () =>
      captureTaskActionSyncGuard({ allowInputCompletion: true })!);
    completed = true;
    h.activeInput.key = 'idle';
    expect(guard).not.toThrow();
    if (changed === 'replacement') completed = false; // retained coordinator revision changed
    if (changed === 'permission') permissionCurrent = false;
    if (changed === 'account') hostFacts.getDb.mockReturnValue({});
    if (changed === 'boundary') h.activeInput.boundary = 'new-runtime';
    expect(guard).toThrow('TASK_ACTION_AUTHORIZATION_EXPIRED');
  });

  it.each(['paused', 'blocked', 'usageLimited'] as const)('does not resume an autonomous %s Goal without confirmation', async status => {
    const h = goalFixture(status);
    h.confirm.mockResolvedValue(false);
    const effect = vi.fn(async () => 'edited');
    expect(await withToolCallAuthority(h.authorize, edit(), effect)).toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith('companion', 'update_goal', edit().args, {
      server: 'cindy_helper', risk: 'resume', details: { goal: { status, objective: 'old objective' } },
    });
  });

  it('carries the confirmed Goal snapshot into the admitted edit', async () => {
    const h = goalFixture();
    expect(await withToolCallAuthority(h.authorize, edit(), async () => taskActionGoalSnapshot()))
      .toEqual({ status: 'paused', objective: 'old objective' });
    expect(h.confirm).toHaveBeenCalledOnce();
  });

  it.each(['active', 'unchanged', 'owner', 'entrusted'] as const)('keeps %s Goal edits on the ordinary permission flow', async kind => {
    const h = goalFixture(kind === 'active' ? 'active' : 'paused');
    if (kind === 'owner') h.activeInput.ownerInput = true;
    if (kind === 'entrusted') h.runtime.getCurrentTurnOrigin = () => ({ kind: 'scheduler', runId: 'run', scheduleId: 'routine-user' });
    expect(await withToolCallAuthority(h.authorize, edit(kind === 'unchanged' ? 'old objective' : undefined), async () => 'edited')).toBe('edited');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['status', 'objective'] as const)('expires a confirmation when the Goal %s changes', async changed => {
    const h = goalFixture();
    h.confirm.mockImplementation(async () => {
      h.setGoal({ status: changed === 'status' ? 'active' : 'paused',
        objective: changed === 'objective' ? 'owner edit' : 'old objective' });
      return true;
    });
    const effect = vi.fn(async () => 'edited');
    expect(await withToolCallAuthority(h.authorize, edit(), effect)).toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
  });

  it('does not infer a safe edit when the Goal snapshot is unavailable', async () => {
    const h = goalFixture();
    h.getGoal.mockRejectedValueOnce(new Error('HOST_NOT_READY'));
    const effect = vi.fn(async () => 'edited');
    expect(await withToolCallAuthority(h.authorize, edit(), effect)).toMatchObject({ isError: true });
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe('Desktop owner input task actions', () => {
  // Owner requests use the live permission flow once; exercise admission and the
  // downstream queue receipt, not only a mode predicate.
  it.each(['bypassPermissions', 'auto', 'ask', 'default', 'acceptEdits'])(
    'honors the live %s permission flow for helper and Orca without another confirmation', async permissionMode => {
      const h = desktopFixture('private');
      h.activeInput.permission = {
        permissionMode, planModeEnabled: false, isCurrent: () => true,
      };
      for (const [server, tool] of ownerWrites) {
        // Host admission can reuse approval only if the production tool policy
        // actually routes this mutation through the runtime permission flow.
        expect(getDesktopMcpToolApprovalPolicy({ serverName: server, toolName: tool }))
          .toBe('prompt-each-time');
        expect(await withToolCallAuthority(h.authorize, { ...call(tool), server }, async () => {
          expect(hasTaskActionAuthorization('companion')).toBe(true);
          const queued = input();
          bindTaskActionInput('target', queued);
          await taskActionInputGuard('target', queued)!();
          return 'changed';
        })).toBe('changed');
      }
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(['unknown', 'plan', 'active-plan', 'stale', 'shared'])(
    'does not admit a runtime permission decision from %s state', async state => {
      const h = desktopFixture('automatic');
      h.activeInput.permission = {
        permissionMode: ['unknown', 'plan'].includes(state) ? state : 'auto',
        planModeEnabled: state === 'active-plan', isCurrent: () => state !== 'stale',
      };
      if (state === 'shared') h.caller.source = 'shared';
      const effect = vi.fn(async () => 'changed');
      expect(await withToolCallAuthority(h.authorize, call('set_session_runtime'), effect))
        .toMatchObject({ isError: true });
      expect(effect).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(['bypassPermissions', 'auto', 'ask'])(
    'revokes the %s admission before execution but keeps its queued message when live permissions change', async permissionMode => {
      const h = desktopFixture('private');
      let current = true;
      h.activeInput.permission = {
        permissionMode, planModeEnabled: false, isCurrent: () => current,
      };
      const queued = input();
      const decision = await h.authorize(call('set_session_runtime'));
      const syncGuard = await withToolCallAuthority(h.authorize, call('send_to_session'), async () => {
        bindTaskActionInput('target', queued);
        return captureTaskActionSyncGuard()!;
      });
      if (!decision.ok || !decision.run || typeof syncGuard !== 'function') throw new Error('Missing admission');
      current = false;
      const effect = vi.fn(async () => 'changed');
      await expect(decision.run(effect)).rejects.toThrow('AUTHORIZATION_EXPIRED');
      await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
      expect(() => syncGuard()).toThrow('AUTHORIZATION_EXPIRED');
      expect(effect).not.toHaveBeenCalled();
    },
  );

  // #6399, unit: the action-set loop cannot detect a missing tool. Invoke the
  // registered DirectToolSink handler: an automatic focus request must not reach
  // the Host callback that persists focus/resumes an idle Worker; owner input can.
  it('guards switch_focus through the registered Orca entry without adding an owner confirmation', async () => {
    const h = desktopFixture('automatic');
    const switchFocus = vi.fn(async () => ({ ok: true as const, workerId: 'worker' }));
    const unused = async (): Promise<never> => { throw new Error('Unexpected Orca operation'); };
    const server = createOrcaMcpServer(
      {
        authorizeCall: h.authorize, switchFocus,
        startTeam: unused, createWorker: unused, listWorkers: unused,
        sendToWorker: unused, interruptWorker: unused, listWorkerQueuedMessages: unused,
        updateWorkerQueuedMessage: unused, cancelWorkerQueuedMessage: unused,
        mergeWorkerQueuedMessages: unused, steerWorkerQueuedMessage: unused,
        moveWorkerQueuedMessage: unused, idleWorker: unused, endTeam: unused,
        archiveWorker: unused, updateWorker: unused, listAvailableModels: unused,
        getWorkspaceInfo: unused,
        getWorkerStatus: unused, readWorker: unused,
      },
      { sessionId: 'companion', agentKind: 'codex', workingDir: '/tmp/test' },
    );
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler(args: unknown): Promise<unknown> }>;
    })._registeredTools.switch_focus.handler;
    try {
      expect(await handler({ worker_id_or_label: 'worker' })).toMatchObject({ isError: true });
      expect(switchFocus).not.toHaveBeenCalled();
      h.activeInput.key = 'explicit-owner-request';
      h.activeInput.ownerInput = true;
      h.activeInput.automatic = false;
      expect(await handler({ worker_id_or_label: 'worker' })).not.toMatchObject({ isError: true });
      expect(switchFocus).toHaveBeenCalledExactlyOnceWith({
        leadSessionId: 'companion', workerIdOrLabel: 'worker',
      });
      expect(h.confirm).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  // #6399, unit: an async admission is not a transport preSend generation check.
  it.each(['input', 'account', 'group'] as const)('invalidates a captured synchronous guard on %s replacement', async change => {
    const h = desktopFixture(change === 'group' ? 'group' : 'private');
    let groupCurrent = true;
    if (change === 'group') releases.push(registerGroupToolAuthority('companion', {
      botId: 'bot', mode: 'owner', isCurrent: () => groupCurrent, validate: async () => {},
    }));
    const decision = await h.authorize(call('archive_sessions'));
    if (!decision.ok || !decision.run) throw new Error('Expected owner admission');
    const guard = await decision.run(async () => captureTaskActionSyncGuard()!);
    expect(() => guard()).not.toThrow();
    if (change === 'input') h.activeInput.key = 'replacement';
    if (change === 'account') hostFacts.boundaryPending.mockReturnValue(true);
    if (change === 'group') groupCurrent = false;
    expect(() => guard()).toThrow();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['private', 'group'] as const)(
    'accepts %s owner input without a second confirmation, including downstream authorization',
    async (kind) => {
      const h = desktopFixture(kind);
      const validate = vi.fn(async () => {});
      if (kind === 'group')
        releases.push(
          registerGroupToolAuthority('companion', {
            botId: 'bot',
            mode: 'owner',
            isCurrent: () => true,
            validate,
          }),
        );
      for (const [server, tool] of ownerWrites) {
        const result = await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server },
          async () => {
            expect(hasTaskActionAuthorization('companion')).toBe(true);
            if (tool === 'start_session_task')
              expect(approvedTaskDelegation('companion')).toMatchObject({ version: 1 });
            const queued = input();
            bindTaskActionInput('target', queued);
            await expect(taskActionInputGuard('target', queued)!()).resolves.toBeUndefined();
            return 'accepted';
          },
        );
        expect(result).toBe('accepted');
      }
      expect(h.confirm).not.toHaveBeenCalled();
      expect(hasTaskActionAuthorization('companion')).toBe(false);
      if (kind === 'group') expect(validate).toHaveBeenCalled();
    },
  );

  it.each(['chat', 'tools', 'missing', 'stale', 'other-bot', 'unavailable', 'revoked'] as const)(
    'rejects %s group authority before helper or Orca effects, without prompting',
    async (mode) => {
      const h = desktopFixture();
      h.activeInput.permission = {
        permissionMode: 'bypassPermissions', planModeEnabled: false, isCurrent: () => true,
      };
      if (mode !== 'missing')
        releases.push(
          registerGroupToolAuthority('companion', {
            botId: mode === 'other-bot' ? 'another' : 'bot',
            mode: mode === 'chat' || mode === 'tools' ? mode : 'owner',
            isCurrent: () => mode !== 'stale',
            validate: async () => {
              if (mode === 'unavailable') throw new GroupToolAuthorizationError(true);
              if (mode === 'revoked') throw new GroupToolAuthorizationError();
            },
          }),
        );
      const effect = vi.fn(async () => 'changed');
      for (const [server, tool] of ownerWrites)
        expect(
          await withToolCallAuthority(h.authorize, { ...call(tool), server }, effect),
        ).toMatchObject({ isError: true });
      expect(effect).not.toHaveBeenCalled();
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  it('keeps automatic/forwarded input restricted even with an unrelated live group owner grant', async () => {
    const h = desktopFixture('automatic');
    releases.push(
      registerGroupToolAuthority('another-lane', {
        botId: 'bot',
        mode: 'owner',
        isCurrent: () => true,
        validate: async () => {},
      }),
    );
    const effect = vi.fn(async () => 'changed');
    for (const [server, tool] of ownerWrites)
      expect(
        await withToolCallAuthority(h.authorize, { ...call(tool), server }, effect),
      ).toMatchObject({ isError: true });
    expect(
      await withToolCallAuthority(h.authorize, call('get_task_digest'), async () => 'observed'),
    ).toBe('observed');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('rechecks owner authority before execution and queued delivery without another confirmation', async () => {
    const h = desktopFixture();
    let live = true;
    releases.push(
      registerGroupToolAuthority('companion', {
        botId: 'bot',
        mode: 'owner',
        isCurrent: () => live,
        validate: async () => {},
      }),
    );
    const queued = input();
    await withToolCallAuthority(h.authorize, call('send_to_session'), async () =>
      bindTaskActionInput('target', queued),
    );
    const decision = await h.authorize(call('start_session_task'));
    if (!decision.ok || !decision.run) throw new Error('missing owner admission');
    live = false;
    const effect = vi.fn(async () => 'started');
    await expect(decision.run(effect)).rejects.toThrow();
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

// Review regressions: caller identity must not erase scoped delegation or mint it.
// Existing owner-input cases did not exercise automatic continuations. Unit tier.
describe('Existing execution authority', () => {
  // Regression: delegation onAccepted must use the Host delivery scope after
  // source-input rollover. Prior queue-binding tests did not capture this guard.
  // Minimum: one owner-admitted call + new input key; unit, no real account/IO.
  it.each(['source-only', 'cleared', 'deleted', 'bot-paused', 'archived'] as const)
  ('retains delivery scope across source-input rollover while rejecting %s revocation', async changed => {
    const h = desktopFixture('private');
    const decision = await h.authorize(call('message_session_task'));
    if (!decision.ok || !decision.run) throw new Error('missing admission');
    const guards = await decision.run(async () => ({
      mutation: captureTaskActionGuard()!, delivery: captureTaskActionDeliveryGuard()!,
    }));
    h.activeInput.key = 'next-owner-input';
    await expect(guards.mutation()).rejects.toThrow('AUTHORIZATION_EXPIRED');
    if (changed === 'cleared') Object.assign(h.caller, { clearedAt: 1 });
    if (changed === 'deleted') h.caller.status = 'deleted';
    if (changed === 'bot-paused') h.caller.botStatus = 'paused';
    if (changed === 'archived') Object.assign(h.caller, { archivedAt: 1 });
    if (changed === 'source-only') await expect(guards.delivery()).resolves.toBeUndefined();
    else await expect(guards.delivery()).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('keeps delegated work independent of follow-up enablement, but respects pause/revocation', async () => {
    const h = desktopFixture('automatic');
    const grant = {
      taskActionAuthority: { version: 1, actions: ['message_session_task', 'stop_session_task'] },
    };
    h.rows.delegation = {
      status: 'running',
      runSequence: 1,
      permissionSnapshotJson: JSON.stringify(grant),
    };
    for (const tool of ['message_session_task', 'stop_session_task']) {
      expect(await withToolCallAuthority(h.authorize, call(tool), async () => 'continued')).toBe(
        'continued',
      );
    }
    const queued = input();
    await withToolCallAuthority(h.authorize, call('message_session_task'), async () =>
      bindTaskActionInput('target', queued),
    );
    const pauseCall = { ...call('stop_session_task'), args: { task_id: 'task', mode: 'pause' } };
    const pauseDecision = await h.authorize(pauseCall);
    if (!pauseDecision.ok || !pauseDecision.run) throw new Error('Expected pause admission');
    const completingPause = await pauseDecision.run(async () => captureTaskActionGuard()!);
    h.rows.delegation.permissionSnapshotJson = JSON.stringify({
      ...grant,
      taskPause: { reason: 'owner' },
    });
    expect(await h.authorize(call('message_session_task'))).toMatchObject({ ok: false });
    expect(await h.authorize(pauseCall)).toMatchObject({ ok: false });
    await expect(completingPause()).resolves.toBeUndefined();
    h.rows.delegation = { ...h.rows.delegation, runSequence: 2 };
    await expect(completingPause()).rejects.toThrow('AUTHORIZATION_EXPIRED');
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow(
      'AUTHORIZATION_EXPIRED',
    );
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('continues an ordinary Lead on a verified Worker report only within its active team', async () => {
    const h = desktopFixture('automatic');
    h.caller.botId = null;
    h.caller.source = 'desktop';
    h.activeInput.orcaSenderSessionId = 'worker-session';
    h.rows.team = { id: 'owned-active-team' };
    for (const tool of ['create_worker', 'send_to_worker', 'switch_focus', 'end_team']) {
      expect(
        await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server: 'cindy_orca' },
          async () => 'continued',
        ),
      ).toBe('continued');
    }
    expect(await h.authorize(call('send_to_session'))).toMatchObject({ ok: false });
    const decision = await h.authorize({ ...call('send_to_worker'), server: 'cindy_orca' });
    h.rows.team = null; // closed team or a sender not in this Lead's active team
    if (!decision.ok || !decision.run) throw new Error('missing scoped admission');
    const write = vi.fn(async () => 'changed');
    await expect(decision.run(write)).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(await h.authorize({ ...call('create_worker'), server: 'cindy_orca' })).toMatchObject({
      ok: false,
    });
    h.rows.team = { id: 'owned-active-team' };
    h.activeInput.orcaSenderSessionId = undefined; // scheduler/forwarded input, not a Worker report
    expect(await h.authorize({ ...call('create_worker'), server: 'cindy_orca' })).toMatchObject({
      ok: false,
    });
    expect(write).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe('teammate turn principal', () => {
  const live = (h: ReturnType<typeof desktopFixture>, permissionMode = 'bypassPermissions') => {
    h.activeInput.permission = { permissionMode, planModeEnabled: false, isCurrent: () => true };
  };
  const helper = (tool: string, args: Record<string, unknown>) => ({
    sessionId: 'companion', server: 'cindy_helper' as const, tool, args,
  });
  const ownerTaskWrites = [
    helper('send_to_session', { target_session_id: 'owner-task', message: 'Add a requirement' }),
    helper('steer_session', { session_id: 'owner-task', message: 'Change course' }),
    helper('stop_session_turn', { session_id: 'owner-task' }),
    helper('set_session_runtime', { session_id: 'owner-task', model: 'other' }),
    helper('start_session_task', { message: 'New work' }),
    helper('archive_sessions', { session_ids: ['owner-task'] }),
    helper('set_workbench_task_responsibility', { task_id: 'owner-task', responsible: true }),
  ];

  // Ordinary actions retain the autonomous principal and use the existing permission mode.
  it.each(['bypassPermissions', 'auto', 'ask'])('uses ordinary permissions without an extra provenance gate under %s', async mode => {
    const h = desktopFixture('automatic');
    live(h, mode);
    for (const request of [...ownerTaskWrites, { ...call('create_worker'), server: 'cindy_orca' as const }]) {
      const effect = vi.fn(async () => 'changed');
      const result = await withToolCallAuthority(h.authorize, request, effect);
      expect(result).toBe('changed');
      expect(effect).toHaveBeenCalledTimes(1);
    }
    expect(h.confirm).not.toHaveBeenCalled(); // reversible task controls are ordinary work
  });

  it('keeps the teammate\'s own scope on its own initiative', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const admitted = async (request: ReturnType<typeof helper>) =>
      withToolCallAuthority(h.authorize, request, async () => 'changed');
    expect(await admitted(helper('send_to_agent', { target_id: 'other', message: 'hi' }))).toBe('changed');
    expect(await admitted(helper('continue_workbench_task', { task_id: 'handed', message: 'Carry on' }))).toBe('changed');
    expect(await admitted(helper('set_workbench_task_responsibility', { task_id: 'handed', responsible: false }))).toBe('changed');
    expect(await admitted(helper('set_session_runtime', { model: 'self' }))).toBe('changed');
    expect(await admitted(helper('set_session_runtime', { session_id: 'handed', model: 'next' }))).toBe('changed');
    h.rows.delegation = { status: 'completed', runSequence: 1, permissionSnapshotJson: '{}' };
    expect(await admitted(helper('message_session_task', { task_id: 'own', message: 'Fill the gap' }))).toBe('changed');
    expect(await admitted(helper('message_session_task', { task_id: 'own', answers: { q: 'a' } }))).toBe('changed');
    expect(await admitted(helper('stop_session_task', { task_id: 'own' }))).toBe('changed');
    expect(await admitted(helper('send_to_session', { target_session_id: 'own-child', message: 'Fix it' }))).toBe('changed');
    // Permission decisions and resuming a pause stay with the owner, even on its own task.
    for (const args of [{ task_id: 'own', decision: 'approve' }, { task_id: 'own', mode: 'resume' }])
      expect(await admitted(helper('message_session_task', args))).toBe('changed');
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it('uses normal permissions for Orca writes without a second team allowlist', async () => {
    const h = desktopFixture('automatic');
    live(h);
    h.activeInput.orcaSenderSessionId = 'worker-session';
    h.rows.team = { id: 'team' };
    const orca = (tool: string) => ({ ...call(tool), server: 'cindy_orca' as const });
    expect(await withToolCallAuthority(h.authorize, orca('send_to_worker'), async () => 'changed')).toBe('changed');
    expect(await withToolCallAuthority(h.authorize, orca('start_team'), async () => 'changed')).toBe('changed');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ['routine-user-weekly', true],
    ['routine-builtin-follow-up-bot', false],
    ['routine-builtin-todo-check-bot', false],
  ] as const)('treats routine %s as entrusted=%s', async (scheduleId, entrusted) => {
    const h = desktopFixture('automatic');
    live(h);
    h.runtime.getCurrentTurnOrigin = () => ({ kind: 'scheduler', scheduleId, runId: 'run' });
    const result = await withToolCallAuthority(h.authorize, ownerTaskWrites[0], async () => taskActionPrincipal('companion'));
    expect(result).toBe(entrusted ? 'entrusted' : 'autonomous');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each([true, false])('lets the IM lane requester decide (owner=%s)', async requesterIsOwner => {
    const h = desktopFixture('automatic');
    live(h);
    // A desktop-looking active input cannot override the lane's per-turn requester.
    h.activeInput.ownerInput = !requesterIsOwner;
    releases.push(beginChannelToolScope({
      sessionId: 'companion', sessionInstanceId: 'instance-1',
      scope: { channel: 'wecom', botId: 'bot', laneUserId: 'user', chatId: 'chat', chatKind: 'group', requesterIsOwner, companion: true },
    }));
    const result = await withToolCallAuthority(h.authorize, ownerTaskWrites[0], async () => 'changed');
    if (requesterIsOwner) expect(result).toBe('changed');
    else expect(JSON.stringify(result)).toContain('TASK_ACTION_SOURCE_UNAUTHORIZED');
  });

  // Drafts/non-executing inputs remain ordinary; deletion needs an exact decision.
  it.each(['routine_save', 'routine_run_now', 'routine_delete', 'schedule_set_pre_run_hook'])(
    'keeps draft or non-executing %s payloads ordinary except deletion', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const request = helper(tool, { name: 'r', prompt: 'Message the owner\'s task', enabled: false });
      expect(await withToolCallAuthority(h.authorize, request, async () => 'saved')).toBe('saved');
      expect(h.confirm).toHaveBeenCalledTimes(tool === 'routine_delete' ? 1 : 0);
      h.activeInput.ownerInput = true;
      expect(await withToolCallAuthority(h.authorize, request, async () => 'saved')).toBe('saved');
      expect(await withToolCallAuthority(h.authorize, helper('routine_list', {}), async () => 'listed')).toBe('listed');
    },
  );

  // Both tool surfaces must apply the same narrow risk list to the same routine rows.
  it.each(['schedule_update', 'schedule_delete', 'schedule_run_now', 'schedule_set_pre_run_hook',
    'schedule_pause', 'schedule_resume', 'schedule_create', 'routine_save', 'routine_run_now', 'routine_delete'])(
    'uses the same risk policy for cindy_scheduler %s', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool,
        args: { id: 'routine-owner-weekly', scheduleId: 'routine-owner-weekly', prompt: 'Merge everything', bindToCurrentSession: true } };
      expect(await withToolCallAuthority(h.authorize, request, async () => 'changed')).toBe('changed');
      expect(h.confirm).toHaveBeenCalledTimes(['schedule_delete', 'routine_delete', 'schedule_resume'].includes(tool) ? 1 : 0);
      h.activeInput.ownerInput = true;
      expect(await withToolCallAuthority(h.authorize, request, async () => 'changed')).toBe('changed');
    },
  );

  // An owner's off switch for memory or a system Skill must not be undone by a Host-started turn.
  it('asks the owner before an automatic turn turns a feature back on', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const set = (tool: string, args: Record<string, unknown>) =>
      withToolCallAuthority(h.authorize, helper(tool, args), async () => 'changed');
    expect(await set('set_teammate_capability', { kind: 'feature', id: 'todo', joined: false })).toBe('changed');
    expect(await set('set_teammate_capability', { kind: 'skill', id: 'notes', joined: true })).toBe('changed');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(await set('set_bot_capability', { kind: 'feature', id: 'todo', joined: true })).toBe('changed');
    expect(h.confirm).toHaveBeenCalledTimes(1);
    h.confirm.mockResolvedValueOnce(false);
    expect(JSON.stringify(await set('set_teammate_capability', { kind: 'feature', id: 'memory', joined: true }))).toContain('USER_CANCELLED');
    h.activeInput.ownerInput = true;
    expect(await set('set_teammate_capability', { kind: 'feature', id: 'todo', joined: true })).toBe('changed');
    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it('uses ordinary task permission for remote create on a non-teammate task', async () => {
    const h = desktopFixture('automatic');
    live(h);
    h.caller.botId = null;
    h.caller.source = 'desktop';
    h.activeInput.automatic = true;
    h.activeInput.ownerInput = false;
    h.activeInput.ownerContinuation = false;
    const remoteCreate = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_create',
      args: { device: 'spark', name: 'radar', prompt: 'scan', cronExpr: '0 9 * * 1-5', timezone: 'Asia/Shanghai', recurring: true, agentKind: 'pi', notify: { desktop: true, feishu: false } } };
    const effect = vi.fn(async () => 'created');
    expect(await withToolCallAuthority(h.authorize, remoteCreate, effect)).toBe('created');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('uses the existing execution-risk confirmation for autonomous remote create', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const remoteCreate = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_create',
      args: { device: 'spark', name: 'radar', prompt: 'scan', cronExpr: '0 9 * * 1-5', timezone: 'Asia/Shanghai', recurring: true, agentKind: 'pi', notify: { desktop: true, feishu: false } } };
    const effect = vi.fn(async () => 'created');
    expect(await withToolCallAuthority(h.authorize, remoteCreate, effect)).toBe('created');
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it.each(['schedule_list', 'schedule_get', 'schedule_list_runs', 'schedule_notify_current_run', 'routine_list'])(
    'keeps cindy_scheduler %s available on its own initiative', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool, args: {} };
      expect(await withToolCallAuthority(h.authorize, request, async () => 'read')).toBe('read');
    },
  );

  // 2026-10-29: a missing owner marker must not silently deny ordinary work.
  // Risk decisions are visible, single-use, and invalidated by a new input.
  // Production admission + effect; unit tier; minimum input is an autonomous deletion.
  it('waits for the exact decision, executes once, and rejects a second consumption', async () => {
    const h = desktopFixture('automatic');
    live(h);
    let decide!: (value: boolean) => void;
    h.confirm.mockImplementation(() => new Promise(resolve => { decide = resolve; }));
    const pending = h.authorize(helper('routine_delete', { id: 'test-routine' }));
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.confirm).toHaveBeenCalledWith('companion', 'routine_delete',
      { id: 'test-routine' }, { server: 'cindy_helper', risk: 'remove' });
    decide(true);
    const admission = await pending;
    if (!admission.ok || !admission.run) throw new Error('missing admission');
    const effect = vi.fn(async () => 'deleted');
    expect(await admission.run(effect)).toBe('deleted');
    await expect(admission.run(effect)).rejects.toThrow('AUTHORIZATION_EXPIRED');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  // Security review r4409127909: trusted local scheduler commands bypass the
  // harness approval policy. Production admission must wait before persistence/fire.
  // Unit tier; a script schedule is the minimum failing input.
  it.each(['schedule_create', 'schedule_update', 'schedule_run_now'])(
    'waits for an exact decision before autonomous %s can execute shell commands', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const definition = { id: 'script', name: 'Command check', prompt: '', useWorktree: false, executionMode: 'script' as const,
        workingDir: '/tmp/check', scriptConfig: { command: 'printf reviewed', capabilities: [] } };
      h.schedules.set('script', definition);
      const args = tool === 'schedule_run_now' ? { id: 'script' } : definition;
      const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool, args };
      h.confirm.mockResolvedValue(false);
      const effect = vi.fn(async () => 'executed');
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, effect))).toContain('USER_CANCELLED');
      expect(effect).not.toHaveBeenCalled();
      expect(h.confirm).toHaveBeenCalledWith('companion', tool, args,
        expect.objectContaining({ server: 'cindy_scheduler', risk: 'command' }));
      h.confirm.mockResolvedValue(true);
      expect(await withToolCallAuthority(h.authorize, request, effect)).toBe('executed');
      expect(effect).toHaveBeenCalledTimes(1);
      if (tool !== 'schedule_create') expect(h.confirm).toHaveBeenLastCalledWith('companion', tool, args,
        expect.objectContaining({ details: { schedule: definition } }));
      h.activeInput.ownerInput = true;
      h.confirm.mockClear();
      expect(await withToolCallAuthority(h.authorize, request, effect)).toBe('executed');
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  // r4409452538: standalone Agent schedules default to Full Access in the runner.
  // Existing shell-command cases miss an agent prompt creating a more privileged session.
  // Unit: production admission + effects, default agent mode is the minimum failing input.
  it.each(['create', 'detach', 'run-now', 'persistent'] as const)(
    'requires the exact command-capable decision for autonomous Agent schedule %s', async variant => {
      const h = desktopFixture('automatic');
      live(h);
      const definition = { id: 'agent', name: 'Agent work', useWorktree: false, prompt: 'Run the saved work',
        workingDir: '/work', executionMode: 'agent' as const,
        ...(variant === 'detach' ? { targetSessionId: 'companion' } : {}) };
      h.schedules.set('agent', definition);
      const tool = variant === 'run-now' ? 'schedule_run_now' : variant === 'detach' ? 'schedule_update' : 'schedule_create';
      const args = variant === 'run-now' ? { id: 'agent', bindToCurrentSession: true } : variant === 'detach'
        ? { id: 'agent', targetSessionId: null } : { prompt: definition.prompt, workingDir: '/work',
          ...(variant === 'persistent' ? { bindToCurrentSession: true, persistentSession: true } : {}) };
      const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool, args };
      const effect = vi.fn(async () => 'started');
      h.confirm.mockResolvedValue(false);
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, effect))).toContain('USER_CANCELLED');
      expect(effect).not.toHaveBeenCalled();
      expect(h.confirm).toHaveBeenCalledWith('companion', tool, args,
        expect.objectContaining({ risk: 'command', details: expect.objectContaining({
          execution: { mode: 'agent', newTaskPermissionMode: 'bypassPermissions' },
        }) }));
      h.confirm.mockResolvedValue(true);
      expect(await withToolCallAuthority(h.authorize, request, effect)).toBe('started');
      expect(effect).toHaveBeenCalledTimes(1);
      h.confirm.mockClear();
      h.activeInput.ownerInput = true;
      expect(await withToolCallAuthority(h.authorize, request, effect)).toBe('started');
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  // #7912: the ordinary cross-device route remains available, but a remote
  // schedule that starts an independent Full Access Agent is the same command
  // risk as the local route and must show the same visible decision.
  it('applies the command decision to remote independent Agent schedules without blacklisting ordinary edits', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const definition = { id: 'remote-agent', name: 'Remote agent', useWorktree: false,
      prompt: 'Run the saved work', executionMode: 'agent' as const, workingDir: '/remote/work' };
    h.schedules.set(definition.id, definition);
    const effect = vi.fn(async () => 'started');
    const runRequest = { sessionId: 'companion', server: 'cindy_scheduler' as const,
      tool: 'schedule_run_now', args: { id: definition.id, device: 'remote-mac' } };
    h.confirm.mockResolvedValue(false);
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, runRequest, effect))).toContain('USER_CANCELLED');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', runRequest.tool, runRequest.args,
      expect.objectContaining({ risk: 'command', details: expect.objectContaining({
        schedule: expect.objectContaining({ id: definition.id, workingDir: '/remote/work' }),
        execution: { mode: 'agent', newTaskPermissionMode: 'bypassPermissions' },
      }) }));

    h.confirm.mockClear();
    const metadataEdit = { sessionId: 'companion', server: 'cindy_scheduler' as const,
      tool: 'schedule_update', args: { id: definition.id, device: 'remote-mac', name: 'Renamed' } };
    expect(await withToolCallAuthority(h.authorize, metadataEdit, effect)).toBe('started');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('fails closed when the remote schedule definition cannot be read', async () => {
    const h = desktopFixture('automatic');
    live(h);
    h.getScheduleDefinition.mockRejectedValueOnce(new Error('SCHEDULE_DEFINITION_UNAVAILABLE'));
    const effect = vi.fn(async () => 'started');
    const request = { sessionId: 'companion', server: 'cindy_scheduler' as const,
      tool: 'schedule_run_now', args: { id: 'remote-agent', device: 'remote-mac' } };
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, effect))).toContain('CAPABILITY_NOT_AVAILABLE');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  // r4409663577: helper create starts Full Access without a directory override.
  // Unit, real admission/effect: ordinary task sends must not mint silent authority.
  it('confirms a new Full Access handoff without changing existing sends or inherited-permission creates', async () => {
    const h = desktopFixture('automatic');
    live(h, 'auto');
    const request = helper('send_to_session', { message: 'Only reply to the test' });
    const create = vi.fn(async () => 'created');
    h.confirm.mockResolvedValue(false);
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, create))).toContain('USER_CANCELLED');
    expect(create).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      { server: 'cindy_helper', risk: 'command', details: { execution: {
        mode: 'agent', newTaskPermissionMode: 'bypassPermissions', workingDir: '/companion',
      } } });
    h.confirm.mockResolvedValue(true);
    expect(await withToolCallAuthority(h.authorize, request, create)).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    h.confirm.mockClear();
    for (const args of [{ target_session_id: 'existing', message: 'Reply' },
      { working_dir: '/other', message: 'Reply' }])
      expect(await withToolCallAuthority(h.authorize, helper('send_to_session', args), create)).toBe('created');
    expect(h.confirm).not.toHaveBeenCalled();
    h.activeInput.ownerInput = true;
    expect(await withToolCallAuthority(h.authorize, request, create)).toBe('created');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  // r4409987073: turning off isolation changes where a Full Access Agent writes.
  // Unit, production admission: deny that change and expire a previously reviewed run.
  it('confirms changed worktree isolation and expires a run when isolation changes', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const definition = { id: 'agent', name: 'Isolated', prompt: 'Owner work',
      executionMode: 'agent' as const, workingDir: '/work', useWorktree: true };
    h.schedules.set('agent', definition);
    const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_update',
      args: { id: 'agent', useWorktree: false } };
    const effect = vi.fn(async () => 'changed');
    h.confirm.mockResolvedValue(false);
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, effect))).toContain('USER_CANCELLED');
    expect(effect).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      expect.objectContaining({ risk: 'command', details: expect.objectContaining({
        schedule: expect.objectContaining({ useWorktree: true }),
      }) }));
    h.confirm.mockImplementation(async () => { definition.useWorktree = false; return true; });
    expect(JSON.stringify(await withToolCallAuthority(h.authorize,
      { ...request, tool: 'schedule_run_now', args: { id: 'agent' } }, effect))).toContain('AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  // r4409828449: resume previously displayed only an ID, not the saved command.
  // Unit, production admission/effect: show the definition and reject replacement.
  it('shows and binds the saved script before resuming a paused schedule', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const definition = { id: 'paused', name: 'Paused command', useWorktree: false, prompt: '', executionMode: 'script' as const,
      workingDir: '/work', scriptConfig: { command: 'printf reviewed', capabilities: [] } };
    h.schedules.set('paused', definition);
    const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_resume', args: { id: 'paused' } };
    const resume = vi.fn(async () => 'resumed');
    h.confirm.mockImplementation(async () => { definition.scriptConfig.command = 'printf replacement'; return true; });
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, resume))).toContain('AUTHORIZATION_EXPIRED');
    expect(resume).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      { server: 'cindy_scheduler', risk: 'command', details: { schedule: expect.objectContaining({
        workingDir: '/work', scriptConfig: { command: 'printf reviewed', capabilities: [] },
      }) } });
    h.confirm.mockResolvedValue(true);
    expect(await withToolCallAuthority(h.authorize, request, resume)).toBe('resumed');
    expect(resume).toHaveBeenCalledTimes(1);
  });

  // r4409808139: the runner inherits the bound session's current hook directory.
  // Unit, production admission: changing that effective directory invalidates approval.
  it('binds manual hook execution to its resolved directory', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const definition = { id: 'bound', name: 'Bound hook', useWorktree: false, prompt: 'Owner work', executionMode: 'agent' as const,
      targetSessionId: 'existing', workingDir: '/stale', preRunWorkingDir: '/actual',
      preRunHook: { command: 'node relative.mjs' } };
    h.schedules.set('bound', definition);
    h.confirm.mockImplementation(async () => { definition.preRunWorkingDir = '/replacement'; return true; });
    const execute = vi.fn(async () => 'executed');
    const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_run_now', args: { id: 'bound' } };
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, execute))).toContain('AUTHORIZATION_EXPIRED');
    expect(execute).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      expect.objectContaining({ details: { schedule: expect.objectContaining({ preRunWorkingDir: '/actual' }) } }));
  });

  it('keeps an approved independent Agent schedule metadata edit ordinary', async () => {
    const h = desktopFixture('automatic');
    live(h);
    h.schedules.set('agent', { id: 'agent', name: 'Agent work', useWorktree: false, prompt: 'Saved owner instruction',
      executionMode: 'agent', workingDir: '/work' });
    const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_update',
      args: { id: 'agent', name: 'Renamed', cronExpr: '0 9 * * *' } };
    expect(await withToolCallAuthority(h.authorize, request, async () => 'saved')).toBe('saved');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['script', 'agent'] as const)('expires a %s command decision when the saved schedule changes', async mode => {
    const h = desktopFixture('automatic');
    live(h);
    h.schedules.set('script', { id: 'script', name: 'Command check', prompt: '', useWorktree: false, executionMode: mode,
      ...(mode === 'script' ? { scriptConfig: { command: 'printf reviewed', capabilities: [] } } : { prompt: 'Reviewed prompt' }) });
    h.confirm.mockImplementation(async () => {
      if (mode === 'script') h.schedules.get('script')!.scriptConfig!.command = 'printf replacement';
      else h.schedules.get('script')!.prompt = 'Replacement prompt';
      return true;
    });
    const effect = vi.fn(async () => 'executed');
    expect(JSON.stringify(await withToolCallAuthority(h.authorize,
      { sessionId: 'companion', server: 'cindy_scheduler', tool: 'schedule_run_now', args: { id: 'script' } },
      effect))).toContain('AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  it('recognizes raw pre-run hooks without prompting for ordinary prompt schedules', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const call = (tool: string, args: Record<string, unknown>) => withToolCallAuthority(h.authorize,
      { sessionId: 'companion', server: 'cindy_scheduler', tool, args }, async () => 'done');
    await call('schedule_create', { prompt: 'Check progress', preRunHook: { command: 'node check.mjs' } });
    await call('schedule_set_pre_run_hook', { script: 'process.exit(2)' });
    expect(h.confirm).toHaveBeenCalledTimes(2);
    h.confirm.mockClear();
    await call('schedule_create', { prompt: 'Remind me tomorrow', bindToCurrentSession: true });
    h.schedules.set('prompt', { id: 'prompt', name: 'Reminder', useWorktree: false, prompt: 'Remind me tomorrow', executionMode: 'agent', targetSessionId: 'companion' });
    await call('schedule_update', { id: 'prompt', name: 'Updated reminder' });
    await call('schedule_run_now', { id: 'prompt' });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  // r4409346213: the helper forwards to the same installing/self-testing handler.
  // Unit tier: a valid helper script must wait before any installer effect.
  it('requires the same command decision for the helper hook installer', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const request = helper('schedule_set_pre_run_hook', { script: 'process.exit(2)' });
    const install = vi.fn(async () => 'installed');
    h.confirm.mockResolvedValue(false);
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, install))).toContain('USER_CANCELLED');
    expect(install).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      { server: 'cindy_helper', risk: 'command', details: { installation: { workingDir: '/companion' } } });
    h.confirm.mockResolvedValue(true);
    expect(await withToolCallAuthority(h.authorize, request, install)).toBe('installed');
    expect(install).toHaveBeenCalledTimes(1);
    h.confirm.mockClear();
    h.activeInput.ownerInput = true;
    expect(await withToolCallAuthority(h.authorize, request, install)).toBe('installed');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  // r4409429594: installer inherits mutable target state after its card.
  // Unit: production admission must show the target and reject a changed directory/path.
  it('binds the scheduler hook installer decision to its actual schedule target', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const target = { id: 'bound', name: 'Bound check', useWorktree: false, prompt: 'Bound owner instruction', executionMode: 'agent' as const,
      targetSessionId: 'child', workingDir: '/schedule', preRunHook: { command: 'node old.mjs' },
      hookInstallation: { workingDir: '/session', fallbackDir: '/fallback' } };
    h.schedules.set('bound', target);
    const request = { ...helper('schedule_set_pre_run_hook', { scheduleId: 'bound', script: 'process.exit(2)' }), server: 'cindy_scheduler' as const };
    const install = vi.fn(async () => 'installed');
    h.confirm.mockImplementation(async () => {
      target.hookInstallation.workingDir = '/replacement';
      target.preRunHook.command = 'node replacement.mjs';
      return true;
    });
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, install)))
      .toContain('AUTHORIZATION_EXPIRED');
    expect(install).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      expect.objectContaining({ details: { schedule: expect.objectContaining({
        targetSessionId: 'child', preRunHook: { command: 'node old.mjs' },
        hookInstallation: { workingDir: '/session', fallbackDir: '/fallback' },
      }) } }));
    h.confirm.mockResolvedValue(true);
    expect(await withToolCallAuthority(h.authorize, request, install)).toBe('installed');
    expect(install).toHaveBeenCalledTimes(1);
  });

  // Helper deliberately accepts no scheduleId/workingDir: its actual target is the caller workspace.
  it('binds the helper installation directory without granting a schedule target', async () => {
    const h = desktopFixture('automatic');
    live(h);
    const request = helper('schedule_set_pre_run_hook', { script: 'process.exit(2)' });
    const install = vi.fn(async () => 'installed');
    h.confirm.mockImplementation(async () => {
      h.workDirs.set('companion', '/replacement');
      return true;
    });
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, install)))
      .toContain('AUTHORIZATION_EXPIRED');
    expect(install).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
      { server: 'cindy_helper', risk: 'command', details: { installation: { workingDir: '/companion' } } });
    h.confirm.mockResolvedValue(true);
    expect(await withToolCallAuthority(h.authorize, request, install)).toBe('installed');
    expect(install).toHaveBeenCalledTimes(1);
  });

  // r4409429587: ID-only manual execution runs the saved shell hook, not just a prompt.
  // Existing save tests did not cover an enabled rule's command. Unit, real admission/effect.
  it.each(['cindy_helper', 'cindy_scheduler'] as const)(
    'shows and confirms the saved routine command before %s manual execution', async server => {
      const h = desktopFixture('automatic');
      live(h);
      h.routines.set('command', { enabled: true, revision: 3, prompt: 'Reviewed instructions', preRunCommand: 'node check.mjs' });
      h.workDirs.set('routine-command', '/reviewed');
      const request = { ...helper('routine_run_now', { botId: 'bot', id: 'command' }), server };
      const execute = vi.fn(async () => taskActionRoutineRevision('bot', 'command'));
      h.confirm.mockResolvedValue(false);
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, execute))).toContain('USER_CANCELLED');
      expect(execute).not.toHaveBeenCalled();
      expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args,
        expect.objectContaining({ risk: 'command', details: { routine: expect.objectContaining({
          id: 'command', preRunCommand: 'node check.mjs', revision: 3,
        }), execution: { targetSessionId: 'routine-command', workingDir: '/reviewed' } } }));
      // r4412911528: rule revision is unchanged but the reused lane moves.
      h.confirm.mockImplementation(async () => { h.workDirs.set('routine-command', '/replacement'); return true; });
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, execute))).toContain('AUTHORIZATION_EXPIRED');
      expect(execute).not.toHaveBeenCalled();
      h.confirm.mockResolvedValue(true);
      expect(await withToolCallAuthority(h.authorize, request, execute)).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(h.confirm).toHaveBeenLastCalledWith('companion', request.tool, request.args,
        expect.objectContaining({ details: expect.objectContaining({ execution: {
          targetSessionId: 'routine-command', workingDir: '/replacement',
        } }) }));
    },
  );

  // Security r4409367066: saving instructions must not manufacture a standing
  // owner grant for the next routine turn. Unit, production admission + effect.
  it.each(['cindy_helper', 'cindy_scheduler'] as const)(
    'requires an owner decision to mint or rewrite active routine instructions through %s', async server => {
      const h = desktopFixture('automatic');
      live(h);
      const call = (args: Record<string, unknown>, effect = vi.fn(async () => 'saved')) =>
        withToolCallAuthority(h.authorize, { ...helper('routine_save', args), server }, effect);
      h.confirm.mockResolvedValue(false);
      const create = vi.fn(async () => 'saved');
      expect(JSON.stringify(await call({ botId: 'bot', prompt: 'Run my new instructions', enabled: true }, create)))
        .toContain('USER_CANCELLED');
      expect(create).not.toHaveBeenCalled();
      expect(h.confirm).toHaveBeenCalledWith('companion', 'routine_save', expect.anything(),
        { server, risk: 'authority' });
      h.confirm.mockClear();
      h.routines.set('standing', { enabled: true, revision: 1, prompt: 'Owner standing instructions' });
      expect(await call({ botId: 'bot', id: 'standing', enabled: true, prompt: 'Owner standing instructions', name: 'Renamed' }))
        .toBe('saved');
      expect(await call({ botId: 'bot', enabled: false, prompt: 'Unapproved draft' })).toBe('saved');
      expect(h.confirm).not.toHaveBeenCalled();
      const rewrite = vi.fn(async () => 'saved');
      expect(JSON.stringify(await call({ botId: 'bot', id: 'standing', enabled: true, prompt: 'Replacement instructions' }, rewrite)))
        .toContain('USER_CANCELLED');
      expect(rewrite).not.toHaveBeenCalled();
      h.confirm.mockResolvedValue(true);
      expect(await call({ botId: 'bot', prompt: 'Reviewed standing instructions', enabled: true })).toBe('saved');
      h.confirm.mockClear();
      h.activeInput.ownerInput = true;
      expect(await call({ botId: 'bot', prompt: 'Owner explicit instructions', enabled: true })).toBe('saved');
      expect(h.confirm).not.toHaveBeenCalled();
    },
  );

  it.each(['cindy_helper', 'cindy_scheduler'] as const)(
    'does not turn a disabled draft into an entrusted run through %s without approval', async server => {
      const h = desktopFixture('automatic');
      live(h);
      h.routines.set('draft', { enabled: false, revision: 2, prompt: 'Unapproved instructions' });
      const request = { ...helper('routine_run_now', { botId: 'bot', id: 'draft' }), server };
      const enqueue = vi.fn(async () => taskActionRoutineRevision('bot', 'draft'));
      h.confirm.mockResolvedValue(false);
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, enqueue))).toContain('USER_CANCELLED');
      expect(enqueue).not.toHaveBeenCalled();
      expect(h.confirm).toHaveBeenCalledWith('companion', 'routine_run_now', request.args,
        expect.objectContaining({ server, risk: 'resume' }));
      h.confirm.mockResolvedValue(true);
      expect(await withToolCallAuthority(h.authorize, request, enqueue)).toBe(2);
      expect(enqueue).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['cindy_helper', 'cindy_scheduler'] as const)('requires a command decision only for a changed routine hook through %s', async server => {
    const h = desktopFixture('automatic');
    live(h);
    h.routines.set('standing', { enabled: true, revision: 1, prompt: 'Owner instructions', preRunCommand: 'node owner.mjs' });
    const hook = { command: 'node owner.mjs' };
    const request = { ...helper('routine_save', { botId: 'bot', id: 'standing', enabled: true,
      prompt: 'Owner instructions', preRunHook: hook }), server };
    const effect = vi.fn(async () => 'saved');
    expect(await withToolCallAuthority(h.authorize, request, effect)).toBe('saved');
    expect(h.confirm).not.toHaveBeenCalled();
    hook.command = 'node replacement.mjs';
    h.confirm.mockResolvedValue(false);
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, effect))).toContain('USER_CANCELLED');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(h.confirm).toHaveBeenCalledWith('companion', request.tool, request.args, { server, risk: 'command' });
  });

  // Review #7782: approval must describe and bind the child's exact request, not
  // whichever request is current after the parent card is answered. Unit tier.
  it.each(['request-id', 'arguments'] as const)('expires a permission answer when child %s changes', async change => {
    const h = desktopFixture('automatic');
    live(h);
    h.confirm.mockImplementation(async () => {
      if (change === 'request-id') h.permissionRequest.requestId = 'permission-2';
      else h.permissionRequest.input.command = 'echo replacement';
      return true;
    });
    const effect = vi.fn(async () => 'approved');
    const result = await withToolCallAuthority(h.authorize,
      helper('message_session_task', { task_id: 'own', decision: 'approve' }), effect);
    expect(h.confirm).toHaveBeenCalledWith('companion', 'message_session_task',
      { task_id: 'own', decision: 'approve' }, expect.objectContaining({ risk: 'permission', details: {
        task: { id: 'own', title: 'Child task' },
        request: { requestId: 'permission-1', kind: 'permission', toolName: 'bash', input: { command: 'echo reviewed' } },
      } }));
    expect(JSON.stringify(result)).toContain('AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  // Same save API on helper and scheduler: only an existing disabled->enabled
  // transition is a resume; ordinary creation/editing remains unchanged.
  // r4410276099: omitted hook parameters retain the saved command, which must be shown.
  it.each(['cindy_helper', 'cindy_scheduler'] as const)('asks for routine restoration through %s', async server => {
    const h = desktopFixture('automatic');
    live(h);
    h.routines.set('saved', { enabled: false, revision: 3, preRunCommand: 'node saved-check.mjs' });
    const request = { ...helper('routine_save', { botId: 'bot', id: 'saved', enabled: true }), server };
    expect(await withToolCallAuthority(h.authorize, request,
      async () => taskActionRoutineRevision('bot', 'saved'))).toBe(3);
    expect(h.confirm).toHaveBeenCalledWith('companion', 'routine_save', request.args,
      { server, risk: 'resume', details: { routine: { id: 'saved', enabled: false, revision: 3,
        preRunCommand: 'node saved-check.mjs' } } });
    h.confirm.mockClear();
    h.routines.set('saved', { enabled: true, revision: 4 });
    expect(await withToolCallAuthority(h.authorize, request, async () => 'edited')).toBe('edited');
    expect(await withToolCallAuthority(h.authorize,
      { ...request, args: { botId: 'bot', enabled: true } }, async () => 'created')).toBe('created');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it.each(['routine_save', 'routine_run_now'])('does not execute %s after its routine changes during confirmation', async tool => {
    const h = desktopFixture('automatic');
    live(h);
    h.routines.set('saved', { enabled: false, revision: 1 });
    h.confirm.mockImplementation(async () => {
      h.routines.set('saved', { enabled: false, revision: 2 });
      return true;
    });
    const effect = vi.fn(async () => 'enabled');
    const result = await withToolCallAuthority(h.authorize,
      helper(tool, { id: 'saved', enabled: true }), effect);
    expect(JSON.stringify(result)).toContain('AUTHORIZATION_EXPIRED');
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(['deny', 'input-changed', 'permission-changed'] as const)(
    'does not execute after confirmation %s', async change => {
      const h = desktopFixture('automatic');
      live(h);
      h.confirm.mockImplementation(async () => {
        if (change === 'input-changed') h.activeInput.key = 'new-input';
        if (change === 'permission-changed') h.activeInput.permission!.isCurrent = () => false;
        return change !== 'deny';
      });
      const effect = vi.fn(async () => 'deleted');
      const result = await withToolCallAuthority(h.authorize,
        helper('routine_delete', { id: 'test-routine' }), effect);
      expect(JSON.stringify(result)).toContain(change === 'deny' ? 'USER_CANCELLED' : 'AUTHORIZATION_EXPIRED');
      expect(effect).not.toHaveBeenCalled();
    });

  it('keeps the owner principal through an automatic resume of the owner\'s input', async () => {
    const h = desktopFixture('automatic');
    live(h);
    h.activeInput.ownerContinuation = true;
    expect(await withToolCallAuthority(h.authorize, ownerTaskWrites[0], async () => 'changed')).toBe('changed');
  });
});

// A bare allow must not reuse an outer action's authority, even through the
// in-process MCP path. Existing Desktop fixtures called the gate at top level.
// Production Desktop admission + guards; unit tier, in-memory Host facts.
describe('independent Desktop tool invocation', () => {
  it('rechecks an ordinary call without inheriting stale authorization or forcing its queue', async () => {
    const outer = fixture(true);
    const h = desktopFixture('private');
    h.caller.botId = null;
    h.caller.source = 'desktop';
    await withToolCallAuthority(outer.authorize, call('start_session_task'), async () => {
      outer.revoke();
      const result = await withToolCallAuthority(h.authorize, {
        ...call('send_to_session'), sessionId: 'ordinary-task',
      }, async () => {
        await assertTaskActionCurrent();
        expect(hasTaskActionAuthorization()).toBe(false);
        expect(approvedTaskDelegation('companion')).toBeUndefined();
        return 'sent';
      });
      expect(result).toBe('sent');
      // Isolation must not clear the outer scope or its revocation checks.
      await expect(assertTaskActionCurrent()).rejects.toThrow('revoked');
    });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('keeps concurrent admitted callers separate across awaits', async () => {
    const h = desktopFixture('private');
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    await Promise.all(['first-task', 'second-task'].map((sessionId) =>
      withToolCallAuthority(h.authorize, { ...call('send_to_session'), sessionId }, async () => {
        if (++entered === 2) release();
        await bothEntered;
        await assertTaskActionCurrent();
        expect(hasTaskActionAuthorization(sessionId)).toBe(true);
        expect(hasTaskActionAuthorization(sessionId === 'first-task' ? 'second-task' : 'first-task')).toBe(false);
      }),
    ));
    expect(entered).toBe(2);
    expect(hasTaskActionAuthorization()).toBe(false);
  });

  it('does not use a valid outer grant to bypass rejection of the current caller', async () => {
    const outer = fixture(true);
    const h = desktopFixture('automatic');
    const effect = vi.fn(async () => 'sent');
    await withToolCallAuthority(outer.authorize, call('start_session_task'), async () => {
      const result = await withToolCallAuthority(h.authorize, call('send_to_session'), effect);
      expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_REQUIRED');
      expect(effect).not.toHaveBeenCalled();
      expect(approvedTaskDelegation('companion')).toBeDefined();
    });
  });
});
