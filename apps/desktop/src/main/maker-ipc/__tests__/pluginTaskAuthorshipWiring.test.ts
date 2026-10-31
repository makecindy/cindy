import { bindTaskActionInput } from '../taskActionAuthorization.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { appendAutoReviewUserIntent, AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT, type SendOptions } from '@cindy/maker-core';
import { HOST_ONLY_AGENT_PREFIX, buildMakerUserMessage, sanitizeQueuedMessageForPersistence, type AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import { FORWARDED_REQUEST_RECEIPT } from '../../../shared/forwardedRequest.js';
import { buildPluginMessage } from '../../../shared/pluginMessage.js';
import { redactInputProjectionForSharedGuest } from '../../device-link/sharedTaskMessageOrigin.js';
import { MCP_APP_MESSAGE_GUARD } from '../../mcp-apps/message.js';
import { captureAgentRequest } from '../forwardedRequest.js';
import { restoreAutoReviewUserIntent, type AutoReviewHistoryMessage } from '../autoReviewUserIntent.js';
import { AgentInputCoordinator } from '../agent-input-coordinator.js';
import { createPluginTargetReviewLoader } from '../../cindy-brain/pluginTargetReview.js';
import { createPluginTaskReviewResolver } from '../pluginTaskReviewContext.js';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

// PR #7824 merge regression (guard): run the production target send adapter,
// queue builder/coordinator and review resolver. DB-only tests and a synthetic
// active-input callback missed the real delivery overwriting delegation provenance.
it.each([false, true])('preserves target scope through accepted delivery (delegation=%s)', async delegated => {
  const taskId = 'task', clientId = 'plugin-target:r', text = 'Prepare the report';
  const receipt = { id: clientId, pluginId: 'p', requestKey: 'key', hash: 'hash', status: 'accepted',
    taskId, target: { kind: 'bot', id: 'bot' }, approvalRevision: 'approved',
    ...(delegated ? { delegation: { version: 1, task: 'Write the report in /answer only.' } } : {}) };
  const history: AutoReviewHistoryMessage[] = [{ clientId: 'human', role: 'user', content: 'Do not publish.', createdAt: 1,
    agentMeta: { delivery: 'turn', autoReviewUserText: 'Do not publish.' } }];
  let running = false, delivered!: () => void;
  const accepted = new Promise<void>(resolve => { delivered = resolve; });
  const inputCoordinator = new AgentInputCoordinator({
    sendToAgent: async (_id, _message, _opts, sendOpts) => {
      const persisted = sendOpts.persistUserMessage!;
      history.push({ clientId: persisted.clientId, role: 'user', content: persisted.content, createdAt: 2,
        agentMeta: { delivery: persisted.delivery, sourcePlugin: persisted.sourcePlugin,
          autoReviewUserText: persisted[FORWARDED_REQUEST_RECEIPT] ?? sendOpts[AUTO_REVIEW_SOURCE_CONTENT] } });
      await persisted.onPersisted?.();
      running = true;
      delivered();
      return { kind: 'session-dispatch', source: 'test', dispatched: true };
    },
    steerToAgent: vi.fn(), abortSession: vi.fn(), isTurnRunning: () => running,
    getTurnGeneration: () => 3, hasPendingInteraction: () => false,
    getAgentKind: () => 'codex', getSdkSessionId: async () => 'sdk', emitProjection: vi.fn(),
  });
  const owner = { userId: 'owner', clientEpoch: 1, client: {
    queryOne: async (sql: string) => sql.includes('AS scope') ? { scope: receipt.delegation?.task ?? null } : {
      ...receipt, fingerprint: receipt.hash, payload: JSON.stringify(receipt), revision: 1,
      agentMeta: JSON.stringify(history.at(-1)!.agentMeta), workingDir: '/answer', permissionMode: 'auto',
      planModeEnabled: 0, status: 'active', agentKind: 'codex', providerId: 'p', model: 'm', effort: 'high', fastMode: 0,
    },
    tx: async () => ({ revision: 1, sessionIntent: restoreAutoReviewUserIntent(history), reviewIntent: restoreAutoReviewUserIntent(history) }),
  } };
  const queueStart = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const queueEnd = source.indexOf('  const orcaInterAgentDispatcher:', queueStart);
  const buildQueueItem = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk', 'UI_ACTION_TRIGGER_PREFIX', 'HOST_ONLY_AGENT_PREFIX', 'bindTaskActionInput',
    compile(source.slice(queueStart, queueEnd) + '\nreturn buildSessionControlInputItem;'))(
    async () => ({ agentKind: 'codex', model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' }),
    (mode: string) => mode, '[UI_ACTION_TRIGGER]', HOST_ONLY_AGENT_PREFIX, bindTaskActionInput,
  );
  const sendStart = source.indexOf('    send: async (pluginId, taskId, clientId, text, guard, validateTarget, delivery');
  const sendEnd = source.indexOf('    deliverySettled:', sendStart);
  const sendBindings = {
    getCurrentDbClientSnapshot: () => owner, sanitizeSourceName: (name: string) => name, getInstalledGhostName: () => 'Plugin',
    buildPluginMessage, t: () => 'Plugin context',
    createPluginTargetStore: () => ({ getById: async () => receipt }),
    withPluginMessageAttachments: async (_images: unknown, guard: () => void, run: (files: []) => Promise<unknown>) => { guard(); return run([]); },
    sendToSessionInternal: async (params: { targetSessionId: string; message: string }) => {
      const queued: AgentInputQueuedMessage = await buildQueueItem({ ...params, persistedContent: params.message, meta: {} });
      await inputCoordinator.ensureQueueRestored(params.targetSessionId);
      inputCoordinator.enqueue(params.targetSessionId, JSON.parse(JSON.stringify(queued)));
      return { ok: true };
    },
    awaitAgentInputQueueSnapshotPersistence: vi.fn(),
  };
  const send = new Function(...Object.keys(sendBindings), compile(`return ({${source.slice(sendStart, sendEnd)}}).send;`))(...Object.values(sendBindings));
  const start = source.indexOf('  const loadPluginTargetReview =');
  const endMarker = '  pluginTargetReviewReady = true;';
  const end = source.indexOf(endMarker, start) + endMarker.length;
  let review!: ReturnType<typeof createPluginTaskReviewResolver>;
  const bindings = {
    createPluginTargetReviewLoader, createPluginTaskReviewResolver,
    setAutoReviewContextResolver: (resolver: typeof review) => { review = resolver; },
    getCurrentDbClientSnapshot: () => owner, drainPersistQueue: vi.fn(), assertPluginTargetQueuedDelivery: vi.fn(),
    pluginDelegationAuthorizationRevision: () => 'approved', getPluginTaskDefaults: vi.fn(), inputCoordinator,
    maker: { getSession: () => ({ isTurnRunning: () => running, instanceId: 'instance', getTurnGeneration: () => 3 }) },
  };
  const run = new Function(...Object.keys(bindings), compile(`let pluginTargetReviewReady = false;\n${source.slice(start, end)}\nreturn pluginTargetReviewReady;`));
  expect(run(...Object.values(bindings))).toBe(true);
  await expect(send('p', taskId, clientId, text, vi.fn(), vi.fn(), 'queue', [], { context: 'Untrusted context' })).resolves.toBe('queue');
  await accepted;
  expect(inputCoordinator.isActiveInputAccountScoped(taskId)).toBe(true);
  const userIntent = restoreAutoReviewUserIntent(history);
  const result = await review({ sessionId: taskId, agentKind: 'codex', model: 'm', userIntent,
    workspaceRoots: ['/answer'], platform: 'linux', action: { kind: 'exec', command: 'make report', cwd: '/answer' } });
  expect(result.authorizationError).toBeUndefined();
  if (delegated) {
    expect(result.delegatedTask?.task).toBe(receipt.delegation!.task);
    expect(result.userIntent).toBe('Do not publish.');
  } else {
    expect(result.delegatedTask).toBeUndefined();
    expect(result.userIntent).toEqual({ earlierUserMessages: ['Do not publish.'], currentUserMessage: text });
  }
});

it.each(['Do not publish.', '', undefined])('keeps live authority through the final delegated steer boundary: %j', async previous => {
  const start = source.indexOf('await sess.steer(steerPayload as never, {');
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf('\n      });', start) + '\n      });'.length;
  const deliver = new Function('sess', 'steerPayload', 'so', 'meta', 'restoredSteerIntent',
    'MAIN_OWNED_SEND_CONTEXT', 'AUTO_REVIEW_SOURCE_CONTENT', 'AUTO_REVIEW_USER_INTENT', 'AUTO_REVIEW_DELEGATED_CONTINUATION', 'MCP_APP_MESSAGE_GUARD', 'appContext',
    compile(`return (async () => { ${source.slice(start, end)} })();`));
  const invoke = async (delegated: boolean) => {
    let result;
    const steer = vi.fn(async (content: string, options: SendOptions) => {
      result = appendAutoReviewUserIntent(previous, content, options);
    });
    await deliver({ steer }, 'Publish now', { [AUTO_REVIEW_SOURCE_CONTENT]: '',
      ...(delegated ? { [AUTO_REVIEW_DELEGATED_CONTINUATION]: true } : {}) }, {}, 'Old persisted permission',
      MAIN_OWNED_SEND_CONTEXT, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION, MCP_APP_MESSAGE_GUARD);
    expect(steer).toHaveBeenCalledOnce();
    return result;
  };
  expect(await invoke(true)).toEqual(previous ?? 'Old persisted permission');
  expect(await invoke(false)).toEqual('Old persisted permission');
});

it.each(['context', 'message', 'none'] as const)(
  'revalidates App steer authority after async preparation (%s revocation)',
  async (revocation) => {
    const start = source.indexOf('await sess.steer(steerPayload as never, {');
    const marker = '      appContext?.consume();';
    const end = source.indexOf(marker, start) + marker.length;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const deliver = new Function('sess', 'steerPayload', 'so', 'meta', 'restoredSteerIntent',
      'MAIN_OWNED_SEND_CONTEXT', 'AUTO_REVIEW_SOURCE_CONTENT', 'AUTO_REVIEW_USER_INTENT', 'AUTO_REVIEW_DELEGATED_CONTINUATION', 'MCP_APP_MESSAGE_GUARD', 'appContext',
      compile(`return (async () => { ${source.slice(start, end)} })();`));
    let prepared = false;
    const provider = vi.fn();
    const messageGuard = vi.fn(async () => {
      if (prepared && revocation === 'message') throw new Error('MCP_APP_CARD_UNAVAILABLE');
    });
    const context = {
      text: 'PRIVATE_APP_DRAFT',
      assertCurrent: vi.fn(async () => {
        if (prepared && revocation === 'context') throw new Error('MCP_APP_CARD_UNAVAILABLE');
      }),
      consume: vi.fn(),
    };
    const steer = vi.fn(async (_content: unknown, opts: { beforeProviderStart?: () => Promise<void> }) => {
      await Promise.resolve();
      prepared = true;
      await opts.beforeProviderStart?.();
      provider();
    });
    const pending = deliver({ steer }, 'Continue', { [MCP_APP_MESSAGE_GUARD]: messageGuard }, {}, '',
      MAIN_OWNED_SEND_CONTEXT, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION, MCP_APP_MESSAGE_GUARD, context);
    if (revocation === 'none') {
      await pending;
      expect(provider).toHaveBeenCalledOnce();
      expect(context.consume).toHaveBeenCalledOnce();
      expect(context.assertCurrent).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
      expect(provider).not.toHaveBeenCalled();
      expect(context.consume).not.toHaveBeenCalled();
    }
    expect(messageGuard).toHaveBeenCalledOnce();
  },
);

it('restores human authorization for both live and cold internal delegated sends', () => {
  for(const target of ['live','session']) {
    const start=source.lastIndexOf(`sendUserMessageWithAwaitedGitBaseline(${target}, message, clientId, {`);
    expect(start).toBeGreaterThan(0);
    const options=source.slice(start,source.indexOf('onAccepted: persistUserMessage',start));
    expect(options).toContain('params.autoReviewUserText');
    expect(options).toContain('[AUTO_REVIEW_SOURCE_CONTENT]:');
    expect(options).toContain('restoreAutoReviewUserIntent(await readAutoReviewHistory(targetSessionId))');
  }
});

it('uses accepted plugin task text for Auto review and preserves it through queue fallbacks', () => {
  const start = source.indexOf('async function sendToSessionInternal(params: {');
  const end = source.indexOf('const startOrcaTeamForCaller', start);
  const dispatch = source.slice(start, end);
  const pluginStart = source.indexOf('      dispatch: async (pluginId, taskId, clientId, text');
  expect(pluginStart).toBeGreaterThan(0);
  const pluginDispatch = source.slice(pluginStart, source.indexOf('      inspect:', pluginStart));
  // Context may decorate the model message; the reviewed task instruction is the plugin's text.
  expect(pluginDispatch).toContain('autoReviewUserText: text, forceQueue: true');
  const queues = [...dispatch.matchAll(/await enqueueSendToSessionMessage\(\{([\s\S]*?)\}\);/g)];
  // Verified create handoffs add a fifth durable entry; all must retain provenance.
  expect(queues).toHaveLength(5);
  for (const call of queues) {
    expect(call[1]).toContain('autoReviewUserText: params.autoReviewUserText');
    // 插件来源随每个入队回退分支传递(含 queued-before-dispatch 竞态),排队项不丢插件身份。
    expect(call[1]).toMatch(/\bsourcePlugin\b/);
  }
  // Both newly created and resumed direct tasks persist the same authored metadata.
  expect(dispatch.match(/agentMeta: inputAgentMeta/g)).toHaveLength(2);
});

it('keeps empty receipts distinct from missing authorship on direct persistence', () => {
  const start = source.indexOf('const inputAgentMeta: AgentMeta');
  const end = source.indexOf('    if (!message)', start);
  expect(start).toBeGreaterThan(0);
  const build = new Function('params', 'queuedOrigin', compile(source.slice(start, end) + '\nreturn inputAgentMeta;'));
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, undefined)).toEqual({ autoReviewUserText: { kind: 'delegated-continuation' }, delivery: 'turn' });
  expect(build({}, undefined)).toBeUndefined();
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, { kind: 'orca' })).toMatchObject({ origin: { kind: 'orca' }, autoReviewUserText: { kind: 'delegated-continuation' } });
  expect(build({ autoReviewUserText: 'Inspect the project', sourcePlugin: { pluginId: 'p' } }, undefined))
    .toMatchObject({ sourcePlugin: { pluginId: 'p' }, autoReviewUserText: 'Inspect the project', delivery: 'turn' });
});

