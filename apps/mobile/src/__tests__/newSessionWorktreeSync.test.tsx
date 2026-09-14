// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remoteSessionStore, useRemoteNewMakerWorktreePreference } from '@/session/remoteSessionStore';
import {
  applyWorktreePreferenceOnHost, classifyWorktreePreferenceSeed, isWorktreeChannelNotAllowedError,
  shouldBlockNewSessionCreateForWorktree, worktreeEligibilityCaptionKey,
  type NewSessionWorktreeEligibility,
} from '@/session/newSessionWorktree';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';

// Exercise the page's actual hooks and both entry guards. Extract AST statements
// (as in newSessionWorkspaceEffects), avoiding a parallel implementation of the gates.
const source = ts.createSourceFile('new.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/new.tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const page = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'NewRemoteSessionScreen');
if (!page?.body) throw new Error('NewRemoteSessionScreen not found');
function names(node: ts.Node): Set<string> {
  const found = new Set<string>();
  function visit(child: ts.Node) {
    if (ts.isIdentifier(child)) found.add(child.text);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
const declarations = new Set([
  'worktreePreference', 'worktreeChoicesRef', 'setWorktreeChoiceVersion', 'worktreeEnabled',
  'worktreeEnabledRef', 'worktreeSeedSeqRef', 'worktreeSeedRetryNonce',
  'worktreePreferenceSyncKeyRef', 'worktreePreferenceWriteSeqRef',
  'worktreePreferenceWriteTargetRef', 'worktreePreferenceSavingDeviceId',
  'worktreePreferenceTransactionRef', 'worktreePreferenceRenderedRef',
  'worktreePreferenceAuthorityUnknownByDeviceRef', 'setWorktreePreferenceAuthorityVersion',
  'worktreePreferenceSaving', 'worktreePreferenceSyncKey', 'worktreePreferenceAuthorityUnknown',
  'worktreeApplicable', 'worktreeToggleDisabled', 'worktreeCreateBlocked', 'worktreeCaptionKey',
  'worktreeControlCaptionKey', 'resolveWorktreeCreateErrorKey',
  'captureWorktreeCreateIntent', 'isWorktreeCreateIntentCurrent', 'worktreeSeedAgentKindRef',
  'worktreeHostSupportsRecoveryKeyDiscardRef', 'worktreePreferenceAwaitingEcho', 'toggleWorktree',
]);
const hooks = page.body.statements.filter((statement) => {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(
    (declaration) => [...names(declaration.name)].some((name) => declarations.has(name)),
  );
  if (!ts.isExpressionStatement(statement)) return false;
  const expr = statement.expression;
  if (ts.isBinaryExpression(expr)) return [
    'worktreeEnabledRef.current', 'worktreePreferenceSyncKeyRef.current',
    'worktreeSeedAgentKindRef.current', 'worktreeHostSupportsRecoveryKeyDiscardRef.current',
  ].includes(expr.left.getText(source));
  if (!ts.isCallExpression(expr) || !['useEffect', 'useLayoutEffect'].includes(expr.expression.getText(source))) return false;
  const ids = names(statement);
  return ids.has('worktreeSeedSeqRef') || ids.has('worktreePreferenceAuthorityUnknownByDeviceRef')
    || ids.has('worktreePreferenceRenderedRef');
});
for (const name of declarations) {
  if (!hooks.some((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some(
    (declaration) => names(declaration.name).has(name),
  ))) throw new Error(`Missing page worktree declaration: ${name}`);
}
function entryGuards(name: string): string {
  const statement = page!.body!.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((decl) => decl.name.getText(source) === name)) as ts.VariableStatement;
  const call = statement.declarationList.declarations[0].initializer as ts.CallExpression;
  const callback = call.arguments[0] as ts.ArrowFunction;
  const body = callback.body as ts.Block;
  const end = body.statements.findIndex((node) => ts.isExpressionStatement(node)
    && node.expression.getText(source) === 'creatingRef.current = true');
  if (end < 0) throw new Error(`Missing create boundary: ${name}`);
  const guards = body.statements.slice(0, end).filter((node) =>
    [...names(node)].some((id) => /^(worktree|captureWorktree|isWorktree)/.test(id)));
  if (!guards.some((node) => names(node).has('worktreeIntent'))) throw new Error(`Missing intent: ${name}`);
  return `function ${name}() { ${guards.map((node) => node.getText(source)).join('\n')} return worktreeIntent; }`;
}
const bindingsNames = [
  'useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useCallback',
  'remoteSessionStore', 'useRemoteNewMakerWorktreePreference', 'applyWorktreePreferenceOnHost',
  'classifyWorktreePreferenceSeed', 'isWorktreeChannelNotAllowedError', 'withTransientRemoteRetry',
  'shouldBlockNewSessionCreateForWorktree', 'worktreeEligibilityCaptionKey',
  'selectedDeviceId', 'connectionEpoch', 'presenceVersion', 'deviceLinkStatus', 'deviceLinkStatusRef',
  'creating', 'creatingRef', 'draft', 'maker', 'openLink', 'worktreeEligibility',
  'worktreeHostSupportsRecoveryKeyDiscard', 'worktreeBranchPreferenceSaving',
  'worktreeBranchPreferenceReady', 'worktreeBranchPreferenceReadyKeyRef',
  'worktreeBranchPreferenceError', 'worktreeBranchPreferenceKey', 'worktreeBranchPreferenceSyncKey',
  'worktreeBranchPreferenceSyncKeyRef', 'worktreeBranchPreferenceWriteTargetRef',
  'worktreeBranchPreferenceTransactionRef', 'worktreeBranchTargetRef',
  'worktreeEligibilityRef', 'worktreeSourceBranchRef', 't', 'setError', 'setGoalError',
];
const compiled = ts.transpileModule(`function usePageWorktree(bindings) {
  const { ${bindingsNames.join(', ')} } = bindings;
  ${hooks.map((node) => node.getText(source)).join('\n')}
  ${entryGuards('create')}
  ${entryGuards('createGoalSession')}
  return { worktreeEnabled, worktreeCreateBlocked, worktreeToggleDisabled,
    worktreePreferenceSaving, worktreePreferenceAuthorityUnknown,
    toggleWorktree, create, createGoalSession, isWorktreeCreateIntentCurrent };
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
interface Intent { enabled: boolean; sourceBranch: string; target: { deviceId: string } }
interface State {
  worktreeEnabled: boolean;
  worktreeCreateBlocked: boolean;
  worktreeToggleDisabled: boolean;
  worktreePreferenceSaving: boolean;
  worktreePreferenceAuthorityUnknown: boolean;
  toggleWorktree(): void;
  create(): Intent | undefined;
  createGoalSession(): Intent | undefined;
  isWorktreeCreateIntentCurrent(intent: Intent): boolean;
}
const usePageWorktree = new Function(`${compiled}; return usePageWorktree;`)() as
  (bindings: Record<string, unknown>) => State;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; vi.useRealTimers(); });
let deviceSequence = 0;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(remembered?: boolean) {
  const deviceId = `worktree-sync-${++deviceSequence}`;
  if (remembered !== undefined) remoteSessionStore.setNewMakerWorktreePreference(deviceId, remembered);
  const read = deferred<{ worktreeEnabled?: boolean }>();
  const write = deferred<void>();
  const eligibility: NewSessionWorktreeEligibility = { status: 'eligible', baseRepo: '/repo', sourceBranch: 'main' };
  const bindings = {
    useState, useRef, useEffect, useLayoutEffect, useCallback,
    remoteSessionStore, useRemoteNewMakerWorktreePreference, applyWorktreePreferenceOnHost,
    classifyWorktreePreferenceSeed, isWorktreeChannelNotAllowedError, withTransientRemoteRetry,
    shouldBlockNewSessionCreateForWorktree, worktreeEligibilityCaptionKey,
    selectedDeviceId: deviceId, connectionEpoch: 1, presenceVersion: 1,
    deviceLinkStatus: 'online', deviceLinkStatusRef: { current: 'online' },
    creating: false, creatingRef: { current: false },
    draft: { workspaceKind: 'project', workingDir: '/repo', agentKind: 'codex' },
    maker: { getNewMakerDefaults: vi.fn(() => read.promise), applyNewMakerWorktreePref: vi.fn(() => write.promise) },
    openLink: vi.fn(async () => {}), worktreeEligibility: eligibility as NewSessionWorktreeEligibility,
    worktreeHostSupportsRecoveryKeyDiscard: true,
    worktreeBranchPreferenceSaving: false, worktreeBranchPreferenceError: false,
    worktreeBranchPreferenceReady: true,
    worktreeBranchPreferenceReadyKeyRef: { current: 'branch-generation' as string | null },
    worktreeBranchPreferenceKey: `${deviceId}\0/repo`, worktreeBranchPreferenceSyncKey: 'branch-generation',
    worktreeBranchPreferenceSyncKeyRef: { current: 'branch-generation' },
    worktreeBranchPreferenceWriteTargetRef: { current: null as string | null },
    worktreeBranchPreferenceTransactionRef: { current: null },
    worktreeBranchTargetRef: { current: { deviceId, workingDir: '/repo' } },
    worktreeEligibilityRef: { current: eligibility as NewSessionWorktreeEligibility }, worktreeSourceBranchRef: { current: 'main' },
    t: (key: string) => key, setError: vi.fn(), setGoalError: vi.fn(),
  };
  let state!: State;
  function Harness() { state = usePageWorktree(bindings); return null; }
  root = createRoot(document.createElement('div'));
  const render = () => act(() => root!.render(createElement(Harness)));
  render();
  return { bindings, read, write, render, deviceId, get state() { return state; } };
}

for (const entry of ['create', 'createGoalSession'] as const) {
  describe(entry, () => {
    it.each([undefined, false, true])('uses displayed value %s without waiting for defaults', async (remembered) => {
      const h = mount(remembered);
      await act(async () => {});
      expect(h.bindings.maker.getNewMakerDefaults).toHaveBeenCalledWith('codex');
      expect(h.state.worktreeCreateBlocked).toBe(false);
      expect(h.state.worktreeToggleDisabled).toBe(false);
      expect(h.state[entry]()).toMatchObject({ enabled: remembered ?? false, sourceBranch: 'main' });
      await act(async () => { h.read.resolve({}); });
      expect(h.state[entry]()).toMatchObject({ enabled: remembered ?? false });
    });

    it('uses a same-tick explicit toggle while saving, and ignores a late opposite default', async () => {
      const h = mount(false);
      let intent!: Intent;
      act(() => { h.state.toggleWorktree(); intent = h.state[entry]()!; });
      expect(intent.enabled).toBe(true);
      expect(h.bindings.maker.applyNewMakerWorktreePref).toHaveBeenCalledWith(true);
      expect(h.state.worktreePreferenceSaving).toBe(true);
      expect(h.state.worktreeCreateBlocked).toBe(false);
      await act(async () => {
        h.read.resolve({ worktreeEnabled: false });
        remoteSessionStore.setNewMakerWorktreePreference(h.deviceId, false);
      });
      expect(h.state.worktreeEnabled).toBe(true);
      expect(h.state.isWorktreeCreateIntentCurrent(intent)).toBe(true);
      expect(h.state[entry]()?.enabled).toBe(true);
      await act(async () => { h.write.reject(new Error('timeout')); });
      expect(h.state.worktreePreferenceAuthorityUnknown).toBe(true);
      expect(h.state[entry]()?.enabled).toBe(true);
      expect(h.state.worktreeToggleDisabled).toBe(false);
    });

    it('can turn a remembered ON value off and immediately send despite failed detection', () => {
      const h = mount(true);
      h.bindings.worktreeEligibility = { status: 'detect-failed' };
      h.bindings.worktreeEligibilityRef.current = h.bindings.worktreeEligibility;
      h.render();
      expect(h.state.worktreeCreateBlocked).toBe(true);
      let intent: Intent | undefined;
      act(() => { h.state.toggleWorktree(); intent = h.state[entry](); });
      expect(intent?.enabled).toBe(false);
    });

    it('freezes submission while allowing untouched defaults to refresh for the next attempt', async () => {
      const h = mount(false);
      const intent = h.state[entry]()!;
      await act(async () => { h.read.resolve({ worktreeEnabled: true }); });
      expect(h.state.worktreeEnabled).toBe(true);
      expect(intent.enabled).toBe(false);
      expect(h.state.isWorktreeCreateIntentCurrent(intent)).toBe(true);
      expect(h.state[entry]()?.enabled).toBe(true);
    });

    it('waits for the source branch after project selection or reconnect, but OFF remains usable', () => {
      const h = mount(true);
      h.bindings.worktreeBranchPreferenceReady = false;
      h.bindings.worktreeBranchPreferenceReadyKeyRef.current = null;
      h.render();
      expect(h.state.worktreeCreateBlocked).toBe(true);
      expect(h.state[entry]()).toBeUndefined();
      h.bindings.worktreeBranchPreferenceError = true;
      h.render();
      expect(h.state[entry]()).toBeUndefined();
      expect(entry === 'create' ? h.bindings.setError : h.bindings.setGoalError)
        .toHaveBeenLastCalledWith('session.new.worktreeBranchSyncFailed');
      let intent: Intent | undefined;
      act(() => { h.state.toggleWorktree(); intent = h.state[entry](); });
      expect(intent?.enabled).toBe(false);
    });

    it('captures the confirmed host branch instead of the temporary detected branch', () => {
      const h = mount(true);
      h.bindings.worktreeBranchPreferenceReady = false;
      h.bindings.worktreeBranchPreferenceReadyKeyRef.current = null;
      h.render();
      expect(h.state[entry]()).toBeUndefined();
      h.bindings.worktreeSourceBranchRef.current = 'release';
      h.bindings.worktreeBranchPreferenceReady = true;
      h.bindings.worktreeBranchPreferenceReadyKeyRef.current = 'branch-generation';
      h.render();
      expect(h.state[entry]()?.sourceBranch).toBe('release');
    });

    it('keeps genuine eligibility and explicit branch-write failures blocking an enabled worktree', () => {
      const h = mount(true);
      h.bindings.worktreeEligibility = { status: 'detect-failed' };
      h.bindings.worktreeEligibilityRef.current = h.bindings.worktreeEligibility;
      h.render();
      expect(h.state[entry]()).toBeUndefined();
      h.bindings.worktreeEligibility = { status: 'eligible', baseRepo: '/repo', sourceBranch: 'main' };
      h.bindings.worktreeEligibilityRef.current = h.bindings.worktreeEligibility;
      h.bindings.worktreeBranchPreferenceWriteTargetRef.current = h.bindings.worktreeBranchPreferenceKey;
      h.render();
      expect(h.state[entry]()).toBeUndefined();
    });
  });
}

it('bounds an accepted write with no persistence echo, without ever blocking send', async () => {
  vi.useFakeTimers();
  const h = mount(false);
  await act(async () => { h.state.toggleWorktree(); h.write.resolve(); });
  expect(h.state.worktreePreferenceSaving).toBe(true);
  expect(h.state.create()?.enabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(h.state.worktreePreferenceSaving).toBe(false);
  expect(h.state.worktreePreferenceAuthorityUnknown).toBe(true);
  expect(h.state.worktreeEnabled).toBe(true);
});

it('keeps remembered values usable after a read failure and reconnection', async () => {
  const h = mount(true);
  await act(async () => { h.read.reject(new Error('invalid defaults response')); });
  expect(h.state.create()?.enabled).toBe(true);
  h.bindings.connectionEpoch += 1;
  h.render();
  expect(h.state.createGoalSession()?.enabled).toBe(true);
});

it('does not leak an explicit choice to another device, or accept a changed creation target', async () => {
  const h = mount(false);
  act(() => h.state.toggleWorktree());
  const intent = h.state.create()!;
  h.bindings.selectedDeviceId = `other-${h.deviceId}`;
  h.bindings.worktreeBranchTargetRef.current = { deviceId: h.bindings.selectedDeviceId, workingDir: '/other' };
  h.render();
  expect(h.state.worktreeEnabled).toBe(false);
  expect(h.state.isWorktreeCreateIntentCurrent(intent)).toBe(false);
});

it('settles an authoritative echo that arrives before the apply response', async () => {
  const h = mount(false);
  act(() => h.state.toggleWorktree());
  await act(async () => { remoteSessionStore.setNewMakerWorktreePreference(h.deviceId, true); });
  await act(async () => { h.write.resolve(); });
  expect(h.state.worktreePreferenceSaving).toBe(false);
  expect(h.state.worktreePreferenceAuthorityUnknown).toBe(false);
});

it.each(['writing', 'reconciling'])('retains device A uncertainty when device B replaces a %s write', async (phase) => {
  const h = mount(false);
  act(() => h.state.toggleWorktree());
  if (phase === 'reconciling') await act(async () => { h.write.resolve(); });
  const secondWrite = deferred<void>();
  h.bindings.maker.applyNewMakerWorktreePref = vi.fn(() => secondWrite.promise);
  h.bindings.selectedDeviceId = `other-${h.deviceId}`;
  h.render();
  act(() => h.state.toggleWorktree());
  h.bindings.selectedDeviceId = h.deviceId;
  h.render();
  expect(h.state.worktreeEnabled).toBe(true);
  expect(h.state.worktreePreferenceAuthorityUnknown).toBe(true);
  expect(h.state.create()?.enabled).toBe(true);
  expect(h.state.createGoalSession()?.enabled).toBe(true);
  await act(async () => { h.write.resolve(); });
  expect(h.state.worktreePreferenceAuthorityUnknown).toBe(true);
  await act(async () => { remoteSessionStore.setNewMakerWorktreePreference(h.deviceId, true); });
  expect(h.state.worktreePreferenceAuthorityUnknown).toBe(false);
  expect(h.state.worktreeEnabled).toBe(true);
});
