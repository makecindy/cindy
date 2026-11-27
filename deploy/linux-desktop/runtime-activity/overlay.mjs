import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { addImports } from '../overlay-imports.mjs';

const virtualId = 'virtual:cindy-cloud-task-activity';
const bootstrap = 'apps/desktop/src/main/bootstrap-electron.ts';
const status = 'apps/desktop/src/main/instance-runtime/status.ts';
const register = 'apps/desktop/src/main/maker-ipc/register.ts';
const coordinator = 'apps/desktop/src/main/maker-ipc/agent-input-coordinator.ts';
export const targets = [bootstrap, status, register, coordinator];

const once = (code, before, after) => {
  assert.equal(code.split(before).length, 2, `Cloud activity integration changed: ${before.slice(0, 90)}`);
  return code.replace(before, after);
};

export function transformCloudActivitySource(code, relative) {
  if (!targets.includes(relative)) return null;
  assert.ok(!code.includes('/* cloud-task-activity */'), 'Cloud activity overlay applied twice');
  if (relative === bootstrap) {
    code = addImports(code, relative, [
      `import { cloudActivitySources, configureCloudActivity, readSchedulerActivity } from '${virtualId}';`,
      "import { readCloudInputActivity } from './maker-ipc/register.js';",
      "import { getCurrentDbClientSnapshot as cloudActivityDbSnapshot } from './localDb/client/current.js';",
      "import { isHumanDesktopInputActive, isAgentDesktopInputActive } from './remote-desktop/inputOwnership.js';",
    ]);
    code = once(code, '      registerRelaunchBusyActivityIpc(readRelaunchActivitySources, {',
      '      registerRelaunchBusyActivityIpc(cloudActivitySources(readRelaunchActivitySources), {');
    code = once(code, '    const stopStatus = startInstanceStatus(', `    configureCloudActivity({
      readContext: () => {
        const database = cloudActivityDbSnapshot();
        const owner = getActiveAppSession();
        return {
          ready: !isAppSessionBoundaryPending() && owner.dataOwnerId === instance.membershipId
            && database?.userId === instance.membershipId && Object.values(readInstanceReadiness()).every(Boolean),
          owner: JSON.stringify([owner.generation, database?.clientEpoch, instance.deviceId]),
        };
      },
      readInput: readCloudInputActivity,
      remoteInvokeBusy: () => hasInFlightRemoteInvokes() || isHumanDesktopInputActive() || isAgentDesktopInputActive(),
      readScheduler: () => readSchedulerActivity(getSchedulerIfInitialized, getScheduleStorageIfInitialized),
    });
    const stopStatus = startInstanceStatus(`);
  } else if (relative === status) {
    // Keep the existing builder (identity/readiness/oauth/stopping) unchanged.
    const ast = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true);
    const matches = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name?.text === 'startInstanceStatus');
    assert.equal(matches.length, 1, 'Cloud status writer signature changed');
    const method = matches[0];
    assert.deepEqual(method.parameters.map(p => p.name.getText(ast)), ['config', 'read', 'onFailure', 'readOauthIdentity', 'readAuthRecovery']);
    assert.ok(method.body && method.body.getText(ast).includes('write(true)'), 'Cloud status shutdown changed');
    const offset = method.body.getStart(ast), end = method.body.end;
    code = addImports(`${code.slice(0, offset)}{\n  return startCloudStatus({ config, read, onFailure, readOauthIdentity, readAuthRecovery, build: buildInstanceStatus });\n}${code.slice(end)}`,
      relative, [`import { startCloudStatus } from '${virtualId}';`]);
  } else if (relative === coordinator) {
    code = once(code, '  collectQueuedPayloadTexts(): string[] {', `  readCloudInputCounts() {
    let active = 0, queued = 0, interactions = 0;
    let settling = this.queueRestorePromises.size + this.pendingAutoResumeRecoveries.size;
    for (const state of this.states.values()) {
      active += Number(state.activeTurn !== null);
      // A queue held after a restart never sends without the owner; it stays in the durable
      // snapshot across a maintenance restart, so it is not work that maintenance must wait for.
      queued += (state.queuePausedByRestore && state.activeTurn === null ? 0 : state.pendingQueue.length)
        + state.pendingCompacts.length + state.directSteeringItems.length;
      interactions += state.queueInteractionLocks.length;
      settling += Number(state.queueAbortPending) + Number(state.drainScheduled)
        + Number(state.autoResumePending !== null) + Number(state.pendingExternalTerminalDone);
    }
    for (const requests of this.steerRequestLineages.values())
      for (const request of requests.values()) settling += request.unsettledTokens.size;
    return { active, queued, interactions, settling };
  }

  collectQueuedPayloadTexts(): string[] {`);
  } else if (relative === register) {
    code = once(code, 'export function collectAgentInputQueueScanTexts(): string[] {', `export function readCloudInputActivity() {
  if (!agentInputCoordinatorHolder) throw new Error('cloud input coordinator not ready');
  const counts = agentInputCoordinatorHolder.readCloudInputCounts();
  return { ...counts, interactions: counts.interactions + pendingInteractionResolvers.size,
    settling: counts.settling + pendingSchedulerAutoResumeRunBySession.size };
}

export function collectAgentInputQueueScanTexts(): string[] {`);
  }
  return `/* cloud-task-activity */\n${code}`;
}

export function cloudTaskActivityPlugin({ sourceRoot, onTransform = () => {} }) {
  assert.ok(path.isAbsolute(sourceRoot));
  const seen = new Set();
  const publisher = fs.readFileSync(new URL('./publisher.mjs', import.meta.url), 'utf8')
    .replace("'./activity.mjs'", JSON.stringify(fileURLToPath(new URL('./activity.mjs', import.meta.url))));
  return {
    name: 'cindy-cloud-task-activity', enforce: 'pre',
    resolveId(id) { return id === virtualId ? '\0' + virtualId : null; },
    load(id) { return id === '\0' + virtualId ? publisher : null; },
    transform(code, id) {
      const relative = path.relative(sourceRoot, id.split('?')[0]).split(path.sep).join('/');
      const transformed = transformCloudActivitySource(code, relative);
      if (transformed === null) return null;
      seen.add(relative); onTransform({ relativePath: relative });
      return { code: transformed, map: null };
    },
    buildEnd(error) {
      if (error) return;
      assert.deepEqual([...seen].sort(), [...targets].sort(), 'Cloud activity did not reach every source');
    },
  };
}