it('builds a durable queued plugin input with its accepted task text', async () => {
  const start = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const end = source.indexOf('  const orcaInterAgentDispatcher:', start);
  expect(start).toBeGreaterThan(0);
  const createOpts = { model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' };
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk', 'UI_ACTION_TRIGGER_PREFIX', 'HOST_ONLY_AGENT_PREFIX', 'bindTaskActionInput',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode, '[UI_ACTION_TRIGGER]', HOST_ONLY_AGENT_PREFIX, bindTaskActionInput,
    );
  const base = { targetSessionId: 'lead', clientId: 'plugin-input', message: 'Plugin instructions', persistedContent: 'Plugin instructions', meta: {} };
  const queued = JSON.parse(JSON.stringify(await build({ ...base, autoReviewUserText: base.message, sourcePlugin: { pluginId: 'p' } })));
  expect(queued).toMatchObject({ text: base.message, persistedContent: base.persistedContent, autoReviewUserText: base.message, permissionMode: 'auto', sourcePlugin: { pluginId: 'p' } });
  expect(await build(base)).not.toHaveProperty('autoReviewUserText');
  expect(await build(base)).not.toHaveProperty('agentOmitsTriggerPrefix');
  // Plugin attribution travels on the queued item for the label and source note; it is not an origin.
  const fromPlugin = await build({ ...base, sourcePlugin: { pluginId: 'gh-1', name: 'Reviewer' } });
  expect(fromPlugin).toMatchObject({ sourcePlugin: { pluginId: 'gh-1', name: 'Reviewer' } });
  expect(fromPlugin).not.toHaveProperty('origin');
});

