import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRuleGroup } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize';
import { evaluateApprovalRules } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/evaluate';
import { parseApprovalRuleSnapshot } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/schema';
import { requirementsOrigin } from '../../../../../../packages/maker-core/src/agents/shared/approval-rules/requirements';
import { createApprovalRuleStore } from '../approval-rule-store';
import { createManagedBashDenyHooks, type ManagedBashDenyDeps, type ManagedBashSession } from '../claude-hooks/managed-bash-deny-hook';
import type { SessionRowSnapshot } from '../../localDb/ipc/sessions';
import { createManagedAutoReviewPrecheck } from '../managed-auto-review';
import { withAutoReviewContext, resolveAutoReviewDecision, type AutoReviewDelegate, type AutoReviewRequest, type ManagedAutoReviewFence } from '../../../../../../packages/maker-core/src/agents/shared/auto-review-decision';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-bash-hook-'));
  dirs.push(dir);
  const dbClient = {};
  let ownerGeneration = 'owner:1';
  let sessions: ManagedBashSession[];
  let readCount = 0;
  let onRead: { at: number; run: () => void | Promise<void> } | null = null;
  const session: ManagedBashSession = {
    id: 'task', instanceId: 'instance-1', requestSessionId: 'sdk-1', agentKind: 'claude-code',
    workDir: '/project', remoteHostId: null, agentDeviceId: null, autoReviewOwner: 'native',
    stablePermissionModeState: { mode: 'auto', generation: 1 },
    stablePlanModeState: { enabled: false, generation: 1 }, getStatus: () => 'active',
  };
  sessions = [session];
  let row: SessionRowSnapshot = { status: 'active', source: 'desktop', agentKind: 'cc',
    workingDir: '/project', title: 'Ordinary task', userSendAt: 1, workspaceKind: 'project',
    providerId: null, remoteHostId: null, agentDeviceId: null, orcaRole: null,
    orcaRemoteLead: null, clearedAt: null };
  const deps: ManagedBashDenyDeps = {
    captureOwner: () => ({ ownerId: 'owner', executionHostId: 'host', generation: ownerGeneration,
      dbClient, ownerDataDir: dir }),
    ownerCurrent: owner => owner.generation === ownerGeneration && owner.dbClient === dbClient,
    listSessions: () => sessions,
    readSessionRow: async () => { readCount++;
      if (onRead?.at === readCount) { const run = onRead.run; onRead = null; await run(); }
      return { ...row }; },
    canonicalWorkDir: async workDir => workDir,
  };
  const hook = createManagedBashDenyHooks(deps).PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error('managed Bash PreToolUse hook missing');
  const call = (command: string, extra: Record<string, unknown> = {}) => hook({
    hook_event_name: 'PreToolUse', session_id: 'sdk-1', tool_name: 'Bash',
    tool_input: { command }, ...extra,
  } as never, 'tool-1', { signal: new AbortController().signal } as never);
  const store = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: dir, assertCurrent: () => {} });
  const scope = { ownerId: 'owner', executionHostId: 'host', harnesses: ['claude-code'] as const };
  const group = normalizeRuleGroup({ harness: 'cindy', sourceId: 'exact-bash:git-push',
    locator: 'cindy://personal-approval/exact-bash/git-push', dialectVersion: '1',
    layer: 'user', decisionDomain: 'personal-approval' },
  { ...scope, harnesses: [...scope.harnesses] }, [{ id: 'git-push', original: 'Bash(git push)',
    decision: 'deny', matcher: { kind: 'cc-command', pattern: 'git push', mode: 'exact' },
    tool: { domain: 'exec', name: 'Bash' } }]);
  const publish = async (decision: 'deny' | 'allow' | 'ask' = 'deny', harness: 'claude-code' | 'pi' | 'codex' = 'claude-code', command = 'git push') => {
    const target = { ...scope, harnesses: [harness] };
    const current = await store.readSnapshot(target);
    const origin = harness === 'codex' ? { ...group.origin, sourceId: 'exact-codex-command:git-push',
      locator: 'cindy://personal-approval/exact-codex-command/git-push' } : group.origin;
    const chosen = normalizeRuleGroup(origin, target, group.clauses.map(clause =>
      ({ ...clause, decision, matcher: { kind: 'cc-command', mode: 'exact', pattern: command },
        tool: { domain: 'exec', name: harness === 'pi' ? 'bash' : harness === 'codex' ? 'exec' : 'Bash' } })));
    const saved = await store.applyManagedEdit(current.revision, target, [chosen]);
    await store.publish(saved.revision);
  };
  return { call, publish, session, store, scope, deps,
    setRow: (change: Partial<SessionRowSnapshot>) => { row = { ...row, ...change }; },
    replaceSession: () => { sessions = [{ ...session, instanceId: 'instance-2' }]; },
    changeOwner: () => { ownerGeneration = 'owner:2'; },
    onRead: (at: number, run: () => void | Promise<void>) => { onRead = { at, run }; },
  };
}

