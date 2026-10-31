import { isShadowedCompanionSession } from '../botSessionInputGuard.js';
import { createScheduledModelScope } from '../scheduledModelSelection.js';
import { assertTaskActionCurrent, hasTaskActionAuthorization } from '../taskActionAuthorization.js';
/**
 * #5788:插件 errand 派活走 sendToSessionInternal 的 lazy-resume 时,必须按会话落库的
 * 权限档恢复,不能落到 main 侧通路的缺省 bypass。否则插件任务被提权,errand 复用判定也会
 * 因活跃会话的档位(bypass)≠ 任务设置的档位而每轮失败、另开新会话。
 *
 * 这项决定由宿主显式传入的策略参数承载;`sourcePlugin` 只是来源标签,不能当权限判据
 * (docs/product-rules/message-source.md)。
 *
 * 伙伴后台任务同理(docs/product-rules/cindy-bots-runtime.md:后台任务继承发起时实际生效的
 * 权限档):它的会话按发起时的档位与 Plan 落库,冷启动同样不能退回 bypass。本文件属 guard
 * tier:派发逻辑在 register.ts 的单个闭包里,没有可单独调用的生产入口;权限回归的失效后果
 * 是后台任务被静默提权到 Full access。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

import { describe, expect, it, vi } from 'vitest';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION, TurnDispatchRejectedError, type SendOptions } from '@cindy/maker-core';
import { restoreAutoReviewUserIntent } from '../autoReviewUserIntent.js';
import { verifiedOwnerRequestText } from '../../../shared/forwardedRequest.js';
import { createWireNoteMemory } from '../wireNoteMemory.js';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function lazyResumeCreateOpts(): string {
  const start = registerSource.indexOf('async function sendToSessionInternal(params: {');
  const resume = registerSource.indexOf("lockStage = 'lazy-resume-bootstrap';", start);
  const end = registerSource.indexOf('await synthesizeOrcaVendorOptionsFromDb(targetSessionId, createOpts);', resume);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(resume).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(resume);
  return registerSource.slice(resume, end);
}

describe('sendToSessionInternal lazy-resume permission mode', () => {
  it('restores the stored permission mode when the host asks for it', () => {
    expect(lazyResumeCreateOpts()).toContain(
      `permissionMode: params.resumeWithStoredPermissionMode
            ? permissionModeOrAsk(dbRow.permissionMode)
            : 'bypassPermissions',`,
    );
  });

  it('does not derive the permission decision from the source label', () => {
    const opts = lazyResumeCreateOpts();
    expect(opts).not.toMatch(/^\s*permissionMode: 'bypassPermissions',$/m);
    expect(opts).not.toMatch(/permissionMode:[^\n]*sourcePlugin/);
  });

  it('has the Ghost errand dispatch request the stored permission mode', () => {
    const runner = registerSource.indexOf('createGhostErrandRunner({');
    const dispatch = registerSource.indexOf('dispatch: async ({ targetSessionId, message, ghostId }) => {', runner);
    const call = registerSource.indexOf('const r = await sendToSessionInternal({', dispatch);
    const close = registerSource.indexOf('});', call);
    expect(runner).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThan(runner);
    expect(call).toBeGreaterThan(dispatch);
    expect(registerSource.slice(call, close)).toContain('resumeWithStoredPermissionMode: true,');
  });

  it('reads the persisted permission mode in the row snapshot used by lazy resume', () => {
    const sessionsSource = readFileSync(resolve(__dirname, '..', '..', 'localDb', 'ipc', 'sessions.ts'), 'utf8');
    const select = sessionsSource.slice(sessionsSource.indexOf('async function selectSessionRowSnapshot('));
    expect(select.slice(0, select.indexOf('.from(sessions)'))).toContain('permissionMode: sessions.permissionMode,');
  });

  it('refreshes permissionMode from DB before a queued follow-up starts the harness', () => {
    const start = registerSource.indexOf('async function reconcileCreateOptsAgainstDb(');
    const end = registerSource.indexOf('const agentSwitchDeps:', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const reconcile = registerSource.slice(start, end);
    expect(reconcile).toContain('permissionMode: sessions.permissionMode,');
    expect(reconcile).toContain('co.permissionMode = permissionModeOrAsk(row.permissionMode);');
  });
});

/**
 * 伙伴后台任务冷启动的行为回归(2026-10-13 真机:按 Auto 委派的任务落库为 Auto,首次派发
 * 经 lazy-resume 被缺省 bypass 启动;绑定它的 PR 心跳每轮都在排队受理时因「落库 ≠ 运行态」
 * 被取消)。截取生产源码原样转译后执行:伙伴后台任务服务的 dispatch 适配器 →
 * dispatchBotSessionMessage → 整个 sendToSessionInternal。闭包外依赖用合成桩注入,未声明的
 * 依赖一被读取就报错,避免桩悄悄改变执行路径。断言 lazy-resume 交给 bootstrapSession(随后
 * 进入 maker.createSession)的创建参数。
 */
