import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { AutoReviewRequest, PersonalTurnObservation } from '../../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import type { InteractionDecision, InteractionRequest } from '../../../../../../packages/maker-core/src/types/events.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { ClaudeCodeAgent } from '../../../../../../packages/maker-core/src/agents/claude-code/index.js';
import { normalizeRuleGroup } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize.js';
import { BrowserWindow } from 'electron';
import { markAppContentWindow } from '../../windowFocusClassifier.js';
import { pathToFileURL } from 'node:url';
import { registerApprovalRuleCommandHandler } from '../../maker-ipc/approvalRuleCommandHandler.js';
import { IpcHarness } from '../../maker-ipc/__tests__/helpers/ipcHarness.js';
import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import { isTrustedAppRendererEventForLocation } from '../../security/trustedAppRenderer.js';
import { buildAutoPermissionReviewPrompt } from '../auto-permission-reviewer.js';
import { createApprovalRuleStore } from '../approval-rule-store.js';
import { createClaudeLiveUserRulesImporter } from '../approval-rule-sources.js';
import { requirementsOrigin } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements.js';

// Test value (unit): real source/store -> installed SDK canUseTool must ask on
// missing personal evidence, and reapply restrictions after recovery. These 11
// rows migrate unchanged from core's auto-review-wiring regression; store-only
// tests cannot observe the actual callback's shortcut/confirmation outcomes.
// Architecture §1 puts this Host integration in Desktop, which may import core.
// Only the SDK transport and logger are stubbed. Unique temporary data contains
// the activated artifact whose corruption is the minimal failure input.
const sdkMock = vi.hoisted(() => ({ forkSession: vi.fn(), query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdkMock);
vi.mock('../../logger', () => ({ createLogger: () => noopLogger() }));

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
function noopLogger(): Logger {
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
  return logger;
}
async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-managed-claude-approval-'));
  tempDirs.push(dir);
  return dir;
}

// Minimal transport fixture: the real agent installs its own canUseTool and
// interaction handling. No native process, model request or test registration.
async function startSession(_mode: 'auto', options: {
  observe: AgentDeps['onClaudeLiveUserRules'];
  nativeRules?: () => Promise<unknown>;
  reviewer: NonNullable<AgentDeps['reviewAutoPermissionAction']>;
  interactionResolver: (request: InteractionRequest) => Promise<InteractionDecision>;
}) {
  process.env.CLAUDE_CONFIG_DIR = await makeTempDir();
  const workingDir = await makeTempDir();
  sdkMock.query.mockReturnValue({
    [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<unknown>>(() => {}) }; },
    setPermissionMode: vi.fn(async () => {}), setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}), interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}), rewindFiles: vi.fn(async () => ({ canRewind: false })),
    ...(options.nativeRules ? { initializationResult: async () => ({}), listPermissionRules: options.nativeRules } : {}),
  });
  const deps: AgentDeps = {
    auth: { async getState() { return { authenticated: true }; }, async triggerLogin() { return { authenticated: true }; },
      async logout() {}, async getAuthEnv() { return {}; } },
    runtimeConfig: {}, binaryPath: process.execPath, logger: noopLogger(), mcpProviders: [],
    reviewAutoPermissionAction: options.reviewer, onClaudeLiveUserRules: options.observe,
  };
  const handle = await new ClaudeCodeAgent(deps).startSession({
    sessionId: 'session-auto-review', sessionInstanceId: 'personal-instance',
    model: 'claude-opus-4-6', providerId: 'xd', workingDir, permissionMode: 'auto',
  });
  type CanUseTool = (toolName: string, input: Record<string, unknown>, options: { toolUseID: string }) =>
    Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }>;
  const canUseTool = sdkMock.query.mock.calls.at(-1)?.[0]?.options?.canUseTool as CanUseTool | undefined;
  if (!canUseTool) throw new Error('expected sdk query canUseTool');
  const seen: InteractionRequest[] = [];
  handle.setInteractionResolver(async request => { seen.push(request); return options.interactionResolver(request); });
  return { handle, canUseTool, seen, workingDir };
}
function reviewedRequest(reviewer: NonNullable<AgentDeps['reviewAutoPermissionAction']>): AutoReviewRequest {
  const request = vi.mocked(reviewer).mock.calls[0]?.[0];
  if (!request) throw new Error('expected reviewer call');
  return request;
}
afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('managed personal evidence in real CC approval callbacks', () => {
  // Unit: existing fault rows start at canUseTool. With a verified execution
  // lease, missing real store evidence must also route native shortcuts there.
  // Main's initial no-observation projection remains outside this fixture.
  it.each(['catch', 'published-unavailable'] as const)('routes a real managed storage failure before the callback (%s)', async fault => {
    const ownerDataDir = await makeTempDir();
    const owner = { ownerId: 'test-owner', executionHostId: 'test-host', generation: 'owner:1', dbClient: {}, ownerDataDir };
    let observation: PersonalTurnObservation | undefined;
    const reviewer = vi.fn(async () => ({ verdict: 'allow' as const }));
    const h = await startSession('auto', { reviewer, observe: async request => {
      const session = { id: request.sessionId, instanceId: request.sessionInstanceId!, agentKind: 'claude-code',
        workDir: request.workingDir, remoteHostId: null, agentDeviceId: null, getStatus: () => 'active' };
      const imported = await createClaudeLiveUserRulesImporter({ captureOwner: () => owner, ownerCurrent: () => true,
        listSessions: () => [session], readSessionRow: async () => ({ status: 'active', source: 'desktop', agentKind: 'cc',
          workingDir: request.workingDir, title: 'fixture', userSendAt: 1, workspaceKind: 'project', providerId: null,
          remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null }) })(request);
      observation = imported.observation;
      return imported;
    }, interactionResolver: async () => ({ kind: 'permission', behavior: 'deny' }) });
    try {
      const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: ['claude-code' as const] };
      const group = normalizeRuleGroup(requirementsOrigin('route-storage'), scope, [
        { id: 'requirement', original: 'Read(private)\r\n  保留原文  ', decision: 'requirement',
          reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'Bash' } },
      ]);
      const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir, assertCurrent: () => {} });
      const saved = await store.applyManagedEdit(0, scope, [group], [], undefined, true);
      await h.handle.send({ type: 'user', content: 'Show the working directory.' });
      expect(await observation?.revalidate()).toBe(true);
      const active = await observation?.readManaged?.();
      expect(active && !('kind' in active) && active.groups.map(value => value.id)).toEqual([group.id]);
      const artifact = path.join(ownerDataDir, 'command-approval-runtime', 'revisions', String(saved.revision), 'snapshot.json');
      if (fault === 'catch') await fs.writeFile(artifact, '{');
      else {
        const foreign = normalizeRuleGroup(group.origin, { ...scope, executionHostId: 'other-host' }, group.clauses);
        await fs.writeFile(artifact, JSON.stringify({ ...saved, groups: [foreign],
          managedOverrides: [{ id: foreign.id, revision: saved.revision, scope: foreign.scope }] }));
      }
      expect(await observation?.readManaged?.()).toMatchObject({ kind: 'unavailable',
        reason: fault === 'catch' ? 'managed-storage-unavailable' : 'host-identity-conflict' });
      const decisions: unknown[] = [];
      const registered = sdkMock.query.mock.calls.at(-1)![0].options.hooks.PreToolUse;
      for (const matcher of registered) {
        if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test('Bash')) continue;
        for (const hook of matcher.hooks) decisions.push(await hook({
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
          session_id: h.handle.requestSessionId, tool_use_id: 'storage-route', cwd: h.workingDir, transcript_path: '',
        }, 'storage-route', { signal: new AbortController().signal }));
      }
      expect(decisions).toContainEqual(expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'ask' }) }));
      expect(h.seen).toHaveLength(0);
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'storage-route' })).behavior).toBe('deny');
      expect(h.seen).toHaveLength(1);
      expect(h.seen[0]).toMatchObject({ kind: 'permission', input: { command: 'pwd' }, metadata: { autoReviewUnavailable: true } });
      expect(reviewer).not.toHaveBeenCalled();
    } finally { await h.handle.close(); }
  });

  // Unit: trusted composer IPC -> reopen -> real source -> installed canUseTool
  // -> existing review_input payload. No CLI/model transport is executed. The
  // source/store fault rows below cannot test the new neutral command grammar.
  it.each(['allow', 'block', 'ask', 'known-deny', 'known-ask', 'shared-allow'] as const)('reviews whole verbatim requirements from actual IPC (%s)', async scenario => {
    const ownerDataDir = await makeTempDir();
    const owner = { ownerId: 'test-owner', executionHostId: 'test-host', generation: 'owner:1', dbClient: {}, ownerDataDir };
    const original = 'Read(private)\r\n  保留“原文” 🧪 e\u0301、"引号"与\\路径\n末行  ';
    const intent = 'Report only the current working directory.';
    const reviewer = vi.fn(async (_request: AutoReviewRequest) => ({ verdict: scenario === 'block' ? 'block' as const : scenario === 'ask' ? 'ask' as const : 'allow' as const }));
    const h = await startSession('auto', { reviewer, observe: async request => {
      const session = { id: request.sessionId, instanceId: request.sessionInstanceId!, agentKind: 'claude-code',
        workDir: request.workingDir, remoteHostId: null, agentDeviceId: null, getStatus: () => 'active' };
      return (await createClaudeLiveUserRulesImporter({ captureOwner: () => owner, ownerCurrent: () => true,
        listSessions: () => [session], readSessionRow: async () => ({ status: 'active', source: 'desktop', agentKind: 'cc',
          workingDir: request.workingDir, title: 'fixture', userSendAt: 1, workspaceKind: 'project', providerId: null,
          remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null }) })(request));
    }, interactionResolver: async () => ({ kind: 'permission', behavior: 'deny', reason: 'Explicit fixture deny.' }) });
    const registry = new IpcHarness();
    const rendererFile = path.join(ownerDataDir, 'renderer.html');
    const mainFrame = { url: pathToFileURL(rendererFile).href, parent: null };
    const event = { sender: { mainFrame }, senderFrame: mainFrame };
    const window = { isDestroyed: () => false } as unknown as BrowserWindow;
    markAppContentWindow(window);
    vi.spyOn(BrowserWindow, 'fromWebContents').mockReturnValue(window);
    registerApprovalRuleCommandHandler({ handle: (channel, handler) => {
      registry.handle(channel, (_ignored, ...args) => handler(event as never, ...args));
    } }, {
      assertTrustedSender: candidate => {
        if (!isTrustedAppRendererEventForLocation(candidate as never, { devServerUrl: null, packagedRendererFile: rendererFile }))
          throw new Error('Untrusted fixture renderer');
      }, isDeviceLinkInvoke: () => false,
      captureOwner: () => owner, ownerCurrent: () => true, getInputGeneration: () => 0, isProvisional: () => false,
      readSession: async () => ({ status: 'active', source: 'desktop', agentKind: 'cc', workingDir: h.workingDir,
        title: 'fixture', userSendAt: 1, workspaceKind: 'project', providerId: null, remoteHostId: null,
        agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null }),
      withSessionLock: async (_id, run) => run(),
      createStore: (_captured, assertCurrent) => createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir,
        assertCurrent, localManagedCommandHostId: owner.executionHostId }),
    });
    const set = (text: string) => registry.invoke(MAKER_INVOKE.APPROVAL_RULE_COMMAND, { sessionId: 'session-auto-review',
      text: '/approval-rule set user --requirements ' + JSON.stringify({ id: 'release-policy', ...(scenario === 'shared-allow' ? {} : { targets: ['claude-code'] }), text,
        clauses: [{ id: 'known', original: 'Read(this is explicitly a pwd exec rule)', exact: 'pwd',
          decision: scenario === 'known-deny' ? 'deny' : scenario === 'known-ask' ? 'ask' : 'allow' }] }) });
    try {
      expect(await set(original)).toMatchObject({ kind: 'saved' });
      const reopened = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir, assertCurrent: () => {},
        localManagedCommandHostId: owner.executionHostId, resolveManagedConsumer: () => ({
          scope: { ownerId: owner.ownerId, executionHostId: owner.executionHostId, projectId: h.workingDir, harnesses: ['claude-code'] },
          sessionId: 'session-auto-review', sessionInstanceId: 'personal-instance' }) });
      const effective = await reopened.readPublishedManagedSnapshot();
      expect(effective.kind === 'published-managed' && effective.groups[0]!.clauses[0]!.original).toBe(original);
      await h.handle.send({ type: 'user', content: intent });
      const result = await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'neutral-pwd' });
      expect(result.behavior).toBe(scenario === 'allow' || scenario === 'shared-allow' ? 'allow' : 'deny');
      expect(reviewer).toHaveBeenCalledTimes(scenario === 'known-deny' ? 0 : 1);
      expect(h.seen).toHaveLength(scenario === 'ask' || scenario === 'known-ask' ? 1 : 0);
      if (scenario !== 'known-deny') {
        const request = reviewedRequest(reviewer);
        expect(request.action).toMatchObject({ kind: 'exec', command: 'pwd' });
        expect(request.personalRequirements?.groups[0]?.clauses.map(clause => clause.original))
          .toEqual([original, 'Read(this is explicitly a pwd exec rule)']);
        const payload = JSON.parse(buildAutoPermissionReviewPrompt(request).split('<review_input>\n')[1]!.split('\n</review_input>')[0]!);
        expect(payload.personalRequirements).toEqual(request.personalRequirements);
        expect(payload.userIntent).toBe(intent);
        expect(JSON.stringify(payload.userIntent)).not.toContain(original);
      }
      if (scenario === 'allow') {
        // Immediate same-Query edits invalidate the preceding review cache.
        expect(await set(original + ' changed')).toMatchObject({ kind: 'saved' });
        expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'neutral-pwd-after-edit' })).behavior).toBe('allow');
        expect(reviewer).toHaveBeenCalledTimes(2);
        expect(reviewer.mock.calls[1]?.[0]?.personalRequirements?.groups[0]?.clauses[0]?.original).toBe(original + ' changed');
      }
    } finally { await h.handle.close(); }
  });

  // Unit Host -> real store/source -> actual canUseTool. Existing undefined-read
  // fixture has no activated requirement; it misses storage failure erasing one.
  // Minimal fault: corrupt ONLY this test's already-published artifact, after a
  // successful review. No mocked throw can bypass readManaged's actual catch.
  // Each row adds a different observable result/boundary; all use the same real
  // source/store catch. Native policy, CLI and model transport stay untouched.
  it.each([
    ['after-active', 'deny'], ['initial', 'allow'], ['review', 'allow'], ['edited-fault', 'allow'],
    ['confirmation', 'allow'], ['published-unavailable', 'allow'],
    ['recover-deny', 'allow'], ['recover-ask', 'allow'], ['recover-residual', 'allow'],
    ['full-access', 'allow'], ['full-access-owner-changed', 'allow'],
  ] as const)('requires real confirmation when an activated residual artifact becomes unreadable (%s/%s)', async (stage, answer) => {
    const ownerDataDir = await makeTempDir();
    const owner = { ownerId: 'test-owner', executionHostId: 'test-host', generation: 'owner:1', dbClient: {}, ownerDataDir };
    const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: ['claude-code' as const] };
    const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir, assertCurrent: () => {} });
    const group = normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'residual-read-failure-fixture',
      locator: 'cindy://personal-approval/residual-read-failure-fixture', dialectVersion: '1', decisionDomain: 'personal-approval' },
    scope, [{ id: 'residual', original: 'Bash(*private*)', decision: 'deny', reason: 'unverified wildcard' }]);
    const saved = await store.applyManagedEdit(0, scope, [group], [], undefined, true);
    const artifact = path.join(ownerDataDir, 'command-approval-runtime', 'revisions', String(saved.revision), 'snapshot.json');
    const originalBytes = await fs.readFile(artifact);
    const failRead = async () => {
      if (stage === 'published-unavailable') {
        const foreign = normalizeRuleGroup({ ...group.origin, sourceId: 'exact-bash:foreign' },
          { ...scope, executionHostId: 'other-host' }, group.clauses);
        await fs.writeFile(artifact, JSON.stringify({ ...saved, groups: [foreign],
          managedOverrides: [{ id: foreign.id, revision: saved.revision, scope: foreign.scope }] }));
      } else await fs.writeFile(artifact, '{');
    };
    let observation: PersonalTurnObservation | undefined;
    let exercisingFault = false;
    let ownerCurrent = true;
    let confirmations = 0;
    let onConfirm = async () => {};
    const reviewer = vi.fn(async (request: AutoReviewRequest) => {
      if (exercisingFault && stage === 'review') await failRead();
      return { verdict: request.personalRequirements?.groups[0]?.clauses[0]?.original === 'Bash(*new-private*)'
        ? 'block' as const : exercisingFault && stage === 'confirmation' ? 'ask' as const : 'allow' as const };
    });
    const h = await startSession('auto', { reviewer, observe: async request => {
      const session = { id: request.sessionId, instanceId: request.sessionInstanceId!, agentKind: 'claude-code',
        workDir: request.workingDir, remoteHostId: null, agentDeviceId: null, getStatus: () => 'active' };
      const importer = createClaudeLiveUserRulesImporter({ captureOwner: () => owner, ownerCurrent: () => ownerCurrent,
        listSessions: () => [session], readSessionRow: async () => ({ status: 'active', source: 'desktop', agentKind: 'cc',
          workingDir: request.workingDir, title: 'fixture', userSendAt: 1, workspaceKind: 'project', providerId: null,
          remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null }) });
      const imported = await importer(request);
      observation = imported.observation;
      return imported;
    }, interactionResolver: async () => {
      confirmations++;
      if (confirmations === 1) await onConfirm();
      return { kind: 'permission', behavior: answer, reason: 'Explicit fixture answer.',
        ...(stage === 'edited-fault' && confirmations === 1 ? { updatedInput: { command: 'git status' } } : {}),
        permissionUpdates: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Show the working directory.' });
      expect(observation?.groups).toEqual([]); // No native content-only fixture grants authority.
      expect(await observation?.revalidate()).toBe(true);
      const active = await observation?.readManaged?.();
      if (!active || 'kind' in active) throw new Error('Active fixture unavailable');
      expect(active.groups.map(value => value.id)).toEqual([group.id]);
      if (stage !== 'initial') {
        expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'residual-before-read-fault' })).behavior).toBe('allow');
        expect(reviewer).toHaveBeenCalledOnce();
        expect(reviewedRequest(reviewer).personalRequirements?.groups[0]?.clauses[0]?.original).toBe('Bash(*private*)');
      }
      expect(h.seen).toHaveLength(0);
      const reader = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir, assertCurrent: () => {}, localManagedCommandHostId: owner.executionHostId,
        resolveManagedConsumer: () => ({ scope: { ...scope, projectId: h.workingDir },
          sessionId: 'session-auto-review', sessionInstanceId: 'personal-instance' }) });
      expect(await reader.readPublishedManagedSnapshot()).toMatchObject({ kind: 'published-managed', revision: saved.revision });
      if (stage !== 'review' && stage !== 'confirmation') {
        await failRead();
        if (stage === 'published-unavailable') expect(await reader.readPublishedManagedSnapshot())
          .toMatchObject({ kind: 'unavailable', reason: 'host-identity-conflict' });
        else await expect(reader.readPublishedManagedSnapshot()).rejects.toThrow(SyntaxError);
        expect(await observation?.readManaged?.()).toMatchObject({ kind: 'unavailable' });
      }
      onConfirm = async () => {
        if (stage === 'confirmation') await failRead();
        if (stage.startsWith('recover-')) {
          await fs.writeFile(artifact, originalBytes);
          const clause = stage === 'recover-residual'
            ? { ...group.clauses[0]!, original: 'Bash(*new-private*)' }
            : { id: 'known', original: 'Bash(pwd)', decision: stage === 'recover-deny' ? 'deny' as const : 'ask' as const,
              matcher: { kind: 'cc-command' as const, mode: 'exact' as const, pattern: 'pwd' } };
          await store.applyManagedEdit(saved.revision, scope, [{ ...group, clauses: [clause] }], [], undefined, true);
        }
        if (stage.startsWith('full-access')) {
          if (stage === 'full-access-owner-changed') ownerCurrent = false;
          await h.handle.setPermissionMode!('bypassPermissions');
        }
      };
      expect(await observation?.revalidate()).toBe(true); // Identity is still good; this is a storage fault.
      exercisingFault = true;
      const result = await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'residual-after-read-fault' });
      expect(result.behavior).toBe(['after-active', 'recover-deny', 'recover-residual', 'full-access-owner-changed'].includes(stage) ? 'deny' : 'allow');
      expect(result).not.toHaveProperty('updatedPermissions');
      expect(h.seen).toHaveLength(['confirmation', 'recover-ask', 'edited-fault'].includes(stage) ? 2 : 1);
      const faultCard = h.seen[stage === 'confirmation' ? 1 : 0];
      expect(faultCard).toMatchObject({ kind: 'permission', input: { command: 'pwd' }, metadata: { autoReviewUnavailable: true } });
      expect(faultCard?.kind === 'permission' && faultCard.autoCommand).toBeUndefined();
      expect(reviewer).toHaveBeenCalledTimes(stage === 'initial' ? 0
        : ['review', 'confirmation', 'recover-residual'].includes(stage) ? 2 : 1);
      if (stage === 'recover-ask') expect(h.seen[1]).toMatchObject({ kind: 'permission', input: { command: 'pwd' } });
      if (stage === 'edited-fault') {
        expect(h.seen[1]).toMatchObject({ kind: 'permission', input: { command: 'git status' }, metadata: { autoReviewUnavailable: true } });
        expect(result.updatedInput).toEqual({ command: 'git status' });
      }
      if (stage === 'initial') {
        expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'fault-is-not-a-cached-grant' })).behavior).toBe('allow');
        expect(h.seen).toHaveLength(2);
        expect(reviewer).not.toHaveBeenCalled();
      }
    } finally { await h.handle.close(); }
  });
});