it('reviews accepted plugin task text alongside earlier user restrictions', () => {
  const history = [
    { clientId: 'human', role: 'user', content: 'Do not publish', createdAt: 1,
      agentMeta: { delivery: 'turn', autoReviewUserText: 'Do not publish' } },
    { clientId: 'plugin-task:run', role: 'user', content: 'Inspect and edit the project', createdAt: 2,
      agentMeta: { delivery: 'turn', autoReviewUserText: 'Inspect and edit the project', sourcePlugin: { pluginId: 'p' } } },
  ];
  expect(restoreAutoReviewUserIntent(history)).toEqual({
    earlierUserMessages: ['Do not publish'], currentUserMessage: 'Inspect and edit the project',
  });
});

it('keeps host receipts hidden in the queue while the model text omits the trigger prefix', async () => {
  const start = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const end = source.indexOf('  const orcaInterAgentDispatcher:', start);
  const createOpts = { model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' };
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk', 'UI_ACTION_TRIGGER_PREFIX', 'HOST_ONLY_AGENT_PREFIX', 'bindTaskActionInput',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode, '[UI_ACTION_TRIGGER]', HOST_ONLY_AGENT_PREFIX, bindTaskActionInput,
    );
  const receipt = '[任务回执] 后台任务已完成。task_id: d-1';
  const queued = await build({
    targetSessionId: 'lead', clientId: 'bot-delegation-completion:d-1', meta: {},
    message: receipt, persistedContent: `[UI_ACTION_TRIGGER]${receipt}`,
  });
  // Queue rows mask on `text`; the prefix stays there and is dropped at wire assembly.
  expect(queued).toMatchObject({ text: `[UI_ACTION_TRIGGER]${receipt}`, persistedContent: `[UI_ACTION_TRIGGER]${receipt}`, agentOmitsTriggerPrefix: true });
  // A group DM has a private wire envelope and a separate safe durable body.
  // Keep the queue row hidden without substituting the safe body into the model input.
  const envelope = '[Group source: Private group (group-private); lane: private-lane]\n\nMessage body';
  const groupInput = await build({
    targetSessionId: 'lead', clientId: 'bot-dm:fixture', meta: {},
    message: envelope, persistedContent: '[UI_ACTION_TRIGGER]Message body',
    origin: { kind: 'session', senderSessionId: 'private-lane', displayText: envelope },
  });
  expect(groupInput).toMatchObject({ text: '[UI_ACTION_TRIGGER]Message body', agentOmitsTriggerPrefix: true,
    persistedContent: '[UI_ACTION_TRIGGER]Message body', chatMessage: { content: '[UI_ACTION_TRIGGER]Message body' } });
  expect(buildMakerUserMessage(groupInput)).toMatchObject({ content: envelope });
  const snapshot = sanitizeQueuedMessageForPersistence(groupInput);
  expect(snapshot[HOST_ONLY_AGENT_PREFIX]).toBeUndefined();
  expect(snapshot.text).toBe('[UI_ACTION_TRIGGER]Message body');
  expect(snapshot.origin).toMatchObject({ kind: 'session', displayText: '[UI_ACTION_TRIGGER]Message body' });
  expect(JSON.stringify(snapshot)).not.toContain('Group source:');
  const guest = redactInputProjectionForSharedGuest({ pendingQueue: [groupInput], recovery: { item: groupInput } });
  expect(JSON.stringify(guest)).not.toMatch(/Private group|group-private|private-lane|Group source/);
  // Ordinary prefixed synthetic input (continue prompts) is untouched.
  const continueItem = await build({
    targetSessionId: 'lead', clientId: 'c', meta: {},
    message: '[UI_ACTION_TRIGGER] continue', persistedContent: '[UI_ACTION_TRIGGER] continue',
  });
  expect(continueItem).not.toHaveProperty('agentOmitsTriggerPrefix');
});

