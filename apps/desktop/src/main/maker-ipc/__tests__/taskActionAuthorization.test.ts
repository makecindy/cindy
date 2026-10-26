/**
 * Value: production tool admission + queued dispatch guards, no real account or network.
 * Regression: task actions added owner consent checks after the normal runtime permission flow;
 * later (#6699) any live mode admitted a teammate's own wake-ups as if the owner had asked.
 * Rule: teammate-authority.md — the Host decides the turn's principal before the permission mode.
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
  approvedTaskDelegation,
  assertTaskActionCurrent,
  bindTaskActionInput,
  createTaskActionAuthorizer,
  taskActionInputGuard,
  hasTaskActionAuthorization,
  TASK_ACTION_TOOLS,
  ORCA_TASK_ACTION_TOOLS,
  captureTaskActionSyncGuard,
  captureTaskActionGuard,
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
                : [caller],
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
    ownerContinuation: false,
    automatic: kind !== 'private',
    boundary: 'runtime-1',
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
  const entrusted = vi.fn(async () => false);
  const authorize = createDesktopTaskActionAuthorizer({
    input: () => ({ ...activeInput }), confirm, getSession, isEntrustedTask: entrusted,
  });
  return { authorize, confirm, activeInput, caller, rows, runtime, getSession, entrusted };
}
const ownerWrites = [
  ['cindy_helper', 'start_session_task'],
  ['cindy_helper', 'send_to_session'],
  ['cindy_helper', 'continue_workbench_task'],
  ['cindy_helper', 'set_workbench_task_responsibility'],
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

  it.each(['permission', 'plan', 'instance', 'account', 'input'] as const)('invalidates admission and delayed delivery after %s changes', async changed => {
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
    if (changed === 'account') hostFacts.boundaryPending.mockReturnValue(true);
    if (changed === 'input') h.activeInput.boundary = 'replacement-runtime';
    expect(() => guard()).toThrow('AUTHORIZATION_EXPIRED');
    await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow('AUTHORIZATION_EXPIRED');
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
    'revokes the %s admission before execution and delayed delivery when live permissions change', async permissionMode => {
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
      await expect(taskActionInputGuard('target', queued)!()).rejects.toThrow('AUTHORIZATION_EXPIRED');
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

  // The 2026-10-22 behavior: Full Access admitted a follow-up wake-up as the owner.
  it.each(['bypassPermissions', 'auto', 'ask'])('rejects an autonomous turn acting on the owner\'s tasks under %s', async mode => {
    const h = desktopFixture('automatic');
    live(h, mode);
    for (const request of [...ownerTaskWrites, { ...call('create_worker'), server: 'cindy_orca' as const }]) {
      const effect = vi.fn(async () => 'changed');
      const result = await withToolCallAuthority(h.authorize, request, effect);
      expect(JSON.stringify(result)).toContain('NEEDS_OWNER_REQUEST');
      expect(effect).not.toHaveBeenCalled();
    }
    expect(h.confirm).not.toHaveBeenCalled();
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
    h.entrusted.mockResolvedValue(true);
    expect(await admitted(helper('set_session_runtime', { session_id: 'handed', model: 'next' }))).toBe('changed');
    expect(h.entrusted).toHaveBeenCalledWith('companion', 'handed');
    h.rows.delegation = { status: 'completed', runSequence: 1, permissionSnapshotJson: '{}' };
    expect(await admitted(helper('message_session_task', { task_id: 'own', message: 'Fill the gap' }))).toBe('changed');
    expect(await admitted(helper('message_session_task', { task_id: 'own', answers: { q: 'a' } }))).toBe('changed');
    expect(await admitted(helper('stop_session_task', { task_id: 'own' }))).toBe('changed');
    expect(await admitted(helper('send_to_session', { target_session_id: 'own-child', message: 'Fix it' }))).toBe('changed');
    // Permission decisions and resuming a pause stay with the owner, even on its own task.
    for (const args of [{ task_id: 'own', decision: 'approve' }, { task_id: 'own', mode: 'resume' }])
      expect(JSON.stringify(await admitted(helper('message_session_task', args)))).toContain('NEEDS_OWNER_REQUEST');
  });

  it('continues its own Orca team from a Worker report, but cannot start a team', async () => {
    const h = desktopFixture('automatic');
    live(h);
    h.activeInput.orcaSenderSessionId = 'worker-session';
    h.rows.team = { id: 'team' };
    const orca = (tool: string) => ({ ...call(tool), server: 'cindy_orca' as const });
    expect(await withToolCallAuthority(h.authorize, orca('send_to_worker'), async () => 'changed')).toBe('changed');
    expect(JSON.stringify(await withToolCallAuthority(h.authorize, orca('start_team'), async () => 'changed')))
      .toContain('NEEDS_OWNER_REQUEST');
  });

  it.each([
    ['routine-user-weekly', true],
    ['routine-builtin-follow-up-bot', false],
    ['routine-builtin-todo-check-bot', false],
  ] as const)('treats routine %s as entrusted=%s', async (scheduleId, entrusted) => {
    const h = desktopFixture('automatic');
    live(h);
    h.runtime.getCurrentTurnOrigin = () => ({ kind: 'scheduler', scheduleId, runId: 'run' });
    const result = await withToolCallAuthority(h.authorize, ownerTaskWrites[0], async () => 'changed');
    if (entrusted) expect(result).toBe('changed');
    else expect(JSON.stringify(result)).toContain('NEEDS_OWNER_REQUEST');
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
    else expect(JSON.stringify(result)).toContain('NEEDS_OWNER_REQUEST');
  });

  // A teammate must not create or fire an owner routine on its own: the next run would be
  // entrusted, turning its own initiative into a standing grant.
  it.each(['routine_save', 'routine_run_now', 'routine_delete', 'schedule_set_pre_run_hook'])(
    'reserves %s for owner or entrusted turns', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const request = helper(tool, { name: 'r', prompt: 'Message the owner\'s task', enabled: true });
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, async () => 'saved')))
        .toContain('NEEDS_OWNER_REQUEST');
      h.activeInput.ownerInput = true;
      expect(await withToolCallAuthority(h.authorize, request, async () => 'saved')).toBe('saved');
      expect(await withToolCallAuthority(h.authorize, helper('routine_list', {}), async () => 'listed')).toBe('listed');
    },
  );

  // PR #6936 review: the scheduler surface addresses the same routine rows (and any schedule)
  // by id. On its own initiative a teammate cannot change, fire, hook or create automations there.
  it.each(['schedule_update', 'schedule_delete', 'schedule_run_now', 'schedule_set_pre_run_hook',
    'schedule_pause', 'schedule_resume', 'schedule_create', 'routine_save', 'routine_run_now', 'routine_delete'])(
    'reserves cindy_scheduler %s for owner or entrusted turns', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool,
        args: { id: 'routine-owner-weekly', scheduleId: 'routine-owner-weekly', prompt: 'Merge everything' } };
      expect(JSON.stringify(await withToolCallAuthority(h.authorize, request, async () => 'changed')))
        .toContain('NEEDS_OWNER_REQUEST');
      h.activeInput.ownerInput = true;
      expect(await withToolCallAuthority(h.authorize, request, async () => 'changed')).toBe('changed');
    },
  );

  it.each(['schedule_list', 'schedule_get', 'schedule_list_runs', 'schedule_notify_current_run', 'routine_list'])(
    'keeps cindy_scheduler %s available on its own initiative', async tool => {
      const h = desktopFixture('automatic');
      live(h);
      const request = { sessionId: 'companion', server: 'cindy_scheduler' as const, tool, args: {} };
      expect(await withToolCallAuthority(h.authorize, request, async () => 'read')).toBe('read');
    },
  );

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
      expect(JSON.stringify(result)).toContain('NEEDS_OWNER_REQUEST');
      expect(effect).not.toHaveBeenCalled();
      expect(approvedTaskDelegation('companion')).toBeDefined();
    });
  });
});
