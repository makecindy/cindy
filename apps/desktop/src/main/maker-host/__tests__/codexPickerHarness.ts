import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { eq } from 'drizzle-orm';
import type { Maker } from '../../../../../../packages/maker-core/src/maker.js';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { sessions } from '../../localDb/schema.js';
import * as providers from '../session-provider-store.js';
import * as efforts from '../session-effort-store.js';
import * as routeGuard from '../model-route-guard.js';
import * as control from '../../maker-ipc/sessionRuntimeControl.js';
import * as axes from '../../maker-ipc/runtimeSelectionAxes.js';
import * as relink from '../../maker-ipc/codexProviderThreadRelink.js';
import * as windowGate from '../../../shared/runtimeModelSwitchGate.js';
import * as overflow from '../../maker-ipc/contextOverflowRollover.js';
import { applyRuntimeSetModelChange } from '../../maker-ipc/runtimeSetModel.js';
import { normalizeDeviceLinkSetModelWireArgs } from '../../maker-ipc/setModelWireArgs.js';
import { CredentialModeSwitchBusyError } from '../codex-credential-switch.js';
import { createPendingAgentSwitchRegistry, applyPendingAgentSwitchIfIdle, projectPendingAgentSwitchIntent, type MakerSessionAgentSwitchHandlerDeps } from '../../maker-ipc/sessionAgentSwitchHandler.js';
import { registerSessionSetModelHandler } from '../../maker-ipc/sessionSetModelHandler.js';
import { registerMakerSessionSendHandler } from '../../maker-ipc/sessionSendHandler.js';
import { createMakerSendTransaction, type MakerSendTransactionDeps } from '../../maker-ipc/makerSendTransaction.js';
import { acquireSendToSessionLock, withSendToSessionLock } from '../../maker-ipc/sendToSessionLock.js';
import type { IpcHandler } from '../../maker-ipc/ipcHandlerRegistry.js';
import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import { createSharedTaskSettingGuard } from '../../maker-ipc/sharedTaskSetting.js';