// Test value (unit): real factory capture -> real Agent.send -> registered hooks
// and canUseTool. C's first-observation gap differs from the 11 already-verified
// lease/store fault rows: no observation reaches the adapter before acceptance.
// Minimal failures: native content read exceeds its existing deadline, or Main
// cannot capture an owner. Only transport/model are stubbed; no future callback
// fields, copied Main projection, SDK merger or native classifier is introduced.
describe('first managed execution evidence at input acceptance', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }
  async function registeredPwd(h: Awaited<ReturnType<typeof startSession>>, id: string) {
    const results: unknown[] = [];
    const registered = sdkMock.query.mock.calls.at(-1)![0].options.hooks.PreToolUse;
    for (const matcher of registered) {
      if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test('Bash')) continue;
      for (const hook of matcher.hooks) results.push(await hook({
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' },
        session_id: h.handle.requestSessionId, tool_use_id: id, cwd: h.workingDir, transcript_path: '',
      }, id, { signal: new AbortController().signal }));
    }
    return results;
  }
  const route = (decision: 'ask' | 'deny') => expect.objectContaining({
    hookSpecificOutput: expect.objectContaining({ permissionDecision: decision }),
  });

  it.each(['native-timeout', 'owner-unverified', 'unpublished', 'native-read-failed', 'capture-timeout'] as const)(
    'preserves the first-input evidence boundary (%s)', async scenario => {
      const ownerDataDir = await makeTempDir();
      const owner = { ownerId: 'test-owner', executionHostId: 'test-host', generation: 'owner:1', dbClient: {}, ownerDataDir };
      const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: ['claude-code' as const] };
      const original = 'Read(private)\r\n  首次完整要求 🧪\n末行  ';
      const group = normalizeRuleGroup(requirementsOrigin('initial-lease'), scope, [
        { id: 'requirement', original, decision: 'requirement', reason: 'user-authored-verbatim',
          tool: { domain: 'exec', name: 'Bash' } },
        { id: 'known', original: 'Explicit exact pwd', decision: scenario === 'native-read-failed' ? 'allow' : 'deny',
          matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' }, tool: { domain: 'exec', name: 'Bash' } },
      ]);
      const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir, assertCurrent: () => {} });
      const saved = scenario === 'unpublished' ? undefined : await store.applyManagedEdit(0, scope, [group], [], undefined, true);
      const captureEntered = deferred<void>();
      const captureResult = deferred<void>();
      const nativeEntered = deferred<void>();
      const nativeResult = deferred<unknown>();
      const firstImportFinished = deferred<void>();
      let firstRequest: Parameters<NonNullable<AgentDeps['onClaudeLiveUserRules']>>[0] | undefined;
      let firstObservation: PersonalTurnObservation | undefined;
      let firstResult: { kind: string; reason?: string; observation?: PersonalTurnObservation } | undefined;
      let imports = 0;
      let firstCapturePaused = false;
      let firstHandoffs = 0;
      let nativeReads = 0;
      const nativeRules = vi.fn(async (): Promise<unknown> => {
        nativeEntered.resolve();
        if (scenario === 'native-timeout' && ++nativeReads === 1) return nativeResult.promise;
        throw new Error('native content unavailable');
      });
      const reviewer = vi.fn(async (_request: AutoReviewRequest) => ({ verdict: 'allow' as const }));
      const h = await startSession('auto', { reviewer, nativeRules, observe: async request => {
        const first = ++imports === 1;
        if (first) firstRequest = request;
        const session = { id: request.sessionId, instanceId: request.sessionInstanceId!, agentKind: 'claude-code',
          workDir: request.workingDir, remoteHostId: null, agentDeviceId: null, getStatus: () => 'active' };
        const result = await createClaudeLiveUserRulesImporter({
          captureOwner: () => scenario === 'owner-unverified' ? null : owner, ownerCurrent: () => true,
          listSessions: () => [session], readSessionRow: async () => {
            if (scenario === 'capture-timeout' && first && !firstCapturePaused) {
              firstCapturePaused = true; captureEntered.resolve(); await captureResult.promise;
            }
            return { status: 'active', source: 'desktop', agentKind: 'cc',
            workingDir: request.workingDir, title: 'fixture', userSendAt: 1, workspaceKind: 'project', providerId: null,
            remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null };
          },
        })({ ...request, onManagedObservation: observation => {
          if (first) firstHandoffs++;
          request.onManagedObservation?.(observation);
        } });
        if (first) { firstResult = result; firstObservation = result.observation; firstImportFinished.resolve(); }
        // Real factory result contract; Main direct wiring is separately reviewed,
        // without booting Main or copying its projection into a test.
        return result;
      }, interactionResolver: async () => ({ kind: 'permission', behavior: 'deny' }) });
      try {
        if (scenario === 'native-timeout' || scenario === 'capture-timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const send = h.handle.send({ type: 'user', content: 'Show the current working directory.' });
        if (scenario === 'native-timeout' || scenario === 'capture-timeout') {
          // Entering the actual lazy SDK read proves factory capture/assertCurrent
          // have completed; no invented early-delivery protocol is needed to run.
          await (scenario === 'capture-timeout' ? captureEntered.promise : nativeEntered.promise);
          expect(firstHandoffs).toBe(scenario === 'capture-timeout' ? 0 : 1);
          expect(firstRequest?.isCurrent()).toBe(true);
          expect(firstRequest?.execution?.isCurrent()).toBe(true);
          expect(firstResult).toBeUndefined();
          await vi.advanceTimersByTimeAsync(1001);
        }
        await send; // Input acceptance remains independent of content observation.
        vi.useRealTimers();
        expect(sdkMock.query).toHaveBeenCalledTimes(1);
        expect(h.handle.getAutoReviewOwner?.()).toBe('cindy');
        if (scenario === 'native-timeout' || scenario === 'capture-timeout') {
          expect(firstRequest?.signal.aborted).toBe(true);
          expect(firstRequest?.execution?.isCurrent()).toBe(true);
          expect(firstResult).toBeUndefined();
        } else {
          expect(firstResult).toMatchObject({ kind: 'unavailable',
            reason: scenario === 'owner-unverified' ? 'context-changed' : 'read-failed' });
          // Native SDK read failure is not managed storage failure.
          if (scenario !== 'owner-unverified') {
            expect(firstObservation?.readManaged).toBeTypeOf('function');
            const managed = await firstObservation!.readManaged!();
            expect(managed && !('kind' in managed) && managed.groups.map(value => value.id))
              .toEqual(scenario === 'unpublished' ? [] : [group.id]);
          } else {
            expect(firstObservation).toBeUndefined();
            expect(nativeRules).not.toHaveBeenCalled();
          }
        }
        const decisions = await registeredPwd(h, 'initial-evidence-pwd');
        const result = await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'initial-evidence-pwd' });
        if (scenario === 'unpublished') {
          expect(decisions).not.toContainEqual(route('ask'));
          expect(decisions).not.toContainEqual(route('deny'));
          expect(result.behavior).toBe('allow');
        } else if (scenario === 'native-read-failed') {
          expect(decisions).toContainEqual(route('ask'));
          expect(result.behavior).toBe('allow');
          expect(reviewedRequest(reviewer).personalRequirements?.groups[0]?.clauses.map(clause => clause.original))
            .toEqual([original, 'Explicit exact pwd']);
        } else {
          // Soft assertions retain independent hook AND direct callback evidence;
          // no test merger automatically translates hook ask into canUseTool.
          expect.soft(decisions, `${scenario}: actual registered hooks must not lose the evidence boundary`)
            .toContainEqual(route(scenario === 'owner-unverified' || scenario === 'capture-timeout' ? 'deny' : 'ask'));
          expect.soft(result.behavior, `${scenario}: direct callback must not shortcut without evidence`).toBe('deny');
        }
        expect(reviewer).toHaveBeenCalledTimes(scenario === 'native-read-failed' ? 1 : 0);
        expect(h.seen).toHaveLength(0);
        if (scenario === 'native-timeout' || scenario === 'capture-timeout') {
          const nextText = original + ' NEXT accepted input';
          const nextGroup = { ...group, clauses: group.clauses.map(clause => clause.decision === 'requirement'
            ? { ...clause, original: nextText } : { ...clause, decision: 'allow' as const }) };
          await store.applyManagedEdit(saved!.revision, scope, [nextGroup], [], undefined, true);
          await h.handle.send({ type: 'user', content: 'Next accepted input: report pwd.' });
          expect(firstRequest?.execution?.isCurrent()).toBe(false);
          nativeResult.resolve({}); captureResult.resolve();
          await firstImportFinished.promise;
          if (scenario === 'capture-timeout') {
            expect(firstHandoffs).toBe(0);
            expect(firstObservation).toBeUndefined();
          } else expect(firstObservation?.revalidate && await firstObservation.revalidate()).toBe(false);
          // An old completed import cannot replace this newer accepted-input lease.
          expect(await registeredPwd(h, 'next-input-pwd')).toContainEqual(route('ask'));
          expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'next-input-pwd' })).behavior).toBe('allow');
          expect(reviewer).toHaveBeenCalledOnce();
          expect(reviewedRequest(reviewer).personalRequirements?.groups[0]?.clauses[0]?.original).toBe(nextText);
          expect(h.seen).toHaveLength(0);
          expect(sdkMock.query).toHaveBeenCalledTimes(1);
        }
      } finally {
        vi.useRealTimers();
        nativeResult.resolve({}); captureResult.resolve();
        await h.handle.close();
      }
    },
  );

  // Unit C: storage faults on the FIRST read after an early-only lease. The
  // existing 11 fault rows already have a timely final observation installed.
  it.each(['catch', 'published-unavailable'] as const)(
    'revalidates a recovered deny after early-only evidence confirmation (%s)', async fault => {
      const ownerDataDir = await makeTempDir();
      const owner = { ownerId: 'test-owner', executionHostId: 'test-host', generation: 'owner:1', dbClient: {}, ownerDataDir };
      const scope = { ownerId: owner.ownerId, executionHostId: owner.executionHostId, harnesses: ['claude-code' as const] };
      const group = normalizeRuleGroup(requirementsOrigin('early-storage'), scope, [
        { id: 'requirement', original: 'Keep this complete early requirement.', decision: 'requirement',
          reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'Bash' } },
      ]);
      const store = createApprovalRuleStore({ ownerId: owner.ownerId, ownerDataDir, assertCurrent: () => {} });
      const saved = await store.applyManagedEdit(0, scope, [group], [], undefined, true);
      const artifact = path.join(ownerDataDir, 'command-approval-runtime', 'revisions', String(saved.revision), 'snapshot.json');
      const bytes = await fs.readFile(artifact);
      const nativeEntered = deferred<void>();
      const nativeResult = deferred<unknown>();
      const reviewer = vi.fn(async () => ({ verdict: 'allow' as const }));
      let early: PersonalTurnObservation | undefined;
      const h = await startSession('auto', { reviewer,
        nativeRules: async () => { nativeEntered.resolve(); return nativeResult.promise; },
        observe: async request => {
          const session = { id: request.sessionId, instanceId: request.sessionInstanceId!, agentKind: 'claude-code',
            workDir: request.workingDir, remoteHostId: null, agentDeviceId: null, getStatus: () => 'active' };
          return createClaudeLiveUserRulesImporter({ captureOwner: () => owner, ownerCurrent: () => true,
            listSessions: () => [session], readSessionRow: async () => ({ status: 'active', source: 'desktop', agentKind: 'cc',
              workingDir: request.workingDir, title: 'fixture', userSendAt: 1, workspaceKind: 'project', providerId: null,
              remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, clearedAt: null }),
          })({ ...request, onManagedObservation: value => { early = value; request.onManagedObservation?.(value); } });
        }, interactionResolver: async () => {
          await fs.writeFile(artifact, bytes);
          const known = { id: 'known', original: 'Explicit recovered pwd deny', decision: 'deny' as const,
            matcher: { kind: 'cc-command' as const, mode: 'exact' as const, pattern: 'pwd' }, tool: { domain: 'exec' as const, name: 'Bash' } };
          await store.applyManagedEdit(saved.revision, scope, [{ ...group, clauses: [...group.clauses, known] }], [], undefined, true);
          return { kind: 'permission', behavior: 'allow' };
        },
      });
      try {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
        const sending = h.handle.send({ type: 'user', content: 'Report pwd.' });
        await nativeEntered.promise;
        expect(early?.readManaged).toBeTypeOf('function');
        await vi.advanceTimersByTimeAsync(1001);
        await sending;
        vi.useRealTimers();
        if (fault === 'catch') await fs.writeFile(artifact, '{');
        else {
          const foreign = normalizeRuleGroup(group.origin, { ...scope, executionHostId: 'other-host' }, group.clauses);
          await fs.writeFile(artifact, JSON.stringify({ ...saved, groups: [foreign],
            managedOverrides: [{ id: foreign.id, revision: saved.revision, scope: foreign.scope }] }));
        }
        expect(await early?.revalidate()).toBe(true);
        expect(await early?.readManaged?.()).toMatchObject({ kind: 'unavailable',
          reason: fault === 'catch' ? 'managed-storage-unavailable' : 'host-identity-conflict' });
        expect(await registeredPwd(h, 'early-storage-pwd')).toContainEqual(route('ask'));
        const result = await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'early-storage-pwd' });
        expect(result.behavior).toBe('deny'); // Fault-card allow cannot erase the recovered known deny.
        expect(result).not.toHaveProperty('updatedPermissions');
        expect(h.seen).toHaveLength(1);
        expect(h.seen[0]).toMatchObject({ kind: 'permission', metadata: { autoReviewUnavailable: true } });
        expect(h.seen[0]?.kind === 'permission' && h.seen[0].autoCommand).toBeUndefined();
        expect(reviewer).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); nativeResult.resolve({}); await h.handle.close(); }
    },
  );

});
