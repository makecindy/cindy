/** Integration: shared startup -> real SQLite -> real script child -> durable run.
 * No Electron, account credential, external channel, or model call is involved.
 * Queue/model-boundary behavior is exercised separately by input-queue.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configureHostOwner } from '../src/agent/claude-auth.mjs';
import { hostRuntimeLayout } from '../src/runtime-layout.mjs';
import { openOwnerDatabase } from '../../desktop/src/main/localDb/startupCore.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { createSchedulerHost } from '../../desktop/src/main/scheduler-host/index.ts';
import { DrizzleScheduleStorage } from '../../desktop/src/main/scheduler-host/storage.ts';
import { MakerScheduleRunner } from '../../desktop/src/main/scheduler-host/runner.ts';
import { ScriptScheduleRunner } from '../../desktop/src/main/scheduler-host/script-runner.ts';
import { SchedulerScriptCapabilityBroker } from '../../desktop/src/main/scheduler-host/script-capability-broker.ts';
import { isManagedScheduledTarget } from '../../desktop/src/main/scheduler-host/restore-target.ts';

const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-scheduler-e2e-')));
const inherited = process.env.XDT_OFFICIAL_SHARED_PROFILE;
delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
const ownerId = 'scheduler-fixture-owner';
let database, host;
const unexpected = () => { throw new Error('This script fixture must not access a desktop or external service'); };
const quote = value => process.platform === 'win32' ? `"${value.replaceAll('"', '""')}"`
  : `'${value.replaceAll("'", "'\\''")}'`;
try {
  configureHostOwner({ userDataDir: profile, ownerId });
  const layout = hostRuntimeLayout();
  const opened = await openOwnerDatabase({ userDataDir: profile, ownerId, isPackaged: false,
    drizzleDir: layout.drizzleDir, sqliteVecExtPath: layout.sqliteVecPath });
  database = createDbClientForHandle({ db: opened.db, drizzle: opened.drizzle, dispose: async () => opened.db.close() });
  setCurrentDbClient(database, ownerId);
  const file = path.join(profile, 'automation.mjs');
  await fs.writeFile(file, `
import readline from 'node:readline';
const protocol = 'cindy-script/1';
const send = value => process.stdout.write(JSON.stringify({ protocol, ...value }) + '\\n');
send({ type: 'call', id: 'blocked', method: 'jira.get', params: { issue_key: 'TEST-1' } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.id !== 'blocked') return;
  if (frame.type !== 'call_result' || frame.ok !== false || frame.error?.code !== 'CAPABILITY_DENIED') process.exit(2);
  send({ type: 'complete', resultText: 'script completed; capability guard retained' });
  process.exit(0);
});
`);
  const notices = [];
  const create = () => createSchedulerHost({
    createStorage: getDb => new DrizzleScheduleStorage(getDb, unexpected),
    createRunners(deps) {
      const notifier = { notify: async (_schedule, run) => { notices.push(run); } };
      return {
        notifier,
        // A script run must never enter the Agent runner or any of its ports.
        promptRunner: new MakerScheduleRunner({ ...deps, notifier }, {}),
        scriptRunner: new ScriptScheduleRunner({ ...deps, notifier,
          broker: new SchedulerScriptCapabilityBroker({}, {
            findTrustedXdGhostForScript: unexpected, getGhostCardService: unexpected,
            getGhostPipeDispatcher: unexpected, tryGetOrcaCollabService: unexpected,
            getSessionRowSnapshotStrict: unexpected, restoreArchivedSessionForSend: unexpected,
          }),
        }, { isManagedScheduledTarget, restoreScheduledTarget: unexpected }),
      };
    },
    isPassive: () => false, dialogueWorkspaceRoots: () => [], onStarted() {}, async beforeReset() {},
  });
  const deps = { maker: {}, getDb: () => database.drizzle, logger: {} };
  host = create();
  const scheduler = await host.startScheduler(deps);
  const schedule = await scheduler.create({ name: 'Fixture automation', prompt: '', kind: 'cron',
    cronExpr: '0 9 * * *', timezone: 'UTC', recurring: true, manual: true,
    agentKind: 'codex', workingDir: profile, useWorktree: false, executionMode: 'script',
    scriptConfig: { command: `${quote(process.execPath)} ${quote(file)}`, capabilities: [] },
    notify: { desktop: true, feishu: false },
  });
  const { runId } = await scheduler.runNow(schedule.id);
  const runs = await host.getScheduleStorage().listRuns(schedule.id, 10);
  assert.equal(runs.find(run => run.id === runId)?.status, 'success', JSON.stringify(runs));
  assert.match(runs[0].resultText, /capability guard retained/);
  assert.equal(notices.length, 1);
  await host.resetScheduler();
  assert.equal(host.getSchedulerIfInitialized(), null);
  host = create();
  await host.startScheduler(deps);
  assert.equal((await host.getScheduleStorage().get(schedule.id)).id, schedule.id);
  assert.equal((await host.getScheduleStorage().listRuns(schedule.id, 10)).length, 1);
  assert.equal(notices.length, 1, 'restart must not replay the completed manual run');
  console.log('PASS shared scheduler: real script process, capability denial, SQLite run history, stop and restart without replay');
} finally {
  await host?.resetScheduler();
  if (database) { clearCurrentDbClient(database); await database.dispose(); }
  configureHostOwner({ userDataDir: profile, ownerId: null });
  await fs.rm(profile, { recursive: true, force: true });
  if (inherited === undefined) delete process.env.XDT_OFFICIAL_SHARED_PROFILE;
  else process.env.XDT_OFFICIAL_SHARED_PROFILE = inherited;
}