it.each(['empty', 'user', 'worker', 'reserved', 'started', 'ended', 'unavailable'])('seals initial plans against persisted activity: %s', async state => {
  const start = source.indexOf('assertTeamPlanUnstarted: async taskId => {');
  const end = source.indexOf('\n      createSession:', start);
  const property = source.slice(start, end).trim().replace(/,$/, '');
  const tables = ['messages', 'sessions', 'orcaWorkers', 'orcaTeams', 'orcaWorkerCreationReservations'];
  const records = Object.fromEntries(tables.map(name => [name, { name }]));
  let drained = false;
  const snapshot = { client: { drizzle: { select: () => {
    let table: {name: string};
    const query = {
      from(value: {name: string}) { table = value; return query; },
      innerJoin() { return query; }, where() { return query; },
      async limit() {
        expect(drained).toBe(true);
        if (state === 'unavailable') throw new Error('unavailable');
        if (table.name === 'sessions') {
          if (state === 'started') return [{ startedAt: 1, endedAt: null }];
          if (state === 'ended') return [{ startedAt: null, endedAt: 1 }];
          return [{ startedAt: null, endedAt: null }];
        }
        const populated = { user: 'messages', worker: 'orcaWorkers', reserved: 'orcaWorkerCreationReservations' }[state];
        return table.name === populated ? [{ id: 'existing' }] : [];
      },
    };
    return query;
  } } } };
  class PlanError extends Error { constructor(code: string) { super(code); } }
  const check = new Function('snapshot', 'assertCurrent', 'drainPersistQueue', 'PluginTaskError', 'eq', 'and', 'gte', ...tables,
    compile(`return ({${property}}).assertTeamPlanUnstarted;`))(
    snapshot, vi.fn(), async () => { drained = true; }, PlanError, vi.fn(), vi.fn(), vi.fn(), ...tables.map(t => records[t]),
  );
  if (state === 'empty') await expect(check('task')).resolves.toBeUndefined();
  else await expect(check('task')).rejects.toThrow(state === 'unavailable' ? 'unavailable' : 'TASK_BUSY');
});

