/**
 * makerSendToSessionOrdering.test.ts
 * ---------------------------------------------------------------------------
 * send_to_session 是 Orca / MCP 接管路径，不走 renderer 的乐观消息队列。
 * 这里用源码契约守住这些长期约束：
 * 1. user row 必须在 Session.send 的 accepted 边界写入，vendor handle 启动前
 *    DB 已经是单一真相源。
 * 2. Session.send 的 SESSION_RUNNING 必须映射成业务 BUSY，而不是 INTERNAL。
 * 3. create 分支的 session created 广播必须跟 accepted 持久化边界一致。
 * 4. WindowControls 的 any-session-in-turn 判定必须覆盖 Session.send reservation 窗口。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
const sourcePath = resolve(__dirname, '..', 'maker-ipc', 'register.ts');
const source = readFileSync(sourcePath, 'utf8').replace(/\r\n?/g, '\n');
const acceptedCallbackSourcePath = resolve(__dirname, '..', 'maker-ipc', 'acceptedCallbackRunner.ts');
const acceptedCallbackSource = readFileSync(acceptedCallbackSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const orcaInterAgentDispatcherSourcePath = resolve(__dirname, '..', 'maker-ipc', 'orcaInterAgentDispatcher.ts');
const orcaInterAgentDispatcherSource = readFileSync(orcaInterAgentDispatcherSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const schedulerRunnerSourcePath = resolve(__dirname, '..', 'scheduler-host', 'runner.ts');
const schedulerRunnerSource = readFileSync(schedulerRunnerSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const goalControllerSourcePath = resolve(__dirname, '..', 'goal-host', 'controller.ts');
const goalControllerSource = readFileSync(goalControllerSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const imTurnRunnerSourcePath = resolve(__dirname, '..', 'im', 'shared', 'turnRunner.ts');
const imTurnRunnerSource = readFileSync(imTurnRunnerSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const orcaWorkflowSourcePath = resolve(repoRoot, 'packages', 'orca-workflow', 'src', 'orca-bridge-mcp.ts');
const orcaWorkflowSource = readFileSync(orcaWorkflowSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const orcaTeamServiceSourcePath = resolve(__dirname, '..', 'maker-ipc', 'orcaTeamService.ts');
const orcaTeamServiceSource = readFileSync(orcaTeamServiceSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const orcaWorkerCreationServiceSourcePath = resolve(__dirname, '..', 'maker-ipc', 'orcaWorkerCreationService.ts');
const orcaWorkerCreationServiceSource = readFileSync(orcaWorkerCreationServiceSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const orcaLifecycleServiceSourcePath = resolve(__dirname, '..', 'maker-ipc', 'orcaLifecycleService.ts');
const orcaLifecycleServiceSource = readFileSync(orcaLifecycleServiceSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const useWorkersSourcePath = resolve(__dirname, '..', '..', 'renderer', 'features', 'cc-agent', 'hooks', 'useWorkers.ts');
const useWorkersSource = readFileSync(useWorkersSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const workerProjectionStoreSourcePath = resolve(__dirname, '..', '..', 'renderer', 'features', 'cc-agent', 'hooks', 'workerProjectionStore.ts');
const workerProjectionStoreSource = readFileSync(workerProjectionStoreSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const preloadSourcePath = resolve(__dirname, '..', '..', 'preload', 'preload.ts');
const preloadSource = readFileSync(preloadSourcePath, 'utf8').replace(/\r\n?/g, '\n');
const useOrcaWorkerSelectionSourcePath = resolve(__dirname, '..', '..', 'renderer', 'features', 'cc-agent', 'hooks', 'useOrcaWorkerSelection.ts');
const useOrcaWorkerSelectionSource = readFileSync(useOrcaWorkerSelectionSourcePath, 'utf8').replace(/\r\n?/g, '\n');

describe('sendToSession ordering', () => {
  it('routes Orca worker task dispatch through the service primitive and Orca lead/worker queue dispatcher', () => {
    const helperBlock = extractBetween(
      orcaInterAgentDispatcherSource,
      'async function sendPersistedUserMessageToSession',
      'function makeQueuedDispatchOutcome',
    );
    const serviceDispatchBlock = extractOrcaTeamServiceDispatchWorkerTaskSource();
    const serviceDepsBlock = extractBetween(
      source,
      'const orcaTeamService = createOrcaTeamService({',
      '  });\n  orcaTeamServiceForEvents = orcaTeamService;',
    );
    const lifecycleDispatchBlock = extractBetween(
      orcaLifecycleServiceSource,
      'async function dispatchInitialTask',
      'async function createWorker',
    );

    expect(helperBlock).toContain('const result = await resolveCollabDispatchResult(');
    expect(helperBlock).toContain('() => session.send(agentMessage, {');
    expect(helperBlock).toContain('planMode: false,');
    expect(helperBlock).toContain('throwOnStartFailure: true,');
    expect(helperBlock).toContain('onAccepted: async () => {');
    expect(helperBlock).toContain('await deps.createDbMessage(session.id, {');
    expect(helperBlock).toContain('await deps.beginDirectTurnChangeSet(session.id, clientId);');
    expect(helperBlock).toContain('deps.abortDirectTurnChangeSet(session.id);');
    expect(helperBlock).toContain('{ source, context },');
    expectOrder(helperBlock, 'onAccepted: async () => {', 'await deps.createDbMessage(session.id, {');
    // 顺序硬约束: 先落库再跑 accepted 副作用。createDbMessage 失败时 Session.send 按
    // 派发前失败处理不启动 turn, 副作用若先跑会留下没有 terminal event 清理的幽灵
    // running/autoBridgePending 状态(Codex review P2)。
    expectOrder(helperBlock, 'await deps.createDbMessage(session.id, {', 'await deps.beginDirectTurnChangeSet(session.id, clientId);');
    expectOrder(helperBlock, 'await deps.beginDirectTurnChangeSet(session.id, clientId);', 'await runAcceptedCallback(onAccepted, session.id, clientId, deps.log ?? defaultLog);');

    expect(source).not.toContain('async function dispatchInitialTaskToOrcaWorker');
    expect(serviceDispatchBlock).toContain('result = await deps.dispatchWorkerMessage({');
    expect(serviceDispatchBlock).toContain('workerId: link.workerId,');
    expect(serviceDispatchBlock).toContain('dispatchMeta: params.dispatchMeta,');
    expect(serviceDispatchBlock).not.toContain('await createDbMessage(');
    expect(serviceDispatchBlock).not.toContain('await workerSession.send({');
    expect(serviceDepsBlock).toContain('dispatchWorkerMessage: async ({');
    expectOrder(serviceDepsBlock, 'targetSessionId,', 'message,');
    expectOrder(serviceDepsBlock, 'message,', 'workerId,');
    expectOrder(serviceDepsBlock, 'workerId,', 'dispatchMeta,');
    expectOrder(serviceDepsBlock, 'dispatchMeta,', 'onAccepted,');
    expectOrder(serviceDepsBlock, 'onAccepted,', 'onAcceptedRollback,');
    expect(serviceDepsBlock).toContain('const result = await dispatchOrEnqueueOrcaInterAgentMessage({');
    expect(serviceDepsBlock).toContain('workerId,');
    expect(serviceDepsBlock).toContain("senderLabel: 'Lead'");
    expect(serviceDepsBlock).toContain("source: 'lead'");
    expect(serviceDepsBlock).toContain('meta: dispatchMeta,');

    expect(lifecycleDispatchBlock).toContain('return await deps.dispatchWorkerTask({');
    expect(lifecycleDispatchBlock).toContain('createHostSendFailure(');
    expect(lifecycleDispatchBlock).toContain('Collab delegate send failed before vendor dispatch: $' + '{params.context}');
    expect(lifecycleDispatchBlock).not.toContain('sendPersistedUserMessageToSession({');
    expect(lifecycleDispatchBlock).not.toContain('await createDbMessage(');
    expect(lifecycleDispatchBlock).not.toContain('.send({');
  });

  it('uses the persisted current project path and live workspace kind for the collaboration gate', () => {
    const policyGuardBlock = extractBetween(
      source,
      'async function assertLeadCollabProjectEnabled',
      'async function sendUserMessageWithAwaitedGitBaseline',
    );

    expect(policyGuardBlock).toContain(
      "const liveWorkspaceKind = (lead as { workspaceKind?: unknown } | undefined)?.workspaceKind;",
    );
    expect(policyGuardBlock).toContain(
      "typeof leadRow?.workingDir === 'string' ? leadRow.workingDir : lead?.workDir;",
    );
    expect(policyGuardBlock).toContain(
      "liveWorkspaceKind === 'project' || liveWorkspaceKind === 'dialogue'",
    );
    expectOrder(policyGuardBlock, 'leadRow?.workingDir', 'lead?.workDir');
    expect(policyGuardBlock).toContain(' : leadRow?.workspaceKind;');
    expectOrder(policyGuardBlock, 'const liveWorkspaceKind =', 'assertCollabProjectEnabled(');
    expect(policyGuardBlock).toContain(
      'matchDialogueWorkspacePath(workingDir, dialogueWorkspaceRootDir()) !== null',
    );
  });

  it('uses the same trusted collab scope helper and acknowledges the accepted workspace kind', () => {
    const pluginStateBlock = extractBetween(
      source,
      'ipcMain.handle(\n    MAKER_INVOKE.PLUGINS_GET_STATE',
      'ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED',
    );

    expect(pluginStateBlock).toContain('resolveLocalCollabPolicyWorkingDir(');
    expect(pluginStateBlock).toContain("typeof workspaceKind === 'string' ? workspaceKind : null");
    expect(pluginStateBlock).toContain(
      'matchDialogueWorkspacePath(candidate, dialogueWorkspaceRootDir()) !== null',
    );
    expect(pluginStateBlock).toContain('getEnableState(id, policyWorkingDir)');
    expect(pluginStateBlock).toContain(
      "workspaceKind === 'project' || workspaceKind === 'dialogue'",
    );
    expect(pluginStateBlock).toContain('collabWorkspaceKind: acceptedWorkspaceKind');
  });

  it('keeps non-composer direct sends from inheriting armed plan mode', () => {
    const createWorkerReadyBlock = extractBetween(
      source,
      'sendWorkerReadyMessage: (session) => {',
      '    broadcastSessionCreated,',
    );
    const workerReadyPlaceholderBlock = extractBetween(
      source,
      'sendWorkerReadyPlaceholder: async',
      '    rollbackCreatedWorker:',
    );
    const sendToSessionBlock = extractSendToSessionSource();
    const queuedCreateOptsBlock = extractBetween(
      source,
      'async function buildCreateOptsForQueuedSession',
      'async function enqueueSendToSessionMessage',
    );

    expect(createWorkerReadyBlock).toContain(
      "session.send({ type: 'user', content: ORCA_WORKER_READY_MESSAGE }, { planMode: false })",
    );
    expect(workerReadyPlaceholderBlock).toContain('{ planMode: false, throwOnStartFailure: true },');
    expect(sendToSessionBlock).toContain('planMode: false,');
    expect(queuedCreateOptsBlock).toContain('planMode: false,');
    expect(orcaInterAgentDispatcherSource).toContain('planMode: false,');
    expect(schedulerRunnerSource).toContain('planMode: false,');
    expect(goalControllerSource).toContain("origin: { kind: 'goal', goalSessionId: sessionId },");
    expect(goalControllerSource).toContain('planMode: false,');
    expect(imTurnRunnerSource).toContain('planMode: false,');
    expect(orcaWorkflowSource).toContain('planMode: false,');
  });

  it('rolls back Orca accepted side effects when dispatch is cancelled after accepted', () => {
    const dispatchBlock = extractDispatchOrEnqueueOrcaInterAgentMessageSource();
    const serviceDispatchBlock = extractOrcaTeamServiceDispatchWorkerTaskSource();
    const workerCreateBlock = extractBetween(
      source,
      'ipcMain.handle(MAKER_INVOKE.WORKER_CREATE',
      'ipcMain.handle(MAKER_INVOKE.WORKER_LIST',
    );

    expect(acceptedCallbackSource).toContain('export async function runAcceptedRollback');
    expect(orcaInterAgentDispatcherSource).toContain('onAcceptedRollback?: () => void | Promise<void>;');
    expect(dispatchBlock).toContain('let acceptedDidRun = false;');
    expect(dispatchBlock).toContain('const runAccepted = async (): Promise<void> => {');
    expect(dispatchBlock).toContain('acceptedDidRun = true;');
    expect(dispatchBlock).toContain('const failureResult = async (dispatchOutcome: CollabDispatchFailureOutcome): Promise<DispatchOrcaInterAgentMessageResult> => {');
    expect(dispatchBlock).toContain('await runAcceptedRollback(params.onAcceptedRollback, params.targetSessionId, clientId, log);');
    expect(dispatchBlock).toContain('onAccepted: runAccepted,');
    expect(dispatchBlock).toContain('return failureResult(result.dispatchOutcome);');
    expectOrder(dispatchBlock, 'const runAccepted = async (): Promise<void> => {', 'sendPersistedUserMessageToSession(deps, {');
    expectOrder(dispatchBlock, 'onAccepted: runAccepted,', 'return failureResult(result.dispatchOutcome);');

    expect(serviceDispatchBlock).toContain('let acceptedSnapshot: {');
    expect(serviceDispatchBlock).toContain('if (!acceptedSnapshot) return;');
    expect(serviceDispatchBlock).toContain('const rollbackAccepted = async (): Promise<void> => {');
    expect(serviceDispatchBlock).toContain('previousStatus: acceptedSnapshot.previousStatus,');
    expect(serviceDispatchBlock).toContain('previousPending: acceptedSnapshot.previousPending,');
    expect(serviceDispatchBlock).toContain('const currentWorkers = await deps.listWorkersByLead(link.leadSessionId);');
    expect(serviceDispatchBlock).toContain('const currentWorker = currentWorkers.find((worker) => worker.id === target.id);');
    expect(serviceDispatchBlock).toContain('previousStatus: currentWorker?.status ?? target.status,');
    expect(serviceDispatchBlock).toContain('onAcceptedRollback: rollbackAccepted,');
    expectOrder(serviceDispatchBlock, 'const currentWorkers = await deps.listWorkersByLead(link.leadSessionId);', "await deps.updateWorkerStatus(target.id, 'running');");
    expectOrder(serviceDispatchBlock, 'acceptedSnapshot = {', "await deps.updateWorkerStatus(target.id, 'running');");
    expect(orcaTeamServiceSource).toContain('await deps.updateWorkerStatus(params.worker.id, params.previousStatus);');
    expect(workerCreateBlock).toContain('orcaLifecycleService.createWorker({');
    expect(orcaLifecycleServiceSource).toContain('dispatchWorkerTask({');
    expect(workerCreateBlock).not.toContain('onAcceptedRollback: async () => {');
    expect(workerCreateBlock).not.toContain('workerAutoBridgePending.delete(workerSession.id);');
  });

  it('tracks queued Orca accepted callbacks until dispatch settles or the item is discarded', () => {
    const dispatchBlock = extractDispatchOrEnqueueOrcaInterAgentMessageSource();
    const coordinatorBlock = extractBetween(
      source,
      'const inputCoordinator: AgentInputCoordinator = new AgentInputCoordinator({',
      'agentInputCoordinatorHolder = inputCoordinator;',
    );

    expect(orcaInterAgentDispatcherSource).toContain('interface QueuedOrcaInterAgentAcceptedCallback');
    expect(orcaInterAgentDispatcherSource).toContain('const queuedOrcaInterAgentAcceptedCallbacks = new Map<string, QueuedOrcaInterAgentAcceptedCallback>();');
    expect(dispatchBlock).toContain('registerQueuedOrcaInterAgentAcceptedCallback(clientId, params.onAccepted, params.onAcceptedRollback);');
    expect(orcaInterAgentDispatcherSource).toContain('rollback,');
    expect(orcaInterAgentDispatcherSource).toContain('didRun: false,');
    expect(coordinatorBlock).toContain('await orcaInterAgentDispatcher.settleQueuedOrcaInterAgentAcceptedCallback(');
    expectOrder(coordinatorBlock, 'sessionId,', 'sendOpts,');
    expectOrder(coordinatorBlock, 'sendOpts,', 'result.outcome');
    expect(coordinatorBlock).toContain('await orcaInterAgentDispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback(');
    expect(orcaInterAgentDispatcherSource).toContain('callback.didRun = true;');
    expect(orcaInterAgentDispatcherSource).toContain('return runAcceptedCallback(callback.accepted, sessionId, item.clientId, log);');
    expect(coordinatorBlock).toContain('orcaInterAgentDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);');
    expectOrder(orcaInterAgentDispatcherSource, 'callback.didRun = true;', 'return runAcceptedCallback(callback.accepted, sessionId, item.clientId, log);');
  });

  it('keeps queued Orca lead/worker items structured-cloneable', () => {
    // 排队项进 pendingQueue projection 要过 Electron IPC 结构化克隆。
    // buildCreateOptsWithStderr 注入的 onStderrLine 函数 / orca rehydrate 的
    // 运行时对象进了队列项会让整条 projection 广播抛
    // "object could not be cloned"(e2e 实测回归), 这里守住剥离逻辑。
    const block = extractBetween(
      source,
      'function sanitizeVendorOptionsForQueuedItem',
      'async function enqueueSendToSessionMessage',
    );
    const queuedBlock = extractBetween(
      orcaInterAgentDispatcherSource,
      'function buildQueuedOrcaInterAgentMessage',
      '*** End',
      { allowMissingEnd: true },
    );
    expect(block).toContain("if (value === null || t === 'string' || t === 'number' || t === 'boolean') out[key] = value;");
    expect(block).toContain('vendorOptions: sanitizeVendorOptionsForQueuedItem(createOpts.vendorOptions),');
    expect(queuedBlock).toContain('vendorOptions: params.createOpts.vendorOptions,');
  });

  it('does not let persisted sends ignore typed dispatch outcomes', () => {
    const helperBlock = extractBetween(
      orcaInterAgentDispatcherSource,
      'async function sendPersistedUserMessageToSession',
      'function makeQueuedDispatchOutcome',
    );
    const block = extractSendToSessionSource();
    const createBranch = extractBetween(
      block,
      'if (!targetSessionId) {',
      'const prev = sendToSessionLocks.get(targetSessionId);',
    );
    const liveBranch = extractBetween(
      block,
      'live = maker.getSession(targetSessionId);',
      'try {\n        const createOpts = buildCreateOptsWithStderr({',
    );
    const resumedBranch = extractBetween(
      block,
      'const createOpts = buildCreateOptsWithStderr({\n          id: targetSessionId,',
      'const tracked = run.finally(() => {',
    );

    expect(source).toContain('assertDesktopSendDispatched');
    expect(orcaInterAgentDispatcherSource).toContain('resolveCollabDispatchResult');
    expect(helperBlock).toContain('Promise<CollabDirectDispatchResult>');
    expect(helperBlock).toContain('const result = await resolveCollabDispatchResult(');
    expect(helperBlock).toContain('() => session.send(agentMessage, {');
    expect(helperBlock).toContain('planMode: false,');
    expect(helperBlock).toContain('throwOnStartFailure: true,');
    expect(helperBlock).not.toContain('await session.send(agentMessage, {');
    expect(helperBlock).not.toContain('assertDesktopSendDispatched(sendResult');
    expect(createBranch).toContain('const sendResult = await sendUserMessageWithAwaitedGitBaseline(session, message, clientId, {');
    expect(createBranch).toContain('planMode: false,');
    expect(createBranch).toContain("assertDesktopSendDispatched(sendResult, 'send_to_session create');");
    expect(liveBranch).toContain('const sendResult = await sendUserMessageWithAwaitedGitBaseline(');
    expect(liveBranch).toContain('live,');
    expectOrder(liveBranch, 'message,', 'clientId,');
    expect(liveBranch).toContain('onAccepted: persistUserMessage,');
    expect(liveBranch).toContain('onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),');
    expect(liveBranch).toContain("assertDesktopSendDispatched(sendResult, 'send_to_session live');");
    expect(resumedBranch).toContain('const sendResult = await sendUserMessageWithAwaitedGitBaseline(');
    expect(resumedBranch).toContain('session,');
    expectOrder(resumedBranch, 'message,', 'clientId,');
    expect(resumedBranch).toContain('onAccepted: persistUserMessage,');
    expect(resumedBranch).toContain('onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),');
    expect(resumedBranch).toContain("assertDesktopSendDispatched(sendResult, 'send_to_session resumed');");
  });

  it('awaits Git baseline capture after send_to_session user row persistence and before dispatch', () => {
    const changeSetBlock = extractBetween(
      source,
      'async function beginTurnChangeSetAtDispatch',
      'export interface RegisterMakerIpcOptions',
    );
    const helperBlock = extractBetween(
      source,
      'async function sendUserMessageWithAwaitedGitBaseline',
      'async function sendToSessionInternal',
    );
    const block = extractSendToSessionSource();

    expect(helperBlock).toContain('onAccepted: async () => {');
    expect(helperBlock).toContain('await opts.onAccepted?.();');
    expect(helperBlock).toContain('await beginTurnChangeSetAtDispatch(session, anchorClientId);');
    expect(helperBlock).toContain('await gitSnapshotCoordinator.onTurnStart(session.id);');
    expect(helperBlock).toContain('const pendingHandoff = await agentHandoffPending.peek(session.id);');
    expect(helperBlock).toContain('prependHandoffToUserMessage(');
    expect(helperBlock).toContain("{ type: 'user', content: message },");
    expect(helperBlock).toContain('const sendResult = await session.send(outgoingMessage, {');
    expect(helperBlock).toContain('agentHandoffPending.consume(session.id);');
    expect(helperBlock).toContain('if (turnChangeSetStarted && !sendResult.accepted) {');
    expect(helperBlock).toContain('clearPendingTurnChangeSets(session.id);');
    expect(helperBlock).toContain('if (baselineStarted && !sendResult.accepted) {');
    expect(helperBlock).toContain('gitSnapshotCoordinator?.onTurnAbort(session.id);');
    expect(changeSetBlock).toContain('await waitForTurnChangeSetSeal(session.id);');
    expect(changeSetBlock).toContain("await finalizeTurnChangeSet(session.id, null, 'partial');");
    expect(changeSetBlock).toContain('anchorClientId,');
    expect(changeSetBlock).toContain('provider: session.agentKind,');
    expect(changeSetBlock).toContain('cwd: session.workDir,');
    expect(changeSetBlock).toContain('remote: session.remoteHostId !== null,');
    const firstSeal = changeSetBlock.indexOf('await waitForTurnChangeSetSeal(session.id);');
    const finalize = changeSetBlock.indexOf("await finalizeTurnChangeSet(session.id, null, 'partial');");
    const secondSeal = changeSetBlock.indexOf('await waitForTurnChangeSetSeal(session.id);', firstSeal + 1);
    const begin = changeSetBlock.indexOf('await beginTurnChangeSet({');
    expect(firstSeal).toBeGreaterThanOrEqual(0);
    expect(finalize).toBeGreaterThan(firstSeal);
    expect(secondSeal).toBeGreaterThan(finalize);
    expect(begin).toBeGreaterThan(secondSeal);
    expectOrder(
      helperBlock,
      'await opts.onAccepted?.();',
      'await beginTurnChangeSetAtDispatch(session, anchorClientId);',
    );
    expectOrder(
      helperBlock,
      'await beginTurnChangeSetAtDispatch(session, anchorClientId);',
      'await gitSnapshotCoordinator.onTurnStart(session.id);',
    );
    expect(countOccurrences(block, 'sendUserMessageWithAwaitedGitBaseline(')).toBe(3);
    expect(block).not.toContain('const sendResult = await session.send({ type: \'user\', content: message }, {');
    expect(block).not.toContain('const sendResult = await live.send(');
  });

  it('persists newly created user messages through the accepted hook', () => {
    const block = extractSendToSessionSource();
    const createBranch = extractBetween(
      block,
      'if (!targetSessionId) {',
      'const prev = sendToSessionLocks.get(targetSessionId);',
    );

    expect(createBranch).toContain('onAccepted: async () => {');
    expect(createBranch).toContain('const sendResult = await sendUserMessageWithAwaitedGitBaseline(session, message, clientId, {');
    expect(createBranch).toContain('planMode: false,');
    expectOrder(createBranch, 'onAccepted: async () => {', 'notifyAgentIslandUserPrompt(session, persistedContent ?? message, {');
    expectOrder(createBranch, 'notifyAgentIslandUserPrompt(session, persistedContent ?? message, {', 'await createDbMessage(session.id, {');
    expect(createBranch).toContain('content: persistedContent ?? message,');
    expect(createBranch).not.toContain('persist user message failed (non-fatal)');
    expect(createBranch).toContain('if (isSessionRunningError(err))');
    expect(createBranch).toContain("errorCode: 'BUSY'");
  });

  it('broadcasts newly created sessions through the accepted hook', () => {
    const block = extractSendToSessionSource();
    const createBranch = extractBetween(
      block,
      'if (!targetSessionId) {',
      'const prev = sendToSessionLocks.get(targetSessionId);',
    );
    const acceptedBlock = extractBetween(
      createBranch,
      'onAccepted: async () => {',
      '          },\n          onDispatching:',
    );
    const sendCallEndNeedle =
      '          onDispatching: () => dispatchAgentIslandUserPrompt(session.id),\n        });';
    const afterSendResolves = createBranch.slice(
      createBranch.indexOf(sendCallEndNeedle) + sendCallEndNeedle.length,
    );

    expect(acceptedBlock).toContain('await createDbMessage(session.id, {');
    expect(acceptedBlock).toContain('notifyAgentIslandUserPrompt(session, persistedContent ?? message, {');
    expect(acceptedBlock).toContain('broadcastSessionCreated(session.id);');
    expectOrder(acceptedBlock, 'notifyAgentIslandUserPrompt(session, persistedContent ?? message, {', 'await createDbMessage(session.id, {');
    expectOrder(acceptedBlock, 'await createDbMessage(session.id, {', 'broadcastSessionCreated(session.id);');
    expect(afterSendResolves).not.toContain('broadcastSessionCreated(session.id);');
    expect(countOccurrences(createBranch, 'broadcastSessionCreated(session.id);')).toBe(1);
  });

  it('routes ANY_SESSION_IN_TURN through maker active session state', () => {
    expect(source).toContain('hasAnySessionInTurn(');
    const anySessionInTurnBlock = extractBetween(
      source,
      'export function anySessionInTurn',
      'let goalClearObserver:',
    );
    const handlerBlock = extractBetween(
      source,
      'ipcMain.handle(MAKER_INVOKE.ANY_SESSION_IN_TURN',
      'ipcMain.handle(MAKER_INVOKE.SESSION_IN_TURN',
    );

    expect(anySessionInTurnBlock).toContain('maker?.listActiveSessions()');
    expect(anySessionInTurnBlock).toContain('hasAnySessionInTurn(');
    expect(handlerBlock).toContain('return anySessionInTurn(maker);');
  });

  it('serializes SET_MODEL behind the send-time agent switch for the same session', () => {
    const setModelBlock = extractBetween(
      source,
      'ipcMain.handle(\n    MAKER_INVOKE.SET_MODEL',
      'ipcMain.handle(MAKER_INVOKE.SET_EFFORT',
    );
    const directSendSwitchBlock = extractBetween(
      source,
      'pendingAgentSwitchApplyHolder = async (sessionId, signal) =>',
      'ipcMain.handle(MAKER_INVOKE.MARK_ORCA_ROLE',
    );

    expect(setModelBlock).toContain(
      'return withSendToSessionLock(sessionId, async () => {',
    );
    expect(setModelBlock).toContain(
      'agentSwitchPending.revision?.(sessionId) !== expectedAgentSwitchRevision',
    );
    expect(setModelBlock).toContain('return { deferred: false, superseded: true };');
    expectOrder(
      setModelBlock,
      'return withSendToSessionLock(sessionId, async () => {',
      'agentSwitchPending.revision?.(sessionId) !== expectedAgentSwitchRevision',
    );
    expectOrder(
      setModelBlock,
      'agentSwitchPending.revision?.(sessionId) !== expectedAgentSwitchRevision',
      'applySetModelThenCancelAgentSwitchIntent(',
    );
    expect(setModelBlock).toContain('if (isDeviceLinkInvoke()) {');
    expect(setModelBlock).toContain('if (atomicSelection) {');
    expect(setModelBlock).toContain('effort: atomicSelection.effort as');
    expect(setModelBlock).toContain('setSessionEffort(sessionId, atomicSelection.effort);');
    expect(setModelBlock).toContain('setSessionFastMode(sessionId, atomicSelection.fastMode);');
    expect(setModelBlock).toContain('await sess.setEffort(');
    expect(setModelBlock).toContain('await sess.setFastMode(atomicSelection.fastMode);');
    expect(setModelBlock).toContain('if (isDeviceLinkInvoke() || atomicSelection) {');
    expect(setModelBlock).toContain('patch.effort = atomicSelection.effort;');
    expect(setModelBlock).toContain('patch.fastMode = atomicSelection.fastMode;');
    expect(setModelBlock).toContain('await persistSessionFields(sessionId, patch);');
    expect(setModelBlock).toContain('markRemoteSettingPersistedInsideHandler(response);');
    expectOrder(
      setModelBlock,
      'applySetModelThenCancelAgentSwitchIntent(',
      'setSessionEffort(sessionId, atomicSelection.effort);',
    );
    expectOrder(
      setModelBlock,
      'effort: atomicSelection.effort as',
      'setSessionEffort(sessionId, atomicSelection.effort);',
    );
    expectOrder(
      setModelBlock,
      'setSessionFastMode(sessionId, atomicSelection.fastMode);',
      'await persistSessionFields(sessionId, patch);',
    );
    expectOrder(
      setModelBlock,
      'await persistSessionFields(sessionId, patch);',
      'return response;',
    );
    expect(preloadSource).toContain('selection?: { effort: string; fastMode: boolean },');
    expectOrder(
      preloadSource,
      'expectedAgentSwitchRevision,',
      'selection,',
    );
    expect(source).toContain('withSessionLock: withSendToSessionLock,');
    expect(directSendSwitchBlock).toContain('const release = await acquireSendToSessionLock(sessionId);');
    expectOrder(
      directSendSwitchBlock,
      'const release = await acquireSendToSessionLock(sessionId);',
      'applyPendingAgentSwitchIfIdle(',
    );
    expectOrder(directSendSwitchBlock, 'applyPendingAgentSwitchIfIdle(', 'return release;');
  });

  it('仅 Device Link 归一化 SET_MODEL 的 JSON null 可选占位,本地仍走严格校验', () => {
    const setModelBlock = extractBetween(
      source,
      'ipcMain.handle(\n    MAKER_INVOKE.SET_MODEL',
      'ipcMain.handle(MAKER_INVOKE.SET_EFFORT',
    );
    expect(setModelBlock).toContain('normalizeDeviceLinkSetModelWireArgs(');
    expect(setModelBlock).toContain('isDeviceLinkInvoke(),');
    expect(setModelBlock).toContain(
      'expectedAgentSwitchRevision = normalizedWireArgs.expectedAgentSwitchRevision;',
    );
    expect(setModelBlock).toContain('selection = normalizedWireArgs.selection;');
    expect(setModelBlock).toContain('expectedAgentSwitchRevision must be a non-negative integer');
    expect(setModelBlock).toContain('selection must contain effort + fastMode');
  });

  it('publishes Agent Island prompt preview from send intent and wires commit rollback', () => {
    const makerSendCreateDbMessageBlock = extractBetween(
      source,
      'const createUserMessageDurably:',
      'const { sendToAgentAccepted: sendToAgentAcceptedUnlocked }',
    );
    const makerSendPreviewHookBlock = extractBetween(
      source,
      'previewUserPrompt: (session, content, options) => {',
      '    isSessionRunningError,',
    );

    expect(makerSendCreateDbMessageBlock).toContain('return await enqueueDurableWrite');
    expect(makerSendCreateDbMessageBlock).not.toContain('notifyAgentIslandUserPrompt(');
    expect(source).toContain('createDbMessage: createUserMessageDurably,');
    expect(makerSendPreviewHookBlock).toContain('previewUserPrompt: (session, content, options) => {');
    expect(makerSendPreviewHookBlock).toContain(
      'const previewed = notifyAgentIslandUserPrompt(session, content, {',
    );
    expect(makerSendPreviewHookBlock).toContain(
      'dispatchUserPromptPreview: (sessionId, clientId) => {',
    );
    expect(makerSendPreviewHookBlock).toContain('dispatchAgentIslandUserPrompt(sessionId);');
    expect(makerSendPreviewHookBlock).toContain('commitUserPromptPreview: (sessionId, clientId) => {');
    expect(makerSendPreviewHookBlock).toContain('rollbackUserPromptPreview: (sessionId, clientId, source) => {');
  });

  it('keeps Agent Island prompt preview failures out of send delivery', () => {
    const promptPreviewBlock = extractBetween(
      source,
      'function notifyAgentIslandUserPrompt',
      'function dispatchAgentIslandUserPrompt',
    );

    expect(promptPreviewBlock).toContain('try {');
    expect(promptPreviewBlock).toContain('getAgentIslandService()');
    expect(promptPreviewBlock).toContain('service.handleUserPrompt');
    expect(promptPreviewBlock).toContain('log.warn(\'Agent Island prompt preview update failed after user message persistence\'');
    expect(promptPreviewBlock).toContain('clientId: options.clientId');
    expect(promptPreviewBlock).toContain('error: error instanceof Error ? error.message : String(error)');
  });

  it('persists takeover user messages through the live session accepted hook', () => {
    const block = extractSendToSessionSource();
    // 同 sendPersistedUserMessageToSession 的顺序硬约束(Codex review P2):
    // prompt preview 可先发,但 accepted 副作用仍必须等落库成功后才执行。
    expectOrder(block, 'notifyAgentIslandUserPrompt(previewSessionMeta', 'await createDbMessage(targetSessionId, {');
    expectOrder(block, 'await createDbMessage(targetSessionId, {', 'await runAcceptedCallback(onAccepted, targetSessionId, clientId);');
    const liveBranch = extractBetween(
      block,
      'live = maker.getSession(targetSessionId);',
      'try {\n        const createOpts = buildCreateOptsWithStderr({',
    );

    expect(liveBranch).toContain('const sendResult = await sendUserMessageWithAwaitedGitBaseline(');
    expect(liveBranch).toContain('live,');
    expect(liveBranch).toContain('onAccepted: persistUserMessage,');
    expect(liveBranch).toContain('onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),');
    expect(liveBranch).not.toContain('await persistUserMessage();');
    expect(liveBranch).toContain('if (isSessionRunningError(err))');
    expect(liveBranch).toContain('await enqueueSendToSessionMessage({');
    expect(liveBranch).toContain("wakeKind: 'queued' as const");
  });

  it('persists takeover user messages through the resumed session accepted hook', () => {
    const block = extractSendToSessionSource();
    const resumedBranch = extractBetween(
      block,
      'const createOpts = buildCreateOptsWithStderr({\n          id: targetSessionId,',
      'const tracked = run.finally(() => {',
    );

    expect(resumedBranch).toContain('const sendResult = await sendUserMessageWithAwaitedGitBaseline(');
    expect(resumedBranch).toContain('session,');
    expect(resumedBranch).toContain('onAccepted: persistUserMessage,');
    expect(resumedBranch).toContain('onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),');
    expect(resumedBranch).not.toContain('await persistUserMessage();');
    expect(resumedBranch).toContain('if (isSessionRunningError(err))');
    expect(resumedBranch).toContain('await enqueueSendToSessionMessage({');
    expect(resumedBranch).toContain("wakeKind: 'queued' as const");
  });

  it('preserves stored permission and extraDirs when sendToWorker resumes a worker', () => {
    const resumeBranch = extractBetween(
      source,
      'async function resumeOrcaWorkerSessionIfMissing',
      'async function ensureRemoteReadyForSessionStart',
    );
    const serviceDepsBlock = extractBetween(
      source,
      'const orcaTeamService = createOrcaTeamService({',
      '  });\n  orcaTeamServiceForEvents = orcaTeamService;',
    );
    const switchFocusIpcBlock = extractBetween(
      source,
      'ipcMain.handle(MAKER_INVOKE.WORKER_SWITCH_FOCUS',
      'registerOrcaWorkerControlHandlers(',
    );
    const switchFocusMcpBlock = extractBetween(
      source,
      'switchFocus: async ({ leadSessionId, workerIdOrLabel }) => {',
      'idleWorker: async ({ callerLeadSessionId, workerId, expectedStatus }) => {',
    );

    expect(resumeBranch).toContain('const extraDirs = await readSessionExtraDirsFromDb(target.sessionId);');
    expect(resumeBranch).toContain('permissionMode: permissionModeOrAsk(row.permissionMode),');
    expect(resumeBranch).toContain('...(extraDirs.length > 0 ? { extraDirs } : {}),');
    expectOrder(resumeBranch, 'const extraDirs = await readSessionExtraDirsFromDb(target.sessionId);', 'const opts = buildCreateOptsWithStderr({');
    expectOrder(resumeBranch, '...(extraDirs.length > 0 ? { extraDirs } : {}),', 'await bootstrapSession(opts);');
    expect(serviceDepsBlock).toContain('resumeWorkerSession: async (target) => {');
    expect(serviceDepsBlock).toContain('await resumeOrcaWorkerSessionIfMissing(target);');
    expect(switchFocusIpcBlock).toContain('const didResume = await resumeOrcaWorkerSessionIfMissing(target);');
    expect(switchFocusMcpBlock).toContain('await resumeOrcaWorkerSessionIfMissing(target);');
  });

  it('keeps IPC and MCP createWorker delegated to the shared lifecycle service', () => {
    const ipcCreateBlock = extractBetween(
      source,
      'ipcMain.handle(MAKER_INVOKE.WORKER_CREATE',
      'ipcMain.handle(MAKER_INVOKE.WORKER_LIST',
    );
    const mcpCreateBlock = extractBetween(
      source,
      'createWorker: async (params) => {',
      'listWorkers: async ({ leadSessionId }) => {',
    );

    expect(ipcCreateBlock).toContain('orcaLifecycleService.createWorker({');
    expect(ipcCreateBlock).toContain('await assertLeadCollabProjectEnabled(b.leadSessionId);');
    expectOrder(ipcCreateBlock, 'await assertLeadCollabProjectEnabled(b.leadSessionId);', 'const result = await orcaLifecycleService.createWorker({');
    expect(mcpCreateBlock).toContain('return await orcaLifecycleService.createWorker(params);');
    expect(ipcCreateBlock).not.toContain('readCodexAuthMode()');
    expect(mcpCreateBlock).not.toContain('readCodexAuthMode()');
    expect(source).toContain('normalizeOrcaWorkerLabel');
    expect(ipcCreateBlock).toContain('const label = normalizeOrcaWorkerLabel(b.label);');
    expect(ipcCreateBlock).toContain("if (!label.ok) throwIpcError('INVALID_PARAMS', label.message);");
    expect(ipcCreateBlock).toContain('label: label.value,');
    expect(orcaWorkerCreationServiceSource).toContain('budgetModelRequiresApiKey(params.agent, resolved.model, deps.readClaudeApiKey() != null)');
    expect(orcaWorkerCreationServiceSource).toContain(
      'agentConsumesExplicitFast(input.agent) && input.fast !== undefined',
    );
    expect(orcaWorkerCreationServiceSource).toContain(
      "return agent === 'codex' || agent === 'pi';",
    );
    expect(orcaLifecycleServiceSource).toMatch(
      /createWorkerInTeam\(\{\s*\n\s*\.\.\.params,\s*\n\s*teamId: team\.id,/,
    );
  });

  it('delegates worker terminal runtime to OrcaTeamService', () => {
    const terminalBlock = extractWorkerTerminalHandlerSource();

    expect(source).not.toContain('workerAutoBridgePending');
    expect(source).not.toContain('workerCapturedText');
    expect(source).not.toContain('clearWorkerPendingCaptureState');
    expect(terminalBlock).toContain('await orcaTeamServiceForEvents?.handleWorkerTerminalTurn({');
    expect(terminalBlock).toContain('sessionId: session.id,');
    expect(terminalBlock).toContain("status: isTerminalTurnErrorEvent(event) ? 'error' : 'done',");
    expect(terminalBlock).toContain('finalText,');
    expect(terminalBlock).not.toContain('getWorkerLink');
    expect(terminalBlock).not.toContain('listWorkersByLead');
    expect(terminalBlock).not.toContain('dispatchInterAgentMessage');
  });

  it('serializes worker terminal handling behind in-flight turn-start status updates', () => {
    const wireSessionSource = extractWireSessionSource();
    const terminalBlock = extractWorkerTerminalHandlerSource();
    const broadcastIndex = wireSessionSource.indexOf('broadcastToAllWindows(MAKER_PUSH.EVENT');
    const waitIndex = wireSessionSource.indexOf('await workerTurnStartSequencer.waitForStart(session.id);');
    const terminalIndex = wireSessionSource.indexOf('await orcaTeamServiceForEvents?.handleWorkerTerminalTurn({');

    expect(source).toContain('const workerTurnStartSequencer = createWorkerTurnStartSequencer(log);');
    expect(source).toContain('workerTurnStartSequencer.start(session.id, async () => {');
    expect(source).toContain("await orcaTeamServiceForEvents?.handleWorkerTurnStarted(session.id);");
    expect(terminalBlock).toContain('await workerTurnStartSequencer.waitForStart(session.id);');
    expect(broadcastIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(broadcastIndex);
    expect(terminalIndex).toBeGreaterThan(waitIndex);
  });

  it('keeps terminal skip and manual interrupt behavior inside OrcaTeamService', () => {
    const serviceTerminalBlock = extractOrcaTeamServiceHandleWorkerTerminalTurnSource();

    expect(serviceTerminalBlock).toContain('const link = await deps.getWorkerLinkBySessionId(params.sessionId);');
    expect(serviceTerminalBlock).toContain('if (!link) return;');
    expect(serviceTerminalBlock).toContain('if (!worker) {');
    expect(serviceTerminalBlock).toContain('clearRuntimeState(params.sessionId);');
    expect(serviceTerminalBlock).toContain("worker.status === 'done' || worker.status === 'error' || worker.status === 'idle'");
    expect(serviceTerminalBlock).toContain('const manualInterrupt = deps.getManualInterrupt(params.sessionId);');
    expect(serviceTerminalBlock).toContain('await deps.markWorkerIdle(link.workerId);');
    expect(serviceTerminalBlock).toContain("log.info('worker manual interrupt: suppressed auto-bridge'");
    expectOrder(serviceTerminalBlock, "worker.status === 'done' || worker.status === 'error' || worker.status === 'idle'", 'const manualInterrupt = deps.getManualInterrupt(params.sessionId);');
    expectOrder(serviceTerminalBlock, 'const manualInterrupt = deps.getManualInterrupt(params.sessionId);', 'await deps.markWorkerIdle(link.workerId);');
    expectOrder(serviceTerminalBlock, 'await deps.markWorkerIdle(link.workerId);', 'await deps.updateWorkerStatus(link.workerId, params.status);');
    expectOrder(serviceTerminalBlock, "worker.status === 'done' || worker.status === 'error' || worker.status === 'idle'", 'await bridgeWorkerCompletion(');
    const manualBlock = extractBetween(
      serviceTerminalBlock,
      'const manualInterrupt = deps.getManualInterrupt(params.sessionId);',
      'await deps.updateWorkerStatus(link.workerId, params.status);',
    );
    expect(manualBlock).not.toContain('sendToSession');
  });

  it('marks worker idle and clears auto-bridge state before aborting worker sessions', () => {
    const serviceIdleBlock = extractBetween(
      orcaTeamServiceSource,
      "async function idleWorker(params: { callerLeadSessionId: string; workerId: string; expectedStatus?: 'done' }): Promise<OrcaOkResult> {",
      'async function archiveWorker',
    );
    const serviceDepsBlock = extractBetween(
      source,
      'const orcaTeamService = createOrcaTeamService({',
      '  });\n  orcaTeamServiceForEvents = orcaTeamService;',
    );

    expect(source).toContain('registerOrcaWorkerControlHandlers(createElectronIpcHandlerRegistry(), {');
    expect(source).toContain('idleWorker: (params) => orcaTeamService.idleWorker(params),');
    expect(serviceIdleBlock).toContain('clearRuntimeState(worker.sessionId);');
    expect(serviceIdleBlock).toContain('await deps.markWorkerIdleIfStatus(worker.id, params.expectedStatus)');
    expect(serviceIdleBlock).toContain('await deps.markWorkerIdle(worker.id)');
    expect(serviceIdleBlock).toContain('await deps.hasPendingWorkerInput(worker.sessionId)');
    expect(serviceIdleBlock).toContain('deps.hasSendToSessionLock(worker.sessionId)');
    expect(serviceIdleBlock).toContain("await closeWorkerSessionBestEffort(worker.sessionId, 'idleWorker');");
    expectOrder(serviceIdleBlock, 'await deps.markWorkerIdleIfStatus(worker.id, params.expectedStatus)', 'clearRuntimeState(worker.sessionId);');
    expectOrder(serviceIdleBlock, 'clearRuntimeState(worker.sessionId);', "await closeWorkerSessionBestEffort(worker.sessionId, 'idleWorker');");

    expect(serviceDepsBlock).toContain('if (sendToSessionLocks.has(sessionId)) return false;');
    expect(serviceDepsBlock).toContain('await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);');
    expect(serviceDepsBlock).toContain('if (!inputCoordinator.isQueueRestored(sessionId)) return true;');
  });

  it('clears pending auto-bridge state before archive and end-team abort paths', () => {
    const disableBlock = extractBetween(
      source,
      'async function disableOrcaInternal',
      'ipcMain.handle(MAKER_INVOKE.SESSION_DISABLE_ORCA',
    );
    const serviceArchiveBlock = extractBetween(
      orcaTeamServiceSource,
      'async function archiveWorker(params: { callerLeadSessionId: string; workerId: string }): Promise<OrcaOkResult> {',
      'return {',
    );

    expect(disableBlock).toContain('orcaTeamService.clearAutoBridgeState(w.sessionId);');
    expect(disableBlock).not.toContain('clearWorkerAutoBridgeState(w.sessionId);');
    expectOrder(disableBlock, 'orcaTeamService.clearAutoBridgeState(w.sessionId);', 'await sess.abort();');
    expect(source).toContain('archiveWorker: (params) => orcaTeamService.archiveWorker(params),');
    expect(serviceArchiveBlock).toContain('clearRuntimeState(worker.sessionId);');
    expect(serviceArchiveBlock).toContain("await closeWorkerSessionBestEffort(worker.sessionId, 'archiveWorker');");
    expect(serviceArchiveBlock).toContain('await deps.archiveWorkerSession(worker.sessionId);');
    expect(serviceArchiveBlock).toContain("await deps.updateWorkerStatus(worker.id, 'done');");
    expectOrder(serviceArchiveBlock, 'clearRuntimeState(worker.sessionId);', "await closeWorkerSessionBestEffort(worker.sessionId, 'archiveWorker');");
    expectOrder(serviceArchiveBlock, "await closeWorkerSessionBestEffort(worker.sessionId, 'archiveWorker');", 'await deps.archiveWorkerSession(worker.sessionId);');
    expectOrder(serviceArchiveBlock, 'await deps.archiveWorkerSession(worker.sessionId);', "await deps.updateWorkerStatus(worker.id, 'done');");
  });

  it('keeps worker idle/archive adapters passing the caller lead session id', () => {
    const workerAdapterBlock = extractBetween(preloadSource, 'idleWorker: (', 'endTeam:');
    expect(workerAdapterBlock).toContain('leadSessionId: string,');
    expect(workerAdapterBlock).toContain('workerId: string,');
    expect(workerAdapterBlock).toContain("expectedStatus?: 'done',");
    expect(workerAdapterBlock).toContain("ipcRenderer.invoke('maker:worker:idle', {");
    expect(workerAdapterBlock).toContain("ipcRenderer.invoke('maker:worker:acknowledge-done', {");
    expect(workerAdapterBlock).toContain('archiveWorker: (leadSessionId: string, workerId: string)');
    expect(workerAdapterBlock).toContain("ipcRenderer.invoke('maker:worker:archive', { leadSessionId, workerId })");
    // device-link:归档入口(现居 useOrcaWorkerSelection)经 orcaWorkflowsFor 按 lead 来源路由
    // (本机直连 / 远程隧道),但仍把 (leadSessionId, workerId) 传给 archiveWorker ——
    // 本不变式守的是「带上 caller lead id」;正则容忍链式调用换行。
    expect(useOrcaWorkerSelectionSource).toMatch(
      /orcaWorkflowsFor\(leadSessionId\)\s*\.archiveWorker\(leadSessionId, workerId\)/,
    );
  });

  it('sets sendToWorker running state only after Orca lead/worker dispatch is accepted', () => {
    const serviceSendBlock = extractOrcaTeamServiceSendToWorkerSource();
    const serviceDispatchBlock = extractOrcaTeamServiceDispatchWorkerTaskSource();
    const depsBlock = extractBetween(
      source,
      'const orcaTeamService = createOrcaTeamService({',
      '  });\n  orcaTeamServiceForEvents = orcaTeamService;',
    );

    expect(serviceSendBlock).toContain('const dispatchResult = await dispatchWorkerTask({');
    expect(serviceDispatchBlock).toContain('result = await deps.dispatchWorkerMessage({');
    expect(serviceDispatchBlock).toContain('onAccepted: async () => {');
    expect(serviceDispatchBlock).toContain("await deps.updateWorkerStatus(target.id, 'running');");
    expect(serviceDispatchBlock).toContain('deps.broadcastOrcaWorkerChanged(link.leadSessionId);');
    expect(serviceDispatchBlock).toContain('currentPending = setPending(params.targetSessionId, {');
    expect(serviceDispatchBlock).toContain('await markPendingReady(params.targetSessionId, currentPending);');
    expect(serviceDispatchBlock).toContain('onAcceptedRollback: rollbackAccepted,');
    expect(depsBlock).toContain('const result = await dispatchOrEnqueueOrcaInterAgentMessage({');
    expect(depsBlock).toContain('targetSessionId,');
    expect(depsBlock).toContain('rawContent: message,');
    expect(depsBlock).toContain('workerId,');
    expect(depsBlock).toContain("senderLabel: 'Lead'");
    expect(depsBlock).toContain('onAccepted: async () => {');
    expect(depsBlock).toContain('clearManualInterrupt(targetSessionId);');
    expect(depsBlock).toContain('await onAccepted?.();');
    expect(depsBlock).toContain('onAcceptedRollback,');
  });

  it('rolls back only the pending entry written after sendToWorker dispatch is accepted', () => {
    const serviceDispatchBlock = extractOrcaTeamServiceDispatchWorkerTaskSource();

    expect(serviceDispatchBlock).not.toContain('hadPendingBefore');
    expect(orcaTeamServiceSource).toContain('if (autoBridge.get(sessionId) !== current) return false;');
    expect(orcaTeamServiceSource).toContain('autoBridge.set(sessionId, previous);');
    expect(orcaTeamServiceSource).toContain('autoBridge.delete(sessionId);');
    expect(serviceDispatchBlock).toContain('const previousPending = autoBridge.get(params.targetSessionId);');
    expect(serviceDispatchBlock).toContain('let currentPending: AutoBridgeState | undefined;');
    expect(serviceDispatchBlock).toContain('await rollbackAcceptedDispatchState({');
    expect(orcaTeamServiceSource).toContain('const workers = await deps.listWorkersByLead(params.worker.leadSessionId);');
    expect(orcaTeamServiceSource).toContain("if (currentWorker?.status !== 'running') return;");
    expect(serviceDispatchBlock).toContain('result = await deps.dispatchWorkerMessage({');
    expectOrder(serviceDispatchBlock, 'currentPending = setPending(params.targetSessionId, {', 'await markPendingReady(params.targetSessionId, currentPending);');
    expectOrder(orcaTeamServiceSource, 'if (autoBridge.get(sessionId) !== current) return false;', "if (currentWorker?.status !== 'running') return;");
    expectOrder(orcaTeamServiceSource, "if (currentWorker?.status !== 'running') return;", 'await deps.updateWorkerStatus(params.worker.id, params.previousStatus);');
    expect(serviceDispatchBlock).toContain('dispatchOutcome: dispatchFailureFromThrown(err, params.dispatchMeta),');
    expect(orcaTeamServiceSource).toContain("createHostSendFailure('SEND_FAILED'");
  });

  it('returns sendToWorker wake metadata from the dispatch boundary', () => {
    const serviceSendBlock = extractOrcaTeamServiceSendToWorkerSource();
    const serviceDispatchBlock = extractOrcaTeamServiceDispatchWorkerTaskSource();
    const returnBlock = extractBetween(
      serviceSendBlock,
      'return {\n      ok: true,',
      '};\n  }\n\n  async function idleWorker',
    );

    expect(serviceDispatchBlock).toContain('const wasLiveBeforeDispatch = deps.getLiveSession(target.sessionId) !== null;');
    expectOrder(serviceDispatchBlock, 'const wasLiveBeforeDispatch = deps.getLiveSession(target.sessionId) !== null;', 'if (!wasLiveBeforeDispatch) {');
    expect(serviceDispatchBlock).not.toContain("target.status === 'idle' || target.status === 'done'");
    expect(returnBlock).toContain('wakeKind: dispatchResult.wakeKind,');
    expect(returnBlock).toContain('targetTitle: dispatchResult.targetTitle,');
    expect(returnBlock).toContain('targetLastUserSendAt: dispatchResult.targetLastUserSendAt,');
  });

  it('exposes Orca lead/worker dispatch receipt fields from the shared DB snapshot', () => {
    const block = extractDispatchOrEnqueueOrcaInterAgentMessageSource();
    const liveBlock = extractBetween(
      block,
      'const live = deps.getLiveSession(params.targetSessionId);',
      'const result = await deps.sendToSessionInternal({',
    );
    const fallbackBlock = extractBetween(
      block,
      'if (result.ok) {',
      '      }\n      return failureResult({',
    );

    expect(block).toContain('const dispatchReceipt = {');
    expect(block).toContain('targetTitle: dbRow.title,');
    expect(block).toContain('targetLastUserSendAt: dbRow.userSendAt !== null');
    expect(block).toContain('...dispatchReceipt,');
    expect(liveBlock).toContain("return { ok: true, mode: 'dispatched', clientId, dispatchOutcome: result.dispatchOutcome, ...dispatchReceipt };");
    expect(liveBlock).not.toContain('isQueuedCollabDispatchResult(result)');
    expect(fallbackBlock).toContain('targetTitle: result.targetTitle,');
    expect(fallbackBlock).toContain('targetLastUserSendAt: result.targetLastUserSendAt,');
  });

  it('uses active slot occupancy for renderer worker-limit gating', () => {
    expect(workerProjectionStoreSource).toContain('isActiveWorkerStatus');
    expect(useWorkersSource).not.toContain('isRunningWorkerStatus');
    expect(useWorkersSource).toContain('const activeWorkerCount = getActiveWorkerCount(workers);');
    expect(workerProjectionStoreSource).toContain('return workers.filter((w) => isActiveWorkerStatus(w.status)).length;');
  });
});

function extractSendToSessionSource(): string {
  const block = source.match(
    /async function sendToSessionInternal\([\s\S]*?const tracked = run\.finally\(\(\) => \{/,
  )?.[0];
  expect(block).toBeTruthy();
  if (!block) throw new Error('sendToSessionInternal source block not found');
  return block;
}

function extractOrcaTeamServiceSendToWorkerSource(): string {
  const block = orcaTeamServiceSource.match(
    /async function sendToWorker\([\s\S]*?\): Promise<SendToWorkerResult> \{[\s\S]*?async function idleWorker/,
  )?.[0];
  expect(block).toBeTruthy();
  if (!block) throw new Error('OrcaTeamService sendToWorker source block not found');
  return block;
}

function extractOrcaTeamServiceDispatchWorkerTaskSource(): string {
  const block = orcaTeamServiceSource.match(
    /async function dispatchWorkerTask\([\s\S]*?async function sendToWorker/,
  )?.[0];
  expect(block).toBeTruthy();
  if (!block) throw new Error('OrcaTeamService dispatchWorkerTask source block not found');
  return block;
}

function extractOrcaTeamServiceHandleWorkerTerminalTurnSource(): string {
  const block = orcaTeamServiceSource.match(
    /async handleWorkerTerminalTurn\(params\) \{[\s\S]*?\n {4}\},\n {2}\};/,
  )?.[0];
  expect(block).toBeTruthy();
  if (!block) throw new Error('OrcaTeamService handleWorkerTerminalTurn source block not found');
  return block;
}

function extractDispatchOrEnqueueOrcaInterAgentMessageSource(): string {
  const block = orcaInterAgentDispatcherSource.match(
    /const dispatchOrEnqueueOrcaInterAgentMessage = async \([\s\S]*?return \{\n {4}dispatchOrEnqueueOrcaInterAgentMessage,/,
  )?.[0];
  expect(block).toBeTruthy();
  if (!block) throw new Error('dispatchOrEnqueueOrcaInterAgentMessage source block not found');
  return block;
}

function extractWorkerTerminalHandlerSource(): string {
  const block = source.match(
    /Worker turn 结束后[\s\S]*?await orcaTeamServiceForEvents\?\.handleWorkerTerminalTurn\(\{[\s\S]*?\n {10}\}\);/,
  )?.[0];
  expect(block).toBeTruthy();
  if (!block) throw new Error('worker terminal handler source block not found');
  return block;
}

function extractWireSessionSource(): string {
  return extractBetween(
    source,
    'export function wireSessionToIpc',
    'ipcMain.handle(MAKER_INVOKE.LIST_AVAILABLE_AGENTS',
  );
}

function extractBetween(
  sourceBlock: string,
  startNeedle: string,
  endNeedle: string,
  opts?: { allowMissingEnd?: boolean },
): string {
  const start = sourceBlock.indexOf(startNeedle);
  const end = sourceBlock.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  if (opts?.allowMissingEnd && end < 0) {
    return sourceBlock.slice(start);
  }
  expect(end).toBeGreaterThan(start);
  return sourceBlock.slice(start, end);
}

function expectOrder(sourceBlock: string, firstNeedle: string, secondNeedle: string): void {
  const first = sourceBlock.indexOf(firstNeedle);
  const second = sourceBlock.indexOf(secondNeedle);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(second).toBeGreaterThanOrEqual(0);
  expect(first).toBeLessThan(second);
}

function countOccurrences(sourceBlock: string, needle: string): number {
  return sourceBlock.split(needle).length - 1;
}