// Unit / final-review F1: real published store -> Host -> existing reviewer.
// Literal-only fixtures missed residual loss for an unsupported compound input;
// no shell parsing or program match is granted by forwarding its original text.
it.each(['pi', 'codex'] as const)('reviewer receives complex command residual through Main for %s', async harness => {
  const h = setup(); h.session.agentKind = harness; h.session.autoReviewOwner = 'cindy';
  const directory = fs.realpathSync.native(h.deps.captureOwner()!.ownerDataDir);
  h.session.workDir = directory; h.setRow({ agentKind: harness, workingDir: directory });
  const scope = { ...h.scope, harnesses: [harness] };
  const group = normalizeRuleGroup(requirementsOrigin('compound'), scope, [{ id: 'requirement',
    decision: 'requirement', original: '  完整规则 🧪\r\n不要执行危险命令  ', reason: 'user-authored-verbatim',
    tool: { domain: 'exec', name: harness === 'pi' ? 'bash' : 'exec' } }]);
  const saved = await h.store.applyManagedEdit(0, scope, [group]); await h.store.publish(saved.revision);
  const effective = await h.store.readSnapshot(scope);
  const command = harness === 'pi' ? 'pwd -L && printf done' : "/bin/bash -lc 'pwd -L && printf done'";
  expect(evaluateApprovalRules(effective, scope, command, harness)).toMatchObject({ status: 'uncovered', actionConstraint: 'unsupported-input' });
  const input = { command, cwd: directory };
  const request: AutoReviewRequest = { sessionId: 'task', agentKind: harness, model: 'm',
    userIntent: 'Show the working directory', workspaceRoots: [directory], platform: 'linux', action: { kind: 'exec', command },
    managedToolExecution: { sessionInstanceId: 'instance-1', toolName: harness === 'pi' ? 'bash' : 'exec', input,
      ...(harness === 'pi' ? { piExecution: { rpcId: 'compound', input, isCurrent: () => true, isAuto: () => true } }
        : { codexApproval: { threadId: 'thread', turnId: 'turn', itemId: 'item', hostGeneration: 1, inputGeneration: 1,
          directoryGeneration: 1, isCurrent: () => true } }) } };
  let reviewed: AutoReviewRequest | undefined;
  const review: AutoReviewDelegate = async prepared => { reviewed = prepared; return { verdict: 'block', reason: 'existing reviewer' }; };
  review.precheckManagedAction = createManagedAutoReviewPrecheck(h.deps);
  expect(await withAutoReviewContext(request, review, prepared => resolveAutoReviewDecision(prepared, review, true)))
    .toMatchObject({ verdict: 'block', reason: 'existing reviewer' });
  expect(reviewed?.personalRequirements?.groups).toEqual(effective.groups);
  expect(reviewed?.userIntent).toBe(request.userIntent);
});

// Host precheck + real store, including revision changes visible to its final fence.
it.each(['pi', 'codex'] as const)('consumes only the current exact cwd project delta for %s Auto', async harness => {
  const h = setup(); h.session.agentKind = harness; h.session.autoReviewOwner = 'cindy';
  h.session.workDir = fs.realpathSync.native(h.deps.captureOwner()!.ownerDataDir);
  const projectId = h.session.workDir;
  h.setRow({ agentKind: harness, workingDir: projectId }); await h.publish('deny', harness);
  const request: AutoReviewRequest = { sessionId: 'task', agentKind: harness, model: 'm', userIntent: '',
    workspaceRoots: [projectId], platform: 'linux', action: { kind: 'exec', command: 'git push' },
    managedToolExecution: { sessionInstanceId: 'instance-1', toolName: harness === 'pi' ? 'bash' : 'exec',
      input: { command: 'git push', cwd: projectId }, ...(harness === 'pi' ? { piExecution: { rpcId: 'host-pi-test',
        input: { command: 'git push', cwd: projectId }, isCurrent: () => true, isAuto: () => h.session.stablePermissionModeState?.mode === 'auto' } } : {}), ...(harness === 'codex' ? { codexApproval: {
        threadId: 'thread', turnId: 'turn', itemId: 'item', hostGeneration: 1, inputGeneration: 1,
        directoryGeneration: 1, isCurrent: () => true } } : {}) } };
  const check = () => createManagedAutoReviewPrecheck(h.deps)(request);
  const target = { ...h.scope, harnesses: [harness] };
  const user = (await h.store.readSnapshot(target)).groups[0]!;
  expect(await check()).toMatchObject({ kind: 'deny' });
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    const before = await h.store.readSnapshot(target);
    const project = normalizeRuleGroup(user.origin, { ...user.scope, projectId },
      user.clauses.map(clause => ({ ...clause, decision })));
    await h.store.applyManagedEdit(before.revision, project.scope, [project], [], undefined, true);
    const result = await check();
    expect(result).toMatchObject({ kind: decision === 'allow' ? 'clear' : decision });
    if (decision === 'allow') expect(result).toMatchObject({ personalRequirements: { groups: [expect.objectContaining({ id: project.id })] } });
    for (const mode of ['default', 'bypassPermissions']) {
      h.session.stablePermissionModeState = { mode, generation: 2 };
      const withdrawn = await check();
      if (harness === 'pi') {
        expect(withdrawn).toMatchObject({ kind: 'clear' });
        expect(withdrawn.kind !== 'unavailable' && withdrawn.isExecutionCurrent?.()).toBe(true);
        expect(withdrawn).not.toHaveProperty('personalRequirements');
        expect(withdrawn).not.toHaveProperty('revision');
      } else expect(withdrawn).toMatchObject({ kind: 'unavailable' });
    }
    h.session.stablePermissionModeState = { mode: 'auto', generation: 1 };
    if (decision === 'deny') {
      const snapshot = await h.store.readSnapshot(project.scope);
      await h.store.applyManagedEdit(snapshot.revision, project.scope, [], [project.id], undefined, true);
    }
  }
  expect(await check()).toMatchObject({ kind: 'deny', ruleId: user.id });
});