it('aborts both internal delegated entry points when authorization history cannot be read', async () => {
  for (const target of ['live', 'session']) {
    const start = source.lastIndexOf(`sendUserMessageWithAwaitedGitBaseline(${target}, message, clientId, {`);
    const options = source.slice(start, source.indexOf('onAccepted: persistUserMessage', start));
    const expression = options.slice(options.indexOf('restoreAutoReviewUserIntent('), options.indexOf('),', options.indexOf('restoreAutoReviewUserIntent(')) + 1);
    const evaluate = new Function('readAutoReviewHistory', 'restoreAutoReviewUserIntent', 'targetSessionId', `return (async () => ${expression})();`);
    const restore = vi.fn();
    await expect(evaluate(async () => { throw new Error('unavailable'); }, restore, 'task')).rejects.toThrow('unavailable');
    expect(restore).not.toHaveBeenCalled();
  }
});

it('registers the plugin plan under the Lead send lock', () => {
  const registration = source.slice(source.indexOf("case 'setTeamPlan':"), source.indexOf("case 'releaseWorker':"));
  expect(registration).toContain('return withSendToSessionLock(request.taskId, async () => {');
  expect(registration.indexOf('await resolvePluginWorkerDirectory(')).toBeGreaterThan(registration.indexOf('withSendToSessionLock('));
  expect(registration.indexOf('return service.setTeamPlan(')).toBeGreaterThan(registration.indexOf('await resolvePluginWorkerDirectory('));
  expect(registration.trimEnd().endsWith('});')).toBe(true);
});


