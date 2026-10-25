import { taskStorageFixture, closeTaskStorageFixtures } from '../testing/task-storage.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { TerminalTaskStorage } from './storage.js';
import { TerminalOrcaStore } from './orca-store.js';
import { createSessionRouteLock } from '@cindy/app-runtime/sessionRouteLock';
import { createSessionRuntimeCleanup } from '@cindy/app-runtime/sessionRuntimeCleanup';
import { createSessionArchiveSync } from '@cindy/app-runtime/sessionArchiveSync';

// Integration: Node must use the original SQLite transactions. A failed remote
// worker INSERT must roll back its proxy and preserve the original open receipt;
// reopening must retain the Lead identity through original startup maintenance.
const roots: string[] = [], stores: TerminalOrcaStore[] = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await closeTaskStorageFixtures(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function createStore(root: string, tasks: TerminalTaskStorage) {
  const locks = createSessionRouteLock();
  const cleanup = createSessionRuntimeCleanup(createSessionArchiveSync().requestSessionArchiveSync);
  const store = new TerminalOrcaStore({ root, tasks, guard() {}, logger,
    withSessionRouteLock: locks.withSessionRouteLock,
    cleanupRuntime: cleanup.cleanupSessionRuntimeForTerminalStatus });
  stores.push(store); return store;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-orca-store-')); roots.push(root);
  const tasks = await taskStorageFixture(path.join(root, 'tasks'));
  const task = async (id: string) => tasks.create({ id, title: id, workDir: root, model: 'fixture-model', agentKind: 'codex', permissionMode: 'ask' });
  await task('lead');
  const store = createStore(root, tasks); await store.ready;
  const team = await store.createActiveTeam({ leadSessionId: 'lead' });
  await store.setSessionOrcaRole('lead', 'lead');
  return { root, tasks, task, store, team };
}
it('serializes original label and slot reservations until the worker task is archived', async () => {
  const { store, task, tasks, team } = await fixture();
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const lease = (id: string, label: string) => store.reserveWorkerCreation({ reservationId: id, teamId: team.id, label, hardLimit: 1, leaseMs: 100 });
  expect(await Promise.all([lease('first', 'Build'), lease('duplicate', 'BUILD'), lease('second', 'Review')])).toEqual([
    { ok: true, occupiedSlotsBefore: 0 }, { ok: false, errorCode: 'WORKER_CREATION_IN_PROGRESS' }, { ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' },
  ]);
  now += 101; expect(await store.renewWorkerCreationReservation('first', 100)).toBe(false);
  expect(await lease('second', 'Review')).toMatchObject({ ok: true });
  await store.releaseWorkerCreationReservation('second'); await task('worker');
  await store.addOrUpdateWorker({ id: 'worker-one', teamId: team.id, sessionId: 'worker', label: 'Build', status: 'done' });
  expect(await lease('third', 'Review')).toMatchObject({ errorCode: 'WORKER_LIMIT_HARD_EXCEEDED' });
  await tasks.update('worker', { archived: true });
  expect(await lease('third', 'Review')).toMatchObject({ ok: true });
  expect(await lease('fourth', 'BUILD')).toMatchObject({ errorCode: 'DUPLICATE_LABEL' });
});
it('rolls back remote creation atomically and restores committed team identity and remote release state', async () => {
  const { root, store, tasks, team } = await fixture();
  await store.saveRemoteWorkerOpen('device', 'remote-task');
  const input = { workerId: 'remote-worker', teamId: team.id, proxySessionId: 'proxy',
    deviceId: 'device', remoteSessionId: 'remote-task', label: 'Build', role: 'developer', proxySession: {
      title: 'Remote build', agentKind: 'cc' as const, model: 'haiku', effort: null, permissionMode: 'auto', fastMode: false,
    } };
  const sql = new Database((await tasks.database()).dbPath);
  sql.exec("CREATE TRIGGER reject_remote_worker BEFORE INSERT ON orca_workers BEGIN SELECT RAISE(ABORT, 'fixture remote worker write rejected'); END");
  try {
    await expect(store.addRemoteWorker(input)).rejects.toThrow('fixture remote worker write rejected');
    expect(await tasks.get('proxy')).toBeNull();
    expect(await store.listWorkersByLead('lead')).toEqual([]);
    expect(await store.listOrphanRemoteWorkerOpens()).toHaveLength(1);
  } finally { sql.exec('DROP TRIGGER reject_remote_worker'); sql.close(); }
  await store.addRemoteWorker(input);
  await store.close(); await closeTaskStorageFixtures();
  const reopenedTasks = await taskStorageFixture(path.join(root, 'tasks'));
  const reopened = createStore(root, reopenedTasks); await reopened.ready;
  expect(await reopenedTasks.get('lead')).toMatchObject({ orcaRole: 'lead' });
  expect(await reopened.listWorkersByLead('lead')).toMatchObject([{ id: 'remote-worker', sessionId: 'proxy', session: { agentKind: 'claude-code', title: 'Remote build' } }]);
  expect(await reopened.listOrphanRemoteWorkerOpens()).toEqual([]);
  expect((await reopenedTasks.list()).map(row => row.id).sort()).toEqual(['lead', 'proxy']);
  await reopened.saveWorkerRemoteReport('remote-worker', { clientIds: ['accepted-input'], baselineMessageId: null });
  await reopened.markTeamEnded(team.id, 'completed');
  expect(await reopened.listActiveRemoteWorkers()).toEqual([]);
  expect(await reopened.listUnreleasedEndedRemoteWorkers()).toMatchObject([{ pendingReport: { clientIds: ['accepted-input'] } }]);
  await reopened.removeWorker('remote-worker');
  expect(await reopenedTasks.get('proxy')).toMatchObject({ archived: true, orcaRole: null });
  expect(await reopened.getWorkerRemoteReleaseState('remote-worker')).toMatchObject({ removeAfterRelease: true, remoteReleasedAt: null });
  await reopened.markWorkerRemoteStopConfirmed('remote-worker', 123);
  await reopened.markWorkerRemoteReleased('remote-worker', 124);
  await reopened.removeWorker('remote-worker');
  expect(await reopened.getRemoteWorkerByProxySession('proxy')).toBeNull();
  expect(await reopenedTasks.get('proxy')).not.toBeNull();
});
it('keeps focus and done/idle acknowledgements atomic and archives an ended team through the original service', async () => {
  const { task, store, team, tasks } = await fixture();
  expect(await store.isOrphanedTeamInit(team.id)).toBe(false);
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  expect(await store.isOrphanedTeamInit(team.id)).toBe(true);
  await task('worker-a'); await task('worker-b');
  for (const suffix of ['a', 'b']) await store.addOrUpdateWorker({ id: suffix, teamId: team.id, sessionId: `worker-${suffix}`, label: suffix });
  await Promise.all([store.setWorkerFocus(team.id, 'a'), store.setWorkerFocus(team.id, 'b')]);
  expect((await store.listWorkersByLead('lead')).filter(row => row.focused).map(row => row.id)).toEqual(['b']);
  await store.updateWorkerStatus('a', 'done'); expect(await store.markWorkerIdleIfStatus('a', 'done')).toBe(true);
  await store.updateWorkerStatus('a', 'running'); expect(await store.restoreWorkerDoneIfIdle('a')).toBe(false);
  expect((await store.listWorkersByLead('lead')).find(row => row.id === 'a')).toMatchObject({ status: 'running', idleSince: null });
  await store.markTeamEnded(team.id, 'cancelled');
  await store.reconcileInactiveTeamWorkersForLead('lead');
  expect(await tasks.get('worker-a')).toMatchObject({ archived: true });
  expect(await store.getWorkerLink({ workerId: 'a' })).toMatchObject({ leadSessionId: 'lead', workerSessionId: 'worker-a' });
});
