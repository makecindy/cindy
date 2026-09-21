import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { CindyMakeHistoryStore } from '../historyStore';

const dirs: string[] = [];
it('reloads one scrubbed active output line, supports older records, and omits terminal output', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-build-output-'));
  dirs.push(dir);
  const store = new CindyMakeHistoryStore(dir);
  store.saveBuild({
    status: 'checking',
    outputLine: 'Checking token=fake-secret; /Users/private/file.ts\nDone',
  });
  expect(new CindyMakeHistoryStore(dir).readBuild()?.outputLine).toBe(
    'Checking token=[REDACTED]; <path> Done',
  );
  store.saveBuild({ status: 'ready', outputLine: 'Previous output' });
  expect(store.readBuild()).toEqual({ status: 'ready' });
  store.saveBuild({ status: 'checking' });
  expect(store.readBuild()).toEqual({ status: 'checking' });
});
it('retains the merge task and stage history after restart while rejecting invalid task identities', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-merge-link-'));
  dirs.push(dir);
  const store = new CindyMakeHistoryStore(dir);
  const state = {
    status: 'failed' as const,
    error: 'interrupted' as const,
    buildId: 'build',
    mergeSessionId: 'merge-task',
    logs: [
      { step: 'resolving-conflicts' as const, at: 100 },
      { step: 'failed' as const, at: 200 },
    ],
  };
  store.saveBuild(state);
  expect(new CindyMakeHistoryStore(dir).readBuild()).toEqual(state);
  store.saveBuild({ ...state, mergeSessionId: '../unrelated' });
  expect(store.readBuild()?.mergeSessionId).toBeUndefined();
});
it('retains a sanitized build diagnostic across store reloads and tolerates old receipts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-build-diagnostic-'));
  dirs.push(dir);
  const store = new CindyMakeHistoryStore(dir);
  store.saveBuild({
    status: 'failed',
    error: 'buildFailed',
    diagnostic: {
      kind: 'process',
      exitCode: 1,
      message: 'Error: token=fake-secret; failed at /Users/private/source',
    },
  });
  expect(new CindyMakeHistoryStore(dir).readBuild()?.diagnostic).toEqual({
    kind: 'process',
    exitCode: 1,
    message: 'Error: token=[REDACTED]; failed at <path>',
  });
  store.saveBuild({ status: 'failed', error: 'buildFailed' });
  expect(store.readBuild()).toEqual({ status: 'failed', error: 'buildFailed' });
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
it('preserves real checking stages and known failures while filtering private or unknown values', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-build-progress-'));
  dirs.push(dir);
  const store = new CindyMakeHistoryStore(dir);
  for (const checkStep of ['dependencies', 'tests', 'types'] as const) {
    store.saveBuild({ status: 'checking', checkStep });
    expect(store.readBuild()).toEqual({ status: 'checking', checkStep });
  }
  for (const mergeStep of ['conflicts', 'cleanup'] as const) {
    store.saveBuild({ status: 'merging', mergeStep });
    expect(new CindyMakeHistoryStore(dir).readBuild()).toEqual({ status: 'merging', mergeStep });
  }
  store.saveBuild({ status: 'merging', mergeStep: 'private-output' as never });
  expect(store.readBuild()).toEqual({ status: 'merging' });
  for (const error of ['checksFailed', 'missingShell', 'baselineChanged', 'interrupted'] as const) {
    store.saveBuild({ status: 'failed', error });
    expect(store.readBuild()).toEqual({ status: 'failed', error });
  }
  for (const status of ['checking', 'failed']) {
    writeFileSync(
      path.join(dir, 'build-state.json'),
      JSON.stringify({ status, checkStep: 'private process output', error: 'private error' }),
    );
    expect(store.readBuild()).toEqual(
      status === 'checking' ? { status } : { status, error: 'buildFailed' },
    );
  }
  store.saveBuild({ status: 'checking' });
  expect(store.readBuild()).toEqual({ status: 'checking' });
});
it('keeps only bounded known build log entries and preparation stages', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-build-log-'));
  dirs.push(dir);
  const store = new CindyMakeHistoryStore(dir);
  store.saveBuild({
    status: 'waiting',
    preparationStep: 'environment',
    logs: [
      { step: 'environment', at: 1 },
      { step: 'private-output' as never, at: 2 },
      { step: 'ready', at: Number.NaN },
      ...Array.from({ length: 90 }, (_, index) => ({ step: 'packaging' as const, at: index + 3 })),
    ],
  });
  const build = store.readBuild();
  expect(build?.preparationStep).toBe('environment');
  expect(build?.logs).toHaveLength(80);
  expect(build?.logs?.every((entry) => entry.step === 'packaging')).toBe(true);
});
it('keeps ended history, deduplicates operation receipts, and does not confuse build state with a task record', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-history-store-'));
  dirs.push(dir);
  const store = new CindyMakeHistoryStore(dir);
  const record = {
    runId: 'aaaa',
    sessionId: 'session',
    title: 'Feature',
    request: 'Change theme',
    createdAt: 1,
    updatedAt: 1,
  };
  store.seed(record);
  const receipt = {
    id: 'operation',
    action: 'integrate' as const,
    at: 3,
    baselineCommit: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    beforeTree: 'c'.repeat(40),
    tree: 'd'.repeat(40),
    taskTree: 'e'.repeat(40),
  };
  store.receipt('aaaa', receipt);
  store.receipt('aaaa', receipt);
  store.completion('aaaa', {
    id: 'turn',
    reportedAt: 2,
    commit: 'f'.repeat(40),
    tree: 'e'.repeat(40),
  });
  store.end('aaaa', 4);
  store.hide('aaaa', 5);
  store.seed({ ...record, endedAt: 99 });
  writeFileSync(path.join(dir, 'build-state.json'), JSON.stringify({ status: 'ready' }));
  store.saveBuild({ status: 'ready', commit: 'b'.repeat(40), generatedAt: 4 });
  expect(store.readBuild()).toEqual({ status: 'ready', commit: 'b'.repeat(40), generatedAt: 4 });
  writeFileSync(
    path.join(dir, 'build-state.json'),
    JSON.stringify({
      status: 'ready',
      commit: 'b'.repeat(40),
      unrelatedPrivateField: 'must stay on disk',
    }),
  );
  expect(store.readBuild()).toEqual({ status: 'ready', commit: 'b'.repeat(40) });
  const restored = new CindyMakeHistoryStore(dir).list();
  expect(restored).toHaveLength(1);
  const file = path.join(dir, 'records', 'aaaa.json');
  renameSync(file, file + '.bak');
  expect(new CindyMakeHistoryStore(dir).list()).toEqual(restored);
  expect(restored[0]).toMatchObject({
    endedAt: 4,
    hiddenAt: 5,
    updatedAt: 5,
    receipts: [receipt],
    completions: [{ id: 'turn' }],
  });
});
it('keeps owners separate and refuses corrupt existing history instead of overwriting it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'make-history-owners-'));
  dirs.push(dir);
  const first = new CindyMakeHistoryStore(path.join(dir, 'first'));
  const second = new CindyMakeHistoryStore(path.join(dir, 'second'));
  first.seed({
    runId: 'aaaa',
    sessionId: 'session',
    title: 'Private',
    request: 'request',
    createdAt: 1,
    updatedAt: 1,
  });
  expect(second.list()).toEqual([]);
  writeFileSync(path.join(dir, 'first', 'records', 'aaaa.json'), '{bad');
  expect(() => first.list()).toThrow();
  expect(() =>
    first.seed({
      runId: 'aaaa',
      sessionId: 'session',
      title: 'Overwrite',
      request: '',
      createdAt: 1,
      updatedAt: 1,
    }),
  ).toThrow();
});