it('routes trusted script follow-ups through durable authorization restoration, without trusting wire labels', async () => {
  const start = source.indexOf('    sendToSession: async (params) => {');
  const end = source.indexOf('    enableOrca: enableOrcaInternal,', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const sendToSessionInternal = vi.fn(async (params) => params);
  const request = { userText: 'Inspect only.', sessionId: 'caller', clientId: 'owner-input' };
  const capture = vi.fn((sessionId: string, message: string) => captureAgentRequest(sessionId, message,
    { clientId: request.clientId, authoredText: request.userText }, async () => []));
  const send = new Function(
    'captureDataOwnerBroadcastScope', 'classifySessionMessagePurpose', 'isDataOwnerBroadcastScopeCurrent',
    'sendToSessionInternal', 'AUTO_REVIEW_DELEGATED_CONTINUATION', 'coordinationInput', 'captureSessionAgentRequest',
    'resolveSessionProject',
    compile(`return ({ ${source.slice(start, end)} }).sendToSession;`),
  )(() => 'owner', async () => ({ coordination: null, delegatedContinuation: false }), () => true,
    sendToSessionInternal, AUTO_REVIEW_DELEGATED_CONTINUATION, () => { throw new Error('not coordination'); },
    capture, async () => ({ ok: true, projectDir: '/project' }));
  const params = { dispatcherSessionId: 'caller', targetSessionId: 'task', message: 'CI failed; repair and push the PR' };
  expect(await send({ ...params, [AUTO_REVIEW_DELEGATED_CONTINUATION]: true })).toMatchObject({
    message: params.message,
    autoReviewUserText: { kind: 'delegated-continuation' },
    forceQueue: true,
    resumeWithStoredPermissionMode: true,
  });
  expect(capture).not.toHaveBeenCalled();
  const untrusted = await send({ ...params, AUTO_REVIEW_DELEGATED_CONTINUATION: true });
  expect(untrusted).toMatchObject({
    message: params.message,
    autoReviewUserText: { kind: 'agent-request' },
  });
  expect(untrusted).not.toHaveProperty('forceQueue');
  expect(untrusted).not.toHaveProperty('resumeWithStoredPermissionMode');
  expect(await send({ dispatcherSessionId: 'caller', projectDir: '/project', message: 'new task', [AUTO_REVIEW_DELEGATED_CONTINUATION]: true }))
    .toMatchObject({ autoReviewUserText: { kind: 'agent-request' } });
});
