/**
 * Value: production tool admission + queued dispatch guards, no real account or network.
 * Regression: task actions added owner consent checks after the normal runtime permission flow;
 * 2026-10-29: missing owner provenance silently rejected routine_save and task creation.
 * Rule: teammate-authority.md — separate source identity, account access and explicit operation risks.
 * Gap: workbench tests cover visibility; SDK approval tests cannot prove Host consent.
 * Minimum input: non-owner provenance + runtime change; live execution modes do not review twice.
 * Tier: unit. This file isolates the process-local authorization lifetime from SQLite/IPC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoReviewDecision, PermissionMode, SendOrigin } from '@cindy/maker-core';
import { getDesktopMcpToolApprovalPolicy } from '../../maker-host/mcp-tool-approval-policy.js';
import { withToolCallAuthority } from '../../../../../../packages/lizi-mcps/src/tool-call-authority.js';
import { createOrcaMcpServer } from '../../../../../../packages/lizi-mcps/src/orca/server.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  assertTaskActionCurrent,
  bindTaskActionInput,
  createTaskActionAuthorizer,
  taskActionInputGuard,
  hasTaskActionAuthorization,
  TASK_ACTION_TOOLS,
  ORCA_TASK_ACTION_TOOLS,
  captureTaskActionSyncGuard,
  captureTaskActionGuard,
  captureTaskActionDeliveryGuard,
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
const call = (tool = 'steer_session') => ({
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
    for (const tool of ['get_task_digest', 'schedule_notify_current_run']) {
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

  it('reuses an already confirmed scope without another confirmation', async () => {
    const h = fixture(false, true);
    expect(
      await withToolCallAuthority(
        h.authorize,
        call('send_to_session'),
        async () => 'continued',
      ),
    ).toBe('continued');
    expect(h.confirm).not.toHaveBeenCalled();
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

  // 2026-11-08: a restored local teammate message is an ordinary task message; only rows that
  // needed a live grant (remote senders, admitted actions) are held without their guard.
  it('holds restored remote queue rows, but delivers local teammate and ordinary user rows', async () => {
    expect(taskActionInputGuard('target', input())).toBeUndefined();
    const remote = { ...input(), origin: { ...input().origin!, senderSessionId: 'mac::companion' } } as AgentInputQueuedMessage;
    await expect(taskActionInputGuard('target', remote)!()).rejects.toThrow('AUTHORIZATION_REQUIRED');
    expect(taskActionInputGuard('target', { ...input(), origin: undefined })).toBeUndefined();
  });
});

// Regression #6399: the pure scope fixture above cannot detect a second confirmation
// added to the owner's ordinary tool flow.
// Exercise the Desktop adapter + shared helper/Orca entry.
// SQLite/account IO is replaced with in-memory facts (unit tier).
const hostFacts = vi.hoisted(() => ({ getDb: vi.fn(), boundaryPending: vi.fn() }));
vi.mock('../../localDb/client/current.js', () => ({ tryGetDbClient: hostFacts.getDb }));
vi.mock('../../appSessionState.js', () => ({
  isAppSessionBoundaryPending: hostFacts.boundaryPending,
}));
import { orcaTeams } from '../../localDb/schema.js';
import { createDesktopTaskActionAuthorizer } from '../taskActionHost.js';
import { beginChannelToolScope } from '../../im/shared/channelToolScope.js';

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
            table === orcaTeams
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
    ownerInput: kind === 'private',
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
  const authorize = createDesktopTaskActionAuthorizer({
    input: () => ({ ...activeInput }), confirm, getSession,
  });
  return { authorize, confirm, activeInput, caller, rows, runtime, getSession };
}
const ownerWrites = [
  ['cindy_helper', 'send_to_session'],
  ['cindy_helper', 'set_session_runtime'],
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
  it.each(['input', 'account'] as const)('invalidates a captured synchronous guard on %s replacement', async change => {
    const h = desktopFixture('private');
    const decision = await h.authorize(call('archive_sessions'));
    if (!decision.ok || !decision.run) throw new Error('Expected owner admission');
    const guard = await decision.run(async () => captureTaskActionSyncGuard()!);
    expect(() => guard()).not.toThrow();
    if (change === 'input') h.activeInput.key = 'replacement';
    if (change === 'account') hostFacts.boundaryPending.mockReturnValue(true);
    expect(() => guard()).toThrow();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it(
    'accepts private owner input without a second confirmation, including downstream authorization',
    async () => {
      const h = desktopFixture('private');
      for (const [server, tool] of ownerWrites) {
        const result = await withToolCallAuthority(
          h.authorize,
          { ...call(tool), server },
          async () => {
            expect(hasTaskActionAuthorization('companion')).toBe(true);
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
    },
  );

  it('keeps automatic/forwarded input without a live permission flow restricted', async () => {
    const h = desktopFixture('automatic');
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
});

// Review regressions: caller identity must not erase an admitted scope.
// Existing owner-input cases did not exercise automatic continuations. Unit tier.
describe('Existing execution authority', () => {
  // Regression: a queued input's onAccepted must use the Host delivery scope after
  // source-input rollover. Prior queue-binding tests did not capture this guard.
  // Minimum: one owner-admitted call + new input key; unit, no real account/IO.
  it.each(['source-only', 'cleared', 'deleted', 'bot-paused', 'archived'] as const)
  ('retains delivery scope across source-input rollover while rejecting %s revocation', async changed => {
    const h = desktopFixture('private');
    const decision = await h.authorize(call('send_to_session'));
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
    helper('send_to_session', { message: 'New work' }),
    helper('archive_sessions', { session_ids: ['owner-task'] }),
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

  // 2026-11-08: any task can already open a Full Access task with send_to_session, so a
  // teammate turn gets no extra speaker check or risk card. The 2026-11-07 test build showed
  // these gates refusing an owner-requested teammate hand-off. Unit, in-memory IO.
  it('admits former teammate-only risks and non-owner IM speakers under ordinary permissions', async () => {
    const h = desktopFixture('automatic');
    live(h, 'auto');
    releases.push(beginChannelToolScope({
      sessionId: 'companion', sessionInstanceId: 'instance-1',
      scope: { channel: 'wecom', botId: 'bot', laneUserId: 'user', chatId: 'chat', chatKind: 'group', requesterIsOwner: false, companion: true },
    }));
    for (const request of [
      ownerTaskWrites[0],
      helper('send_to_session', { message: 'Start a Full Access task' }),
      { sessionId: 'companion', server: 'cindy_scheduler' as const, tool: 'schedule_resume', args: { id: 'paused' } },
    ]) expect(await withToolCallAuthority(h.authorize, request, async () => 'changed')).toBe('changed');
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe('independent Desktop tool invocation', () => {
  it('rechecks an ordinary call without inheriting stale authorization or forcing its queue', async () => {
    const outer = fixture(true);
    const h = desktopFixture('private');
    h.caller.botId = null;
    h.caller.source = 'desktop';
    await withToolCallAuthority(outer.authorize, call('archive_sessions'), async () => {
      outer.revoke();
      const result = await withToolCallAuthority(h.authorize, {
        ...call('send_to_session'), sessionId: 'ordinary-task',
      }, async () => {
        await assertTaskActionCurrent();
        expect(hasTaskActionAuthorization()).toBe(false);
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
    await withToolCallAuthority(outer.authorize, call('archive_sessions'), async () => {
      const result = await withToolCallAuthority(h.authorize, call('send_to_session'), effect);
      expect(JSON.stringify(result)).toContain('TASK_ACTION_AUTHORIZATION_REQUIRED');
      expect(effect).not.toHaveBeenCalled();
      expect(hasTaskActionAuthorization('companion')).toBe(true);
    });
  });
});