function botTaskDispatchSlice(): string {
  const slice = (startMarker: string, endMarker: string, from = 0): string => {
    const start = registerSource.indexOf(startMarker, from);
    expect(start, startMarker).toBeGreaterThanOrEqual(0);
    const end = registerSource.indexOf(endMarker, start);
    expect(end, endMarker).toBeGreaterThan(start);
    return registerSource.slice(start, end);
  };
  const lockReturn = 'return trackSendToSessionLockRun(targetSessionId, run, () => lockStage);';
  const sendToSessionInternal =
    slice('async function sendToSessionInternal(params: {', lockReturn) + `${lockReturn}\n}`;
  const sendWithBaseline = slice('async function sendUserMessageWithAwaitedGitBaseline(', '\n  /**\n   * 来源标签用的发送方身份快照');
  const dispatchBotSessionMessage = slice(
    'const dispatchBotSessionMessage = async (params: {',
    '\n  setBotInvitationWelcomeDispatch(dispatchBotSessionMessage);',
  );
  const delegationDispatch = slice(
    '({ targetSessionId, message, persistedContent, clientId, onAccepted, dispatcherSessionId, autoReviewUserText }) =>',
    ',\n    discardDelegationQueuedInputs:',
    registerSource.indexOf('botDelegationServiceHolder = createBotDelegationService({'),
  );
  return ts.transpileModule(
    `${sendWithBaseline}
${sendToSessionInternal}
${dispatchBotSessionMessage}
const delegationDispatch = ${delegationDispatch};
return { delegationDispatch, dispatchBotSessionMessage, sendToSessionInternal };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
}

// 非严格模式的 with:生产片段里的自由标识符一律从 scope 解析。
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const loadBotTaskDispatch = new Function(
  'scope',
  `with (scope) { return (function () { ${botTaskDispatchSlice()} })(); }`,
) as (scope: object) => {
  sendToSessionInternal: (input: Record<string, unknown>) => Promise<{ ok: boolean; wakeKind?: string }>;
  dispatchBotSessionMessage: (input: Record<string, unknown>) => Promise<{ ok: boolean; wakeKind?: string }>;
  delegationDispatch: (
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; wakeKind?: string }>;
};

function botTaskDispatchHarness(
  rows: Record<string, { permissionMode: string | null; planModeEnabled: boolean }>,
  live: Record<string, object> = {},
  overrides: Record<string, unknown> = {},
) {
  const bootstrapped: Array<Record<string, unknown>> = [];
  const sentTo: Array<{ sessionId: string; planMode: unknown }> = [];
  const sendOptions: SendOptions[] = [];
  const readAutoReviewHistory = vi.fn(async () => [{
    clientId: 'old-owner-input', role: 'user' as const, content: 'You may deploy.',
    agentMeta: { delivery: 'turn', autoReviewUserText: 'You may deploy.' },
  }]);
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  const activity = new Map<string, number>();
  const touchSessionActivityInDb = vi.fn(async (id: string) => { activity.set(id, Date.now()); });
  const sendFor = (session: { id: string }) => async (
    _message: unknown,
    opts: SendOptions & { onAccepted?: () => Promise<void>; onDispatching?: () => void },
  ) => {
    sendOptions.push(opts);
    await opts.onAccepted?.();
    try { opts.onDispatching?.(); } catch (error) {
      if (error instanceof TurnDispatchRejectedError) return { accepted: false, reason: 'provider-rejected-before-dispatch' };
      throw error;
    }
    sentTo.push({ sessionId: session.id, planMode: opts.planMode });
    return { accepted: true };
  };
  for (const [id, session] of Object.entries(live)) {
    if (!('send' in session)) Object.assign(session, { send: sendFor({ id }) });
  }
  const dbChain = {
    from: () => dbChain,
    innerJoin: () => dbChain,
    where: () => dbChain,
    limit: async () => [],
  };
  const stubs: Record<string, unknown> = {
    touchSessionActivityInDb,
    assertCindyMakeSessionAvailable: noop,
    readSessionSource: asyncNoop,
    prepareUpstreamMergeTurn: noop,
    isCindyMakeWorktreePath: () => false,
    app: { getPath: () => '/fixture' },
    agentHandoffPending: { peek: asyncNoop },
    wireNoteMemory: createWireNoteMemory(),
    shouldPrependMobileClientPromptNote: () => false,
    noteChannelTurnSource: () => noop,
    channelTurnSourceFor: noop,
    beginTurnChangeSetAtDispatch: asyncNoop,
    clearPendingTurnChangeSets: noop,
    gitSnapshotCoordinator: null,
    deferredProductTurnFailureGate: { clearSession: noop },
    withCindyMakeProjectUse: (_root: string, _workdir: string, dispatch: () => Promise<unknown>) => dispatch(),
    assertTaskActionCurrent, hasTaskActionAuthorization, TurnDispatchRejectedError,
    AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION,
    restoreAutoReviewUserIntent, readAutoReviewHistory, verifiedOwnerRequestText,
    maker: {
      getSession: (id: string) => live[id],
      getSessionMeta: async (id: string) => ({
        id,
        agentKind: 'claude-code',
        workDir: `/tmp/fixture/${id}`,
        model: 'claude-opus-fixture',
        sdkSessionId: `sdk-${id}`,
      }),
    },
    getSessionRowSnapshot: async (id: string) =>
      rows[id]
        ? { status: 'active', title: id, userSendAt: null, providerId: 'fixture-provider', ...rows[id] }
        : null,
    getDbClient: () => ({ drizzle: { select: () => dbChain } }),
    messages: {},
    sessions: {},
    // 云端伙伴副本门:合成库里没有关联行,目标不是被接管的副本。
    botSessionLinks: {},
    isShadowedCompanionSession: () => false,
    isCompanionShadowed: () => false,
    SHADOWED_COMPANION_INPUT_MESSAGE: 'shadowed',
    and: noop,
    eq: noop,
    log: { info: noop, warn: noop, debug: noop, error: noop },
    createId: () => 'generated-client-id',
    permissionModeOrAsk,
    readSenderIdentity: async () => ({}),
    sessionQueueOriginForDispatcher: noop,
    extractPlainText: (value: unknown) => String(value ?? ''),
    assertReviewExternalInputAllowed: asyncNoop,
    syncBotLanePermission: asyncNoop,
    reconcileBotModelRoute: asyncNoop,
    scheduledModelScope: { restore: asyncNoop },
    refreshBotCapabilityEpochBeforeSend: asyncNoop,
    assertSessionNotRestarting: noop,
    sendToSessionLocks: new Map(),
    waitForSendToSessionLock: async () => undefined,
    trackSendToSessionLockRun: (_id: string, run: Promise<unknown>) => run,
    inputCoordinator: { ensureQueueRestored: asyncNoop, shouldQueueNewTurn: () => false },
    enqueueSendToSessionMessage: vi.fn(asyncNoop),
    BOT_GROUP_CLIENT_ID_PREFIX: 'bot-group:',
    agentSwitchPending: new Map(),
    notifyAgentIslandUserPrompt: noop,
    dispatchAgentIslandUserPrompt: noop,
    commitAgentIslandUserPrompt: noop,
    rollbackAgentIslandUserPrompt: noop,
    createDbMessage: asyncNoop,
    runAcceptedCallback: async (callback?: () => unknown) => {
      await callback?.();
    },
    contextOverflowRolloverHolder: undefined,
    taskCompletionDeliveryForOwner: () => null,
    buildCreateOptsWithStderr: (opts: Record<string, unknown>) => ({ ...opts }),
    synthesizeOrcaVendorOptionsFromDb: asyncNoop,
    readSessionExtraDirsFromDb: async () => [],
    readSessionWritableDirsFromDb: async () => [],
    ensureRemoteReadyForSessionStart: asyncNoop,
    bootstrapSession: async (opts: Record<string, unknown>) => {
      bootstrapped.push(opts);
      return { session: { id: opts.id, agentKind: opts.agentKind, send: sendFor({ id: opts.id as string }) } };
    },
    markOrcaRoleIfNeeded: asyncNoop,
    assertDesktopSendDispatched: noop,
    isSessionRunningError: () => false,
    GroupToolAuthorizationError: class extends Error {},
    AcceptedCallbackDispatchCancelled: class extends Error {},
  };
  Object.assign(stubs, overrides);
  const scope = new Proxy(stubs, {
    // 自己声明的桩优先;JS 内建对象照常解析;其余自由标识符一读就失败。
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key as string];
      throw new ReferenceError(`unstubbed dependency of the production slice: ${String(key)}`);
    },
  });
  return { ...loadBotTaskDispatch(scope), scope: stubs, bootstrapped, sentTo, sendOptions, readAutoReviewHistory, activity, touchSessionActivityInDb };
}

it('advances an accepted send_to_session with a dispatcher without touching human-send time', async () => {
  const row = { permissionMode: 'auto', planModeEnabled: false, userSendAt: 123 };
  const current = botTaskDispatchHarness({ child: row }, { child: { id: 'child', agentKind: 'codex' } });
  const result = await current.sendToSessionInternal({ targetSessionId: 'child', message: 'Take over this work', dispatcherSessionId: 'lead' });
  expect(result).toMatchObject({ ok: true });
  expect(current.activity.get('child')).toBeGreaterThan(123);
  expect(row.userSendAt).toBe(123);
});

// #6895 review: the cloud-room dispatcher bypassed the ordinary send transaction.
// Execute that production closure with the real restore scope (unit behavior in
// this existing guard fixture); assert the route used to send, not call strings.
describe('companion internal delivery after automation', () => {
  // #6895: rejected input must not bootstrap the old primary or consume its restore.
  it.each(['canonical', 'routine'].flatMap(role => ['already-shadowed', 'shadowed-while-waiting'].map(timing => ({ role, timing }))))('preserves $role automation state when $timing', async ({ role, timing }) => {
    let shadowed = timing === 'already-shadowed';
    let baseline: string | null = 'saved-pi-route';
    const restore = vi.fn(async () => { baseline = null; });
    const reconcile = vi.fn(async () => undefined);
    const dbChain = { from: () => dbChain, where: () => dbChain,
      limit: async () => [{ role, botId: 'companion' }] };
    const h = botTaskDispatchHarness({ child: { permissionMode: 'auto', planModeEnabled: false } }, {}, {
      getDbClient: () => ({ drizzle: { select: () => dbChain } }),
      isShadowedCompanionSession, isCompanionShadowed: () => shadowed,
      scheduledModelScope: { restore }, reconcileBotModelRoute: reconcile,
      waitForSendToSessionLock: async () => { shadowed = true; },
    });
    expect(await h.dispatchBotSessionMessage({ targetSessionId: 'child', message: 'Late cloud input' }))
      .toMatchObject({ ok: false, errorCode: 'AGENT_NOT_READY' });
    expect(baseline).toBe('saved-pi-route');
    expect(restore).not.toHaveBeenCalled();
    expect(h.bootstrapped).toEqual([]);
    expect(h.sentTo).toEqual([]);
    if (timing === 'already-shadowed') expect(reconcile).not.toHaveBeenCalled();
  });

  // #6895: hand-over may finish while restore awaits, before a turn exists.
  // Exercise both consumers of the post-restore routing decision, without timers.
  it.each(['canonical', 'routine'].flatMap(role => ['live', 'queued'].map(path => ({ role, path }))))('rejects $role $path delivery when demoted during restoration', async ({ role, path }) => {
    let shadowed = false;
    const dbChain = { from: () => dbChain, where: () => dbChain,
      limit: async () => [{ role, botId: 'companion' }] };
    const enqueue = vi.fn(async () => undefined);
    const h = botTaskDispatchHarness({ child: { permissionMode: 'auto', planModeEnabled: false } }, {
      child: { id: 'child', agentKind: 'pi', isTurnRunning: () => false, getStatus: () => 'active' },
    }, {
      getDbClient: () => ({ drizzle: { select: () => dbChain } }),
      isShadowedCompanionSession, isCompanionShadowed: () => shadowed,
      scheduledModelScope: { restore: async () => { shadowed = true; } },
      inputCoordinator: { ensureQueueRestored: async () => undefined, shouldQueueNewTurn: () => path === 'queued' },
      enqueueSendToSessionMessage: enqueue,
    });
    expect(await h.dispatchBotSessionMessage({ targetSessionId: 'child', message: 'Arrived during hand-over' }))
      .toMatchObject({ ok: false, errorCode: 'AGENT_NOT_READY' });
    expect(h.sentTo).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // #6895 review: the post-restore check precedes asynchronous bootstrap and
  // acceptance. Guard tier: demote at message persistence, then execute the real
  // dispatch callback and prove neither live nor resumed delivery reaches send.
  it.each(['live', 'resumed'] as const)('rejects %s delivery demoted immediately before dispatch', async (path) => {
    let shadowed = false;
    const dbChain = { from: () => dbChain, where: () => dbChain,
      limit: async () => [{ role: 'canonical', botId: 'companion' }] };
    const h = botTaskDispatchHarness({ child: { permissionMode: 'auto', planModeEnabled: false } },
      path === 'live' ? { child: { id: 'child', agentKind: 'pi', isTurnRunning: () => false, getStatus: () => 'active' } } : {}, {
        getDbClient: () => ({ drizzle: { select: () => dbChain } }),
        isShadowedCompanionSession, isCompanionShadowed: () => shadowed,
        createDbMessage: async () => { shadowed = true; },
      });
    expect(await h.dispatchBotSessionMessage({ targetSessionId: 'child', message: 'Late cloud input' }))
      .toMatchObject({ ok: false, errorCode: 'AGENT_NOT_READY', message: 'shadowed' });
    expect(shadowed).toBe(true);
    expect(h.sentTo).toEqual([]);
    expect(h.sendOptions).toHaveLength(1);
    expect(h.bootstrapped).toHaveLength(path === 'resumed' ? 1 : 0);
  });

  it.each(['live', 'resumed'] as const)('restores before %s dispatch reads its model', async (path) => {
    const saved = { agentKind: 'pi' as const, model: 'saved-model', providerId: 'fixture-provider', effort: null, fastMode: false };
    let current = { ...saved, agentKind: 'codex' as 'codex' | 'pi', model: 'temporary-model' };
    let baseline: string | null = JSON.stringify({ ...saved, scopeId: 'automation' });
    const live: Record<string, object> = {};
    let dispatchedModel: string | undefined;
    const makeLive = () => ({ id: 'child', ...current, isTurnRunning: () => false, getStatus: () => 'active',
      send: async () => { dispatchedModel = current.model; return { accepted: true }; } });
    if (path === 'live') live.child = makeLive();
    const scope = createScheduledModelScope({
      createId: () => 'unused', read: async () => ({ profile: current, baseline }),
      write: async (_id, value) => { baseline = value ? JSON.stringify(value) : null; },
      isBusy: () => false,
      apply: async (_id, route) => { current = { ...current, ...route } as typeof current; if (path === 'live') live.child = makeLive(); },
    });
    const h = botTaskDispatchHarness({ child: { permissionMode: 'auto', planModeEnabled: false } }, live, {
      scheduledModelScope: scope,
      maker: { getSession: (id: string) => live[id], getSessionMeta: async () => ({ id: 'child', ...current, workDir: '/tmp/fixture/child' }) },
      bootstrapSession: async (opts: Record<string, unknown>) => ({ session: { id: 'child', model: opts.model,
        send: async () => { dispatchedModel = String(opts.model); return { accepted: true }; } } }),
    });
    const result = await h.dispatchBotSessionMessage({ targetSessionId: 'child', message: 'Next owner message', clientId: 'cloud-room:next' });
    expect(result.ok).toBe(true);
    expect(dispatchedModel).toBe('saved-model');
    expect(baseline).toBeNull();
  });
});

// PR #6514: source receipts must not promote a prior owner's deployment permission.
// Guard: execute the production create closure with separate membership and cwd.
// Both ordinary and managed-worktree tasks must persist the chosen project.
it.each([
  { projectDir: '/selected-project', workingDir: '/tmp/checkout', useWorktree: false },
  { projectDir: '/selected-project', workingDir: '/tmp/checkout', useWorktree: true },
  { projectDir: null, workingDir: '/tmp/checkout', useWorktree: false },
  { projectDir: null, workingDir: '/tmp/checkout', useWorktree: true },
  { projectDir: null, workingDir: undefined, useWorktree: false },
])('preserves resolved membership during creation ($projectDir, cwd=$workingDir, worktree=$useWorktree)', async ({ projectDir, workingDir, useWorktree }) => {
  const executionDir = useWorktree ? '/repo/.cindy-worktrees/child' : workingDir ?? '/managed/dialogues/new-child';
  const workspaceKind = projectDir === null ? 'dialogue' : 'project';
  const row = { id: 'new-child', permissionMode: 'auto', planModeEnabled: false, workingDir: executionDir, workspaceKind };
  const open = vi.fn(async (_input: unknown, create: (row: object, guard: () => Promise<void>) => Promise<unknown>) =>
    ({ row, value: await create(row, async () => {}) }));
  const h = botTaskDispatchHarness({ 'new-child': row }, {}, {
    openSession: open,
    validateHandoffWorkingDir: async (dir: string) => ({ ok: true, dir }),
    broadcastSessionCreated: vi.fn(),
    worktreeManager: {},
    resolveFreshSourceBranch: vi.fn(),
    prepareHandoffWorktree: async () => ({ ok: true, sessionId: 'new-child', meta: { path: executionDir } }),
  });
  const result = await h.sendToSessionInternal({ dispatcherSessionId: 'source', message: 'Work',
    projectDir, workingDir, useWorktree, forceQueue: true });
  expect(result).toMatchObject({ ok: true, projectDir, workingDir: executionDir, workspaceKind });
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({
    projectDir, workingDir: workingDir === undefined ? '' : executionDir, workspaceKind,
  }) }), expect.any(Function));
  expect(h.bootstrapped[0]).toMatchObject({ projectDir, workingDir: executionDir });
});

// Existing cold-start tests omitted the receipt. Execute the actual production dispatch closure
// for both idle branches; guard tier because register.ts has no separately exported entry.
describe('idle forwarded request authorization', () => {
  // 2026-10-27 / unit: a new recipient must accept the same durable provenance as
  // an existing one; direct send previously left its next handoff without a source.
  it('queues the first verified request of a newly created task', async () => {
    const broadcast = vi.fn();
    const row = { id: 'new-child', permissionMode: 'auto', planModeEnabled: false };
    const enqueue = vi.fn(async (input: { onAccepted?: () => Promise<void> }) => { await input.onAccepted?.(); });
    const h = botTaskDispatchHarness({ 'new-child': row }, {}, {
      openSession: async (_input: unknown, create: (row: object, guard: () => Promise<void>) => Promise<unknown>) =>
        ({ row, value: await create(row, async () => {}) }),
      enqueueSendToSessionMessage: enqueue,
      broadcastSessionCreated: broadcast,
    });
    const receipt = { kind: 'agent-request', request: {
      userText: 'Inspect fixtures', sessionId: 'owner', clientId: 'u1', ownerVerified: true } };
    expect(await h.sendToSessionInternal({ message: 'envelope', autoReviewUserText: receipt,
      createDefaults: { agentKind: 'codex', model: 'fixture', workingDir: '/tmp/fixture', permissionMode: 'auto' },
    })).toMatchObject({ ok: true, targetSessionId: 'new-child', wakeKind: 'created' });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'new-child', autoReviewUserText: receipt }));
    expect(h.sendOptions).toHaveLength(0);
    expect(broadcast).toHaveBeenCalledWith('new-child');
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['live', 'agent-request'], ['resumed', 'agent-request'],
    ['live', 'delegated-continuation'], ['resumed', 'delegated-continuation'],
  ] as const)('%s dispatch distinguishes %s from an authorization continuation', async (path, kind) => {
    const live: Record<string, object> = path === 'live' ? { child: {
      id: 'child', agentKind: 'claude-code', remoteHostId: null,
      isTurnRunning: () => false, getStatus: () => 'active',
    } } : {};
    const h = botTaskDispatchHarness({ child: { permissionMode: 'auto', planModeEnabled: false } }, live);
    const result = await h.delegationDispatch({
      targetSessionId: 'child', message: 'Inspect only.', clientId: 'forwarded-inspection',
      autoReviewUserText: { kind, request: { userText: 'Inspect only.', sessionId: 'source', clientId: 'new-owner-input' } },
    });
    expect(result).toMatchObject({ ok: true, wakeKind: path === 'live' ? 'already-active' : 'resumed' });
    expect(h.sendOptions).toHaveLength(1);
    const opts = h.sendOptions[0];
    expect(opts[AUTO_REVIEW_SOURCE_CONTENT]).toBe('');
    if (kind === 'agent-request') {
      expect(opts[AUTO_REVIEW_USER_INTENT]).toBe('');
      expect(opts[AUTO_REVIEW_DELEGATED_CONTINUATION]).toBeUndefined();
      expect(h.readAutoReviewHistory).not.toHaveBeenCalled();
    } else {
      expect(opts[AUTO_REVIEW_USER_INTENT]).toContain('You may deploy.');
      expect(opts[AUTO_REVIEW_DELEGATED_CONTINUATION]).toBe(true);
      expect(h.readAutoReviewHistory).toHaveBeenCalledWith('child');
    }
  });

  // Incident 2026-10-23: the owner's relayed "可以提交 pr" reached the task with an empty
  // review intent. A relay the sending host verified carries exactly the owner's words.
  it.each(['live', 'resumed'] as const)('%s dispatch keeps a verified owner relay on the durable input path', async path => {
    const live: Record<string, object> = path === 'live' ? { child: {
      id: 'child', agentKind: 'claude-code', remoteHostId: null,
      isTurnRunning: () => false, getStatus: () => 'active',
    } } : {};
    const h = botTaskDispatchHarness({ child: { permissionMode: 'auto', planModeEnabled: false } }, live);
    await h.delegationDispatch({
      targetSessionId: 'child', message: 'envelope', clientId: 'verified-relay',
      autoReviewUserText: { kind: 'agent-request', request: {
        userText: 'Submit the PR.', sessionId: 'source', clientId: 'owner-input', ownerVerified: true } },
    });
    expect(h.scope.enqueueSendToSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'child', autoReviewUserText: { kind: 'agent-request', request: {
        userText: 'Submit the PR.', sessionId: 'source', clientId: 'owner-input', ownerVerified: true } },
    }));
    expect(h.sendOptions).toHaveLength(0);
    expect(h.readAutoReviewHistory).not.toHaveBeenCalled();
  });
});

describe('Bot Session task cold start keeps the persisted permission and Plan', () => {
  it.each([
    ['auto', false, 'auto'],
    ['ask', false, 'ask'],
    ['bypassPermissions', false, 'bypassPermissions'],
    ['auto', true, 'auto'],
    [null, false, 'ask'],
  ] as const)(
    'starts a %s task (Plan %s) with that mode instead of Full access',
    async (permissionMode, planModeEnabled, expectedMode) => {
      const h = botTaskDispatchHarness({ child: { permissionMode, planModeEnabled } });
      const onAccepted = vi.fn(async () => undefined);
      const result = await h.delegationDispatch({
        targetSessionId: 'child',
        message: 'Fixture delegated objective',
        clientId: 'bot-delegation-start:fixture',
        onAccepted,
      });
      expect(result).toMatchObject({ ok: true, wakeKind: 'resumed' });
      expect(h.bootstrapped).toHaveLength(1);
      expect(h.bootstrapped[0]).toMatchObject({
        id: 'child',
        permissionMode: expectedMode,
        planMode: planModeEnabled,
      });
      // 这次委派本身是普通执行:显式 planMode:false 不消耗用户保存的 Plan。
      expect(h.sentTo).toEqual([{ sessionId: 'child', planMode: false }]);
      expect(onAccepted).toHaveBeenCalledOnce();
    },
  );

  it('cold-starts the requesting task with its own persisted mode when the result is delivered', async () => {
    const h = botTaskDispatchHarness({ requester: { permissionMode: 'ask', planModeEnabled: false } });
    await h.delegationDispatch({
      targetSessionId: 'requester',
      message: 'Fixture completion notice',
      persistedContent: '[UI_ACTION_TRIGGER]Fixture completion notice',
      clientId: 'bot-delegation-completion:fixture:1',
    });
    expect(h.bootstrapped).toEqual([
      expect.objectContaining({ id: 'requester', permissionMode: 'ask', planMode: false }),
    ]);
  });

  it('sends to an already running task without rebuilding it or touching its permission', async () => {
    const setPermissionMode = vi.fn();
    const setPlanMode = vi.fn();
    const live = {
      id: 'child',
      agentKind: 'claude-code',
      remoteHostId: null,
      isTurnRunning: () => false,
      getStatus: () => 'active',
      setPermissionMode,
      setPlanMode,
    };
    const h = botTaskDispatchHarness(
      { child: { permissionMode: 'auto', planModeEnabled: false } },
      { child: live },
    );
    const result = await h.delegationDispatch({
      targetSessionId: 'child',
      message: 'Fixture interjection',
      clientId: 'bot-delegation-interject:fixture',
    });
    expect(result).toMatchObject({ ok: true, wakeKind: 'already-active' });
    expect(h.bootstrapped).toHaveLength(0);
    expect(h.sentTo).toEqual([{ sessionId: 'child', planMode: false }]);
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(setPlanMode).not.toHaveBeenCalled();
  });
});

/**
 * 排队项的冷启动(发送事务 lazy-create 前的 reconcileCreateOptsAgainstDb):伙伴委派等 Host
 * 输入入队时 createOpts.planMode 恒为 false(那一条消息按普通执行)。排队期间运行实例关闭后,
 * drain 冷启动若照搬它,会话的计划模式就与库内不一致,绑定的心跳又会被判失配。会话起档必须
 * 取库内值;本轮意图由发送事务另按原快照传给 send,不经这里。
 */
describe('queued cold start keeps the persisted Plan', () => {
  const reconcileSource = (() => {
    const start = registerSource.indexOf('async function reconcileCreateOptsAgainstDb(');
    const end = registerSource.indexOf('\n  // 冷 Pi 切模核实前', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return ts.transpileModule(`${registerSource.slice(start, end)}\nreturn reconcileCreateOptsAgainstDb;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
  })();

  function reconcileWithRow(row: Record<string, unknown>) {
    const chain = { from: () => chain, where: () => chain, limit: async () => [row] };
    const stubs: Record<string, unknown> = {
      getDbClient: () => ({ drizzle: { select: () => chain } }),
      sessions: {},
      eq: () => undefined,
      log: { warn: () => undefined, info: () => undefined, debug: () => undefined },
      dbToMakerAgentKind: (kind: string) => (kind === 'cc' ? 'claude-code' : kind),
      permissionModeOrAsk,
    };
    const scope = new Proxy(stubs, {
      has: (target, key) => key in target || !(key in globalThis),
      get: (target, key) => {
        if (key === Symbol.unscopables) return undefined;
        if (key in target) return target[key as string];
        throw new ReferenceError(`unstubbed dependency of the production slice: ${String(key)}`);
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function('scope', `with (scope) { return (function () { ${reconcileSource} })(); }`)(
      scope,
    ) as (sessionId: string, co: Record<string, unknown>) => Promise<void>;
  }

  it.each([true, false])('starts a queued Host input with the stored Plan %s', async (planModeEnabled) => {
    const reconcile = reconcileWithRow({
      agentKind: 'cc',
      model: 'claude-opus-fixture',
      sdkSessionId: 'sdk-child',
      providerId: 'fixture-provider',
      effort: 'high',
      fastMode: false,
      permissionMode: 'auto',
      planModeEnabled,
      agentDeviceId: null,
      remoteHostId: null,
    });
    // 入队时的快照:伙伴委派排队项 planMode=false,权限是旧值。
    const co: Record<string, unknown> = {
      agentKind: 'claude-code',
      permissionMode: 'bypassPermissions',
      planMode: false,
    };
    await reconcile('child', co);
    expect(co).toMatchObject({ permissionMode: 'auto', planMode: planModeEnabled });
  });
});