describe('published managed deny in local root Claude Auto PreToolUse', () => {
  // Unit regression from real revision56: the real store accepts the complete
  // neutral+known group, but the installed host hook skips multi-clause groups.
  // Existing single-exact tests do not exercise that permission boundary.
  it.each(['user', 'other-project', 'shared'] as const)('enforces whole-group known deny only in its scope (%s)', async scopeKind => {
    const h = setup(); h.session.autoReviewOwner = 'cindy';
    const scope = { ...h.scope, harnesses: scopeKind === 'shared' ? ['claude-code' as const, 'codex' as const, 'pi' as const] : [...h.scope.harnesses],
      ...(scopeKind === 'other-project' ? { projectId: '/other-project' } : {}) };
    const group = normalizeRuleGroup(requirementsOrigin('whole-group-deny'), scope, [
      { id: 'requirement', original: 'Read(private)\r\n  保留完整原文 🧪  ', decision: 'requirement',
        reason: 'user-authored-verbatim', tool: { domain: 'exec', ...(scopeKind === 'shared' ? {} : { name: 'Bash' as const }) } },
      { id: 'known', original: 'Bash(printf CINDY_REQ_KNOWN_DENY)', decision: 'deny',
        matcher: { kind: 'cc-command', mode: 'exact', pattern: 'printf CINDY_REQ_KNOWN_DENY' },
        tool: { domain: 'exec', ...(scopeKind === 'shared' ? {} : { name: 'Bash' as const }) } },
    ]);
    const saved = await h.store.applyManagedEdit(0, scope, [group], [], undefined, true);
    expect(saved.groups.find(value => value.id === group.id)?.clauses).toEqual(group.clauses);
    expect(h.store.getAppliedState().generatedRevision).toBe(saved.revision);
    const result = await h.call('printf CINDY_REQ_KNOWN_DENY');
    if (scopeKind === 'other-project') expect(result).toEqual({ continue: true });
    else expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  // Real hook/store: an exact cwd rule must mask only its own user source.
  it('does not expand arbitrary multi-clause Cindy groups into hook denies', async () => {
    const h = setup(); h.session.autoReviewOwner = 'cindy';
    const scope = { ...h.scope, harnesses: [...h.scope.harnesses] };
    const group = normalizeRuleGroup({ harness: 'cindy', sourceId: 'unqualified-residual',
      locator: 'cindy://personal-approval/unqualified-residual', dialectVersion: '1',
      layer: 'user', decisionDomain: 'personal-approval' }, scope, [
      { id: 'residual', original: 'Preserve this unresolved source.', decision: 'deny', reason: 'unverified syntax' },
      { id: 'known', original: 'Bash(printf CINDY_REQ_KNOWN_DENY)', decision: 'deny',
        matcher: { kind: 'cc-command', mode: 'exact', pattern: 'printf CINDY_REQ_KNOWN_DENY' },
        tool: { domain: 'exec', name: 'Bash' } },
    ]);
    await h.store.applyManagedEdit(0, scope, [group], [], undefined, true);
    expect(await h.call('printf CINDY_REQ_KNOWN_DENY')).toEqual({ continue: true });
  });

  it.each(['native', 'cindy'] as const)('restores user deny after removing the %s project exception', async owner => {
    const h = setup(); h.session.autoReviewOwner = owner; await h.publish();
    const previous = await h.store.readSnapshot({ ...h.scope, harnesses: [...h.scope.harnesses] });
    const user = previous.groups[0]!;
    const project = normalizeRuleGroup(user.origin, { ...user.scope, projectId: '/project' },
      user.clauses.map(clause => ({ ...clause, decision: 'allow' as const })));
    const saved = await h.store.applyManagedEdit(previous.revision, project.scope, [project], [], undefined, true);
    expect(await h.call('git push')).toEqual({ continue: true });
    await h.store.applyManagedEdit(saved.revision, project.scope, [], [project.id], undefined, true);
    expect(await h.call('git push')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
  // Unit regression: loopback-provider Auto uses Cindy review ownership. The
  // old native-only gate ignored its published deny; this calls the real hook.
  it.each(['native', 'cindy'] as const)('denies only the published exact Bash command for %s review', async reviewOwner => {
    const h = setup();
    h.session.autoReviewOwner = reviewOwner;
    expect(await h.call('git push')).toEqual({ continue: true });
    await h.publish();
    expect(await h.call('git push')).toMatchObject({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny',
    } });
    expect(await h.call('git status')).toEqual({ continue: true });
    expect(await h.call('git push && echo ok')).toEqual({ continue: true });
    expect(await h.call('git push', { agent_id: 'child-1' })).toEqual({ continue: true });
  });

  it.each([
    ['review', { source: 'review' }], ['bot', { source: 'bot' }],
    ['remote host', { remoteHostId: 'other-host' }],
    ['remote agent', { agentDeviceId: 'other-device' }],
  ] as const)('does not apply to %s task rows', async (_name, change) => {
    const h = setup(); await h.publish(); h.setRow(change);
    expect(await h.call('git push')).toMatchObject({ continue: true });
  });

  it.each([
    ['native', 'allow'], ['native', 'ask'], ['cindy', 'allow'], ['cindy', 'ask'],
  ] as const)('does not turn %s review with published %s into a hook permission decision', async (reviewOwner, decision) => {
    const h = setup(); await h.publish(decision);
    h.session.autoReviewOwner = reviewOwner;
    expect(await h.call('git push')).toEqual({ continue: true });
  });

  it('leaves non-Auto and unknown review ownership on their existing route', async () => {
    const h = setup(); await h.publish();
    for (const mode of ['default', 'bypassPermissions']) {
      h.session.stablePermissionModeState = { mode, generation: 2 };
      for (const owner of ['native', 'cindy'] as const) {
        h.session.autoReviewOwner = owner;
        expect(await h.call('git push')).toEqual({ continue: true });
      }
    }
    h.session.stablePermissionModeState = { mode: 'auto', generation: 3 };
    h.session.autoReviewOwner = 'unknown' as never;
    expect(await h.call('git push')).toEqual({ continue: true });
  });

  it.each([
    ['native', 'cindy'], ['cindy', 'native'],
  ] as const)('discards a captured %s review after it changes to %s during a row read', async (from, to) => {
    const h = setup(); await h.publish();
    h.session.autoReviewOwner = from;
    h.onRead(1, () => { h.session.autoReviewOwner = to; });
    expect(await h.call('git push')).toEqual({ continue: true });
  });

  it.each(['owner', 'session', 'mode'] as const)(
    'does not use a stale published deny after %s changes during an awaited row read', async change => {
      const h = setup(); await h.publish();
      h.onRead(2, () => {
        if (change === 'owner') h.changeOwner();
        else if (change === 'session') h.replaceSession();
        else h.session.stablePermissionModeState = { mode: 'auto', generation: 2 };
      });
      expect(await h.call('git push')).toMatchObject({ continue: true });
    },
  );

  it('does not deny after the task row changes at the final awaited read', async () => {
    const h = setup(); await h.publish();
    h.onRead(3, () => h.setRow({ source: 'review' }));
    expect(await h.call('git push')).toEqual({ continue: true });
  });

  it('does not use an older publication after a concurrent publish', async () => {
    const h = setup(); await h.publish();
    h.onRead(2, () => h.publish());
    expect(await h.call('git push')).toMatchObject({ continue: true });
  });
});

// Unit: real owner-bound store + shared context wrapper, with isolated files.
// Existing CC callback tests do not cover Pi scope, shell identity, or publication
// while an ordinary reviewer is pending. No native files/processes are used.
describe('published Pi managed deny at the Host review boundary', () => {
  function setupPi() {
    const h = setup();
    h.session.agentKind = 'pi'; h.session.autoReviewOwner = 'cindy';
    h.session.workDir = fs.realpathSync.native(h.deps.captureOwner()!.ownerDataDir);
    h.setRow({ agentKind: 'pi', workingDir: h.session.workDir });
    const request: AutoReviewRequest = { sessionId: 'task', agentKind: 'pi', model: 'm',
      userIntent: '', workspaceRoots: [h.session.workDir], platform: 'linux',
      action: { kind: 'exec', command: 'git push' },
      managedToolExecution: { sessionInstanceId: 'instance-1', toolName: 'bash', input: { command: 'git push' },
        piExecution: { rpcId: 'test-root', input: { command: 'git push' }, isCurrent: () => true, isAuto: () => h.session.stablePermissionModeState?.mode === 'auto' } } };
    const delegate: AutoReviewDelegate = async () => ({ verdict: 'allow' });
    delegate.precheckManagedAction = createManagedAutoReviewPrecheck(h.deps);
    const check = () => withAutoReviewContext(request, delegate,
      prepared => resolveAutoReviewDecision(prepared, delegate, true));
    return { ...h, request, delegate, check };
  }
  // Unit / Pi first-red C1: real published store bytes -> actual Main precheck
  // -> shared reviewer boundary. Existing pending-lease faults do not cover a
  // first read with corrupt JSON. This does not boot Main or claim root RPC/UI.
  it.each(['corrupt-artifact', 'unpublished'] as const)(
    'Pi requirements C1: first %s retains the storage-evidence distinction', async scenario => {
      const h = setupPi();
      h.request.action = { kind: 'exec', command: 'pwd' };
      h.request.managedToolExecution!.input = { command: 'pwd' };
      h.request.managedToolExecution!.piExecution!.input = { command: 'pwd' };
      let artifact: string | undefined;
      let bytes: Buffer | undefined;
      if (scenario === 'corrupt-artifact') {
        await h.publish('allow', 'pi', 'pwd');
        const healthy = await h.delegate.precheckManagedAction!(h.request);
        expect(healthy.kind).toBe('clear');
        if (healthy.kind === 'unavailable') throw new Error('Fixture execution was not qualified');
        expect(healthy.isExecutionCurrent?.()).toBe(true);
        const owner = h.deps.captureOwner()!;
        artifact = path.join(owner.ownerDataDir, 'command-approval-runtime', 'revisions',
          String(h.store.getAppliedState().generatedRevision), 'snapshot.json');
        bytes = fs.readFileSync(artifact);
        fs.writeFileSync(artifact, '{invalid JSON');
        expect(h.deps.ownerCurrent(owner)).toBe(true);
        // A real parser/readPublished catch, not a mock precheck throw.
        const reader = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: owner.ownerDataDir, assertCurrent: () => {},
          localManagedCommandHostId: 'host', resolveManagedConsumer: () => ({
            scope: { ...h.scope, harnesses: ['pi'], projectId: h.session.workDir }, sessionId: 'task', sessionInstanceId: 'instance-1' }) });
        await expect(reader.readPublishedManagedSnapshot()).rejects.toThrow(SyntaxError);
        const missing = await h.delegate.precheckManagedAction!(h.request);
        expect(missing.kind).toBe('unavailable');
        expect(healthy.isExecutionCurrent?.()).toBe(true);
      }
      let reviewCount = 0;
      const original = h.delegate;
      const review: AutoReviewDelegate = async request => { reviewCount++; return original(request); };
      review.precheckManagedAction = h.delegate.precheckManagedAction;
      try {
        const result = await withAutoReviewContext(h.request, review,
          prepared => resolveAutoReviewDecision(prepared, review));
        expect.soft(result).toMatchObject(scenario === 'unpublished'
          ? { verdict: 'allow' } : { verdict: 'ask', unavailable: true });
        expect(reviewCount).toBe(0);
      } finally {
        if (artifact && bytes) {
          fs.writeFileSync(artifact, bytes);
          expect(fs.readFileSync(artifact)).toEqual(bytes);
          expect(await h.delegate.precheckManagedAction!(h.request)).toMatchObject({ kind: 'clear' });
        }
      }
    },
  );

  it('checks fresh published Pi deny before local allow and removes it without residual cache', async () => {
    const h = setupPi();
    expect((await h.check()).verdict).toBe('allow');
    await h.publish(); // Old CC-only group is never a Pi rule.
    expect((await h.check()).verdict).toBe('allow');
    await h.publish('deny', 'pi');
    expect(await h.check()).toMatchObject({ verdict: 'block', reason: expect.stringContaining('personal rule') });
    const scope = { ...h.scope, harnesses: ['pi'] as ['pi'] };
    const snapshot = await h.store.readSnapshot(scope);
    const saved = await h.store.applyManagedEdit(snapshot.revision, scope, [], snapshot.groups.map(g => g.id));
    await h.store.publish(saved.revision);
    expect((await h.check()).verdict).toBe('allow');
  });
  it('enforces a deny published while an ordinary reviewer allow is pending', async () => {
    const h = setupPi();
    expect(await withAutoReviewContext(h.request, h.delegate, async () => {
      await h.publish('deny', 'pi'); return { verdict: 'allow' };
    })).toMatchObject({ verdict: 'block' });
  });
  // Unit: the post-confirmation continuation reads actual published bytes, not
  // the review-time revision. Pending human approval was absent from old tests.
  it('rechecks publication and execution after a human wait without another reviewer', async () => {
    const h = setupPi();
    let fence: ManagedAutoReviewFence | undefined;
    expect(await withAutoReviewContext(h.request, h.delegate, async () => ({ verdict: 'ask' }),
      decision => decision, captured => { fence = captured; })).toMatchObject({ verdict: 'ask' });
    expect(fence).toBeDefined();
    await h.publish('deny', 'pi');
    expect(await fence!()).toMatchObject({ verdict: 'block', reason: expect.stringContaining('personal rule') });
    const scope = { ...h.scope, harnesses: ['pi'] as ['pi'] };
    const snapshot = await h.store.readSnapshot(scope);
    const saved = await h.store.applyManagedEdit(snapshot.revision, scope, [], snapshot.groups.map(g => g.id));
    // Saving removal alone cannot override the already published deny.
    expect((await fence!()).verdict).toBe('block');
    await h.store.publish(saved.revision);
    expect((await fence!()).verdict).toBe('allow');
    h.changeOwner();
    expect(await fence!()).toMatchObject({ verdict: 'block' });
  });
  it('checks the task row after the final awaited authorization lookup', async () => {
    const h = setupPi();
    let lookups = 0;
    h.delegate.prepareRequest = async request => {
      if (++lookups === 2) h.setRow({ source: 'review' });
      return request;
    };
    expect(await h.check()).toMatchObject({ verdict: 'block' });
  });
  it.each(['powershell', 'mcp__shell__bash'])('does not reinterpret %s as builtin Bash', async toolName => {
    const h = setupPi(); await h.publish('deny', 'pi');
    h.request.managedToolExecution!.toolName = toolName;
    expect((await h.check()).verdict).toBe('allow');
  });
  it('uses original Bash input when credential classification changed exec into read', async () => {
    const h = setupPi(); await h.publish('deny', 'pi');
    h.request.action = { kind: 'read', path: '/project/private' };
    expect((await h.check()).verdict).toBe('block');
  });
  it.each(['owner', 'instance', 'mode', 'plan', 'project', 'host'] as const)('discards pending allow after %s changes', async change => {
    const h = setupPi();
    expect(await withAutoReviewContext(h.request, h.delegate, async () => {
      if (change === 'owner') h.changeOwner();
      else if (change === 'instance') h.replaceSession();
      else if (change === 'mode') h.session.stablePermissionModeState = { mode: 'auto', generation: 2 };
      else if (change === 'plan') h.session.stablePlanModeState = { enabled: true, generation: 2 };
      else if (change === 'project') h.setRow({ workingDir: '/other-project' });
      else h.session.remoteHostId = 'remote';
      return { verdict: 'allow' };
    })).toMatchObject({ verdict: 'block' });
  });
  it.each(['allow', 'ask'] as const)('consumes the explicit published %s under its current contract', async decision => {
    const h = setupPi(); await h.publish(decision, 'pi');
    expect((await h.check()).verdict).toBe(decision === 'ask' ? 'ask' : 'allow');
  });
  it('passes the matched complete Pi allow to the original reviewer without granting over its block', async () => {
    const h = setupPi(); await h.publish('allow', 'pi');
    let actual: AutoReviewRequest | undefined;
    expect(await withAutoReviewContext(h.request, h.delegate, async prepared => {
      actual = prepared; return { verdict: 'block', reason: 'original reviewer block' };
    })).toEqual({ verdict: 'block', reason: 'original reviewer block' });
    expect(actual?.userIntent).toBe(h.request.userIntent);
    expect(actual?.personalRequirements?.scope.harnesses).toEqual(['pi']);
    expect(actual?.personalRequirements?.groups).toHaveLength(1);
    expect(actual?.personalRequirements?.groups[0]?.clauses).toMatchObject([{ decision: 'allow', original: 'Bash(git push)' }]);
  });
  it.each([
    { source: 'bot' }, { source: 'review' }, { orcaRole: 'worker' },
    { remoteHostId: 'ssh' }, { agentDeviceId: 'other-device' },
  ] as const)('leaves ineligible Pi task $source$orcaRole$remoteHostId$agentDeviceId on ordinary review', async row => {
    const h = setupPi(); await h.publish('deny', 'pi');
    h.setRow(row);
    expect((await h.check()).verdict).toBe('allow');
  });
});

// Unit: actual owner-bound published store and Host precheck; a Codex approval
// must keep its own scope, cwd and native request identity, not borrow Pi/CC.
describe('Codex managed command Host qualification', () => {
  // Unit / Codex C1: real store and actual Main precheck -> shared. The
  // old exact healthy tests do not distinguish initial storage failure from no
  // rules. This stops at shared decision: no claim of actual Agent card delivery.
  it.each(['corrupt-artifact', 'unpublished'] as const)(
    'Codex requirements C1: initial %s preserves missing storage evidence', async scenario => {
      const h = setup(); h.session.agentKind = 'codex'; h.session.autoReviewOwner = 'cindy';
      const owner = h.deps.captureOwner()!;
      h.session.workDir = fs.realpathSync.native(owner.ownerDataDir);
      h.setRow({ agentKind: 'codex', workingDir: h.session.workDir });
      const scope = { ...h.scope, harnesses: ['codex'] as ['codex'], projectId: h.session.workDir };
      const request: AutoReviewRequest = { sessionId: 'task', agentKind: 'codex', model: 'm', userIntent: 'Show current directory',
        workspaceRoots: [h.session.workDir], platform: process.platform, action: { kind: 'exec', command: 'pwd', cwd: h.session.workDir },
        managedToolExecution: { sessionInstanceId: 'instance-1', toolName: 'exec', input: { command: 'pwd', cwd: h.session.workDir },
          codexApproval: { threadId: 'thread', turnId: 'turn', itemId: 'item', approvalId: 'approval',
            hostGeneration: 1, inputGeneration: 1, directoryGeneration: 1, isCurrent: () => true } } };
      const precheck = createManagedAutoReviewPrecheck(h.deps);
      let artifact: string | undefined; let bytes: Buffer | undefined;
      if (scenario === 'corrupt-artifact') {
        await h.publish('allow', 'codex', 'pwd');
        const healthy = await precheck(request);
        expect(healthy.kind).toBe('clear');
        if (healthy.kind === 'unavailable') throw new Error('Unqualified fixture before corruption');
        expect(healthy.isExecutionCurrent?.()).toBe(true);
        artifact = path.join(owner.ownerDataDir, 'command-approval-runtime', 'revisions',
          String(h.store.getAppliedState().generatedRevision), 'snapshot.json');
        bytes = fs.readFileSync(artifact); fs.writeFileSync(artifact, '{invalid JSON');
        const reader = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: owner.ownerDataDir, assertCurrent: () => {},
          localManagedCommandHostId: 'host', resolveManagedConsumer: () => ({ scope, sessionId: 'task', sessionInstanceId: 'instance-1' }) });
        await expect(reader.readPublishedManagedSnapshot()).rejects.toThrow(SyntaxError);
        expect(h.deps.ownerCurrent(owner)).toBe(true);
        expect(healthy.isExecutionCurrent?.()).toBe(true);
        expect((await precheck(request)).kind).toBe('unavailable');
      }
      let reviews = 0;
      const review: AutoReviewDelegate = async () => { reviews++; return { verdict: 'allow' }; };
      review.precheckManagedAction = precheck;
      try {
        const result = await withAutoReviewContext(request, review, data => resolveAutoReviewDecision(data, review));
        expect.soft(result).toMatchObject(scenario === 'unpublished' ? { verdict: 'allow' } : { verdict: 'ask', unavailable: true });
        expect(reviews).toBe(0);
      } finally {
        if (artifact && bytes) { fs.writeFileSync(artifact, bytes); expect(fs.readFileSync(artifact)).toEqual(bytes);
          expect((await precheck(request)).kind).toBe('clear'); }
      }
    });

  // Unit / wrapper boundary: a schema-valid legacy generic residual group is
  // not a future requirements namespace. Isolate the existing source-only
  // opaque matcher restriction without changing schema or shell interpretation.
  it('Codex requirements wrapper: exact raw known deny remains meaningful beside residual text', () => {
    const command = "/bin/bash -lc 'touch sentinel'";
    const scope = { ownerId: 'owner', executionHostId: 'host', harnesses: ['codex'] as ['codex'] };
    const group = normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'residual-component:wrapped',
      locator: 'cindy://component-fixture/wrapped', dialectVersion: '1', decisionDomain: 'personal-approval' }, scope,
      [{ id: 'text', original: '完整原文 🧪', decision: 'ask', reason: 'unresolved verbatim', tool: { domain: 'exec', name: 'exec' } },
        { id: 'known', original: 'exec(' + command + ')', decision: 'deny', tool: { domain: 'exec', name: 'exec' },
          matcher: { kind: 'cc-command', mode: 'exact', pattern: command } }]);
    const snapshot = parseApprovalRuleSnapshot({ schemaVersion: 1, revision: 1, groups: [group], tombstones: [] });
    expect(evaluateApprovalRules(snapshot, scope, command, 'codex').status).toBe('uncovered');
    const trusted = normalizeRuleGroup(requirementsOrigin('wrapped-codex'), scope, [
      { id: 'requirement', original: '完整原文 🧪', decision: 'requirement', reason: 'user-authored-verbatim', tool: { domain: 'exec', name: 'exec' } },
      group.clauses[1]!]);
    const effective = parseApprovalRuleSnapshot({ schemaVersion: 1, revision: 1, groups: [trusted], tombstones: [] });
    expect(evaluateApprovalRules(effective, scope, command, 'codex')).toMatchObject({ status: 'matched', decision: 'deny' });
    expect(evaluateApprovalRules(effective, scope, 'touch sentinel', 'codex').status).not.toBe('matched');
    expect(evaluateApprovalRules(effective, scope, command.replace('sentinel', 'other'), 'codex').status).not.toBe('matched');
    expect(evaluateApprovalRules(snapshot, scope, 'touch sentinel', 'codex').status).not.toBe('matched');
    expect(evaluateApprovalRules(snapshot, scope, command.replace('sentinel', 'other'), 'codex').status).not.toBe('matched');
  });

  // Native app-server command is opaque: only the same full string can consume the stored rule.
  it.each(['deny', 'ask', 'allow'] as const)('consumes the exact native wrapped command for %s', async decision => {
    const h = setup(); h.session.agentKind = 'codex'; h.session.autoReviewOwner = 'cindy';
    // Real dev/ino qualification requires an actual isolated cwd, not /project.
    h.session.workDir = fs.realpathSync.native(h.deps.captureOwner()!.ownerDataDir);
    h.setRow({ agentKind: 'codex', workingDir: h.session.workDir });
    const command = "/bin/bash -lc 'touch /home/xd.guest/approval-test-work/CINDY_REMEMBER_TARGET_c20261026a'";
    await h.publish(decision, 'codex', command);
    const check = (value: string) => createManagedAutoReviewPrecheck(h.deps)({ sessionId: 'task', agentKind: 'codex',
      model: 'm', userIntent: '', workspaceRoots: [h.session.workDir], platform: 'linux', action: { kind: 'exec', command: value },
      managedToolExecution: { sessionInstanceId: 'instance-1', toolName: 'exec', input: { command: value, cwd: h.session.workDir },
        codexApproval: { threadId: 'thread', turnId: 'turn', itemId: 'item', hostGeneration: 1, inputGeneration: 1,
          directoryGeneration: 1, isCurrent: () => true } } });
    expect(await check(command)).toMatchObject(decision === 'allow'
      ? { kind: 'clear', personalRequirements: { groups: [expect.objectContaining({ clauses: [expect.objectContaining({ decision })] })] } }
      : { kind: decision });
    expect(await check(command.slice(15, -1))).toMatchObject({ kind: 'clear' });
    expect(await check(command.replace('c20261026a', 'other'))).toMatchObject({ kind: 'clear' });
    h.session.stablePermissionModeState = { mode: 'default', generation: 2 };
    expect(await check(command)).toMatchObject({ kind: 'unavailable' });
    h.session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 3 };
    expect(await check(command)).toMatchObject({ kind: 'unavailable' });
  });
  it.each(['deny', 'ask', 'allow', 'remove', 'cc-only', 'pi-only', 'default', 'full',
    'owner', 'row', 'cwd', 'approval', 'missing-envelope', 'lease-full', 'lease-owner-full'] as const)('reads real scoped effective bytes for %s', async scenario => {
    const h = setup(); h.session.agentKind = 'codex'; h.session.autoReviewOwner = 'cindy';
    // Real dev/ino qualification requires an actual isolated cwd, not /project.
    h.session.workDir = fs.realpathSync.native(h.deps.captureOwner()!.ownerDataDir);
    h.setRow({ agentKind: 'codex', workingDir: h.session.workDir });
    await h.publish(scenario === 'allow' ? 'allow' : scenario === 'ask' ? 'ask' : 'deny',
      scenario === 'cc-only' ? 'claude-code' : scenario === 'pi-only' ? 'pi' : 'codex');
    if (scenario === 'remove') {
      const scope = { ...h.scope, harnesses: ['codex'] as ['codex'] };
      const snapshot = await h.store.readSnapshot(scope);
      await h.store.applyManagedEdit(snapshot.revision, scope, [], snapshot.groups.map(g => g.id), undefined, true);
    }
    if (scenario === 'default' || scenario === 'full') h.session.stablePermissionModeState = { mode: scenario === 'default' ? 'default' : 'bypassPermissions', generation: 2 };
    if (scenario === 'owner') h.onRead(2, h.changeOwner);
    if (scenario === 'row') h.onRead(2, () => h.setRow({ source: 'review' }));
    const request: AutoReviewRequest = { sessionId: 'task', agentKind: 'codex', model: 'm', userIntent: '',
      workspaceRoots: [h.session.workDir], platform: 'linux', action: { kind: 'exec', command: 'git push' },
      managedToolExecution: { sessionInstanceId: 'instance-1', toolName: 'exec', input: {
        command: 'git push', cwd: scenario === 'cwd' ? '/elsewhere' : h.session.workDir },
        ...(scenario === 'missing-envelope' ? {} : { codexApproval: { threadId: 'thread', turnId: 'turn', itemId: 'item',
          hostGeneration: 1, inputGeneration: 1, directoryGeneration: 1, isCurrent: () => scenario !== 'approval' } }) } };
    const result = await createManagedAutoReviewPrecheck(h.deps)(request);
    if (scenario === 'lease-full' || scenario === 'lease-owner-full') {
      expect(result.kind).toBe('deny');
      h.session.stablePermissionModeState = { mode: 'bypassPermissions', generation: 2 };
      if (scenario === 'lease-owner-full') h.changeOwner();
      if (result.kind !== 'unavailable') {
        expect(result.isCurrent()).toBe(false);
        expect(result.isExecutionCurrent?.()).toBe(scenario === 'lease-full');
      }
    } else if (['default', 'full', 'owner', 'row', 'cwd', 'approval', 'missing-envelope'].includes(scenario)) expect(result.kind).toBe('unavailable');
    else if (scenario === 'allow') expect(result).toMatchObject({ kind: 'clear', personalRequirements: {
      scope: { harnesses: ['codex'] }, groups: [expect.objectContaining({ clauses: [expect.objectContaining({ decision: 'allow' })] })] } });
    else expect(result.kind).toBe(scenario === 'deny' || scenario === 'ask' ? scenario : 'clear');
  });
});