// Execute the full production closures, not copied branches or source assertions.
// Electron ingress, owner, catalog metadata and UI broadcasts are fixture inputs;
// pending selection, runtime replacement, native fork and SQLite CAS stay real.
const source = fs.readFileSync(path.resolve(__dirname, '../../maker-ipc/register.ts'), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.Latest, true);
function closure(name: string): string {
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer;
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name && ts.isArrowFunction(node.initializer)) expression = node.initializer;
    if (ts.isBinaryExpression(node) && node.left.getText(ast) === name && ts.isArrowFunction(node.right)) expression = node.right;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!expression) throw new Error(`Missing production closure ${name}`);
  return ts.transpileModule(`(${expression.getText(ast)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

export function createCodexPickerHarness(input: {
  maker: Maker;
  db: Pick<DbClient, 'drizzle'>;
  workingDir: string;
  createMessage(id: string, message: { clientId: string; content: unknown }): Promise<unknown>;
}) {
  const { maker, db, workingDir } = input;
  const pending = createPendingAgentSwitchRegistry();
  const noop = () => {};
  const asyncNoop = async () => {};
  const log = { info: noop, warn: noop, debug: noop, error: noop };
  const readRow = async (id: string) => (await db.drizzle.select().from(sessions).where(eq(sessions.id, id)).limit(1))[0];
  const bootstrap = async (id: string) => {
    const row = await readRow(id);
    return maker.createSession({ id, agentKind: 'codex', model: row.model!, providerId: row.providerId,
      resumeSessionId: row.sdkSessionId ?? undefined, workingDir });
  };
  const env: Record<string, unknown> = {
    ...providers, ...efforts, ...routeGuard, ...control, ...axes, ...relink, ...windowGate, ...overflow,
    maker, sessions, eq, log, agentSwitchPending: pending,
    // Ordinary local picker has no shared-task invocation context.
    captureSharedTaskSettingGuard: (id: string) => createSharedTaskSettingGuard(undefined, id, { admitted: false }),
    normalizeDeviceLinkSetModelWireArgs, applyRuntimeSetModelChange, CredentialModeSwitchBusyError,
    projectPendingAgentSwitchIntent, acquireSendToSessionLock, withSendToSessionLock, applyPendingAgentSwitchIfIdle,
    getDbClient: () => db, getCurrentDbClientSnapshot: () => ({ client: db, clientEpoch: 1 }),
    captureDataOwnerBroadcastScope: () => 'synthetic-owner', isDataOwnerBroadcastScopeCurrent: () => true,
    assertReviewSettingsUnlocked: asyncNoop, isDeviceLinkInvoke: () => false,
    deviceLinkInvokeControllerSupports: () => false, CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1: 'fixture',
    throwIpcError: (code: string, message: string) => { throw new Error(`${code}: ${message}`); },
    dbToMakerAgentKind: (kind: string) => kind, getSessionDbAgentKind: () => 'codex',
    assertModelRouteUsable: asyncNoop, shouldApplyExclusiveProviderRerouteLive: () => false,
    clearPendingCredentialSwitchForSession: noop, registerPendingCredentialSwitchForSession: noop,
    getPendingCredentialSwitchTarget: () => undefined, pendingCredentialSwitchHolder: null,
    wakeSessionInputAfterCredentialSwitch: noop, broadcastSessionPatched: noop,
    broadcastSessionRuntimeProjection: asyncNoop, recordSessionContextSnapshot: asyncNoop,
    isSessionInTurn: (id: string) => maker.getSession(id)?.isTurnRunning() ?? false,
    getCodexProxyAuthInjectionState: () => 'oauth-bearer',
    getActiveCatalog: () => ({}), resolveConfiguredContextWindow: () => 258400,
    getDesktopProviderService: () => ({ listProviders: async () => ['openai', 'xd', 'cprov-fixture'].map(id => ({ id, connected: true })) }),
    findCatalogModel: () => ({ id: 'fixture-model', efforts: ['high'], contextWindow: 258400, supportsFastMode: false }),
    reconcileBotModelRoute: asyncNoop, contextOverflowRolloverHolder: null,
    withRehydrateCloseSuppressed: async (_id: string, run: () => Promise<unknown>) => run(),
    persistSessionFields: async (id: string, patch: Partial<typeof sessions.$inferInsert>) => db.drizzle.update(sessions).set(patch).where(eq(sessions.id, id)),
  };
  const context = vm.createContext(env);
  type Apply = (id: string, model: string, providerId: string | null | undefined, revision: unknown, selection: unknown, options: Record<string, unknown>) => Promise<{ deferred?: boolean; superseded?: boolean }>;
  const apply = vm.runInContext(closure('handleSetModel'), context) as Apply;
  env.applySessionRuntimeSelection = (id: string, model: string, providerId: string | null | undefined, selection: unknown, options: Record<string, unknown>) => apply(id, model, providerId, undefined, selection, options);
  const switchDeps = {
    pendingSwitches: pending, getLiveSession: (id: string) => maker.getSession(id),
    bootstrapSwitchedSession: bootstrap, log,
    selectSameAgentModel: vm.runInContext(closure('selectSameAgentModel'), context),
  } as unknown as MakerSessionAgentSwitchHandlerDeps;
  env.agentSwitchDeps = switchDeps;
  const beforeSend = vm.runInContext(closure('pendingAgentSwitchApplyHolder'), context) as (id: string) => Promise<{ release(): void }>;
  const transactionDeps: MakerSendTransactionDeps = {
    getSession: id => maker.getSession(id), closeSession: id => maker.closeSession(id), getSessionMeta: id => maker.getSessionMeta(id),
    preflightBotRuntimeResources: asyncNoop, ensureRemoteReadyForSessionStart: asyncNoop,
    checkWorkDirExists: async () => true, readSessionWorkingDirFromDb: async () => workingDir,
    readWorkingDirectoryRecoveryCreateOpts: async id => {
      const row = await readRow(id);
      return { id, agentKind: 'codex', model: row.model ?? undefined, providerId: row.providerId,
        resumeSessionId: row.sdkSessionId ?? undefined, workingDir };
    },
    isOrcaMcpHydrated: () => true, buildCreateOptsWithStderr: opts => opts,
    synthesizeOrcaVendorOptionsFromDb: async () => false, readSessionExtraDirsFromDb: async () => [],
    withRehydrateCloseSuppressed: async (_id, run) => run(),
    bootstrapSession: async opts => ({ session: await bootstrap(opts.id!), didInjectOrcaInstructions: false, didInjectProjectContext: false }),
    markOrcaRoleIfNeeded: asyncNoop, broadcastSessionCreated: noop,
    prepareSendUserMessage: async (_id, message) => message as string,
    createDbMessage: input.createMessage, isSessionRunningError: () => false, log,
  };
  const transaction = createMakerSendTransaction(transactionDeps);
  const handlers = new Map<string, IpcHandler>();
  const registry = { handle: (channel: string, handler: IpcHandler) => { handlers.set(channel, handler); } };
  registerSessionSetModelHandler(registry, { isDeviceLinkInvoke: () => false, assertTrustedSender: noop,
    apply: (id, model, providerId, revision, selection) => apply(id as string, model as string, providerId as string, revision, selection, { source: 'user' }),
  });
  registerMakerSessionSendHandler(registry, { sendToAgentAccepted: async (id, message, opts, sendOpts) => {
    const lease = await beforeSend(id);
    try { return await transaction.sendToAgentAccepted(id, message, opts, sendOpts); }
    finally { lease.release(); }
  } });
  return {
    pending,
    pick: (id: string, providerId: string, model = 'fixture-model') => handlers.get(MAKER_INVOKE.SET_MODEL)!(null, id, model, providerId),
    send: (id: string, clientId: string) => handlers.get(MAKER_INVOKE.SEND)!(null, id, 'picker fixture',
      { id, agentKind: 'codex', model: 'fixture-model', workingDir },
      { messageUuid: clientId, persistUserMessage: { clientId, content: 'picker fixture' } }),
  };
}
