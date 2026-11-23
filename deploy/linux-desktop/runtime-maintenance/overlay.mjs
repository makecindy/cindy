import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const virtualId = 'virtual:cindy-cloud-maintenance';
const bootstrap = 'apps/desktop/src/main/bootstrap-electron.ts';
const lifecycle = 'apps/desktop/src/main/lifecycle.ts';
/** Every branch where a quit step did not complete cleanly, with exact counts. */
const quitFaults = [
  ['log.warn(`sync disposer "${d.name}" returned a promise — not awaited`)', 1],
  ['log.error(`sync disposer "${d.name}" threw`, err)', 1],
  ['log.error(`async disposer "${d.name}" threw`, err)', 1],
  ['log.warn(`async disposers timed out after ${timeoutMs}ms — proceeding to post-async`)', 1],
  ['log.error(`post-async disposer "${d.name}" threw`, err)', 2],
  ['log.warn(`post-async disposer "${d.name}" timed out after ${timeoutMs}ms — continuing`)', 1],
  ["log.error('runQuitDisposers threw', err)", 1],
];
const quitCompleted = "      log.info('runQuitDisposers completed');\n      noteQuitDisposersCompleted();\n";
const entries = {
  // Owner credential handoff is a remote control operation. Count the whole
  // commit so maintenance cannot seal halfway through canonical persistence.
  'apps/desktop/src/main/authManager.ts': { recoverManagedInstanceLogin: ['remote-input', false] },
  'apps/desktop/src/main/maker-ipc/agent-input-coordinator.ts': {
    enqueue: ['agent-input', false], reserveNextInput: ['agent-input', false], compact: ['agent-input', false],
    steer: ['agent-input', false], steerControlInput: ['agent-input', false], retryLastError: ['agent-input', false],
    drain: ['agent-input', true], dispatchCompact: ['agent-input', true], performRetryLastError: ['agent-input', true],
  },
  'packages/maker-core/src/session.ts': {
    dispatchSend: ['agent-dispatch', false], compactSession: ['agent-dispatch', false],
    sendHostTurnContinuation: ['agent-dispatch', true],
    resumeBackgroundTask: ['agent-dispatch', false],
  },
  'packages/maker-scheduler/src/engine/scheduler.ts': {
    fireOne: ['scheduler', true], runNow: ['scheduler', false], tick: ['tick', true],
    create: ['scheduler', false], update: ['scheduler', false],
  },
  'apps/desktop/src/main/remote-desktop/inputHost.ts': { input: ['remote-input', true] },
  'apps/desktop/src/main/cindy-brain/cindySlot.ts': { handleModelRequest: ['plugin-result', false] },
  'apps/desktop/src/main/cindy-brain/pipeDispatcher.ts': { callGhostTool: ['plugin-work', true] },
  'apps/desktop/src/main/remote-desktop/inputOwnership.ts': { withAgentDesktopInput: ['remote-input', true] },
};
export const targets = [bootstrap, lifecycle, ...Object.keys(entries)];
function transformLifecycle(code) {
  for (const [call, count] of quitFaults) {
    assert.equal(code.split(call).length - 1, count, `Maintenance quit integration changed: ${call}`);
    code = code.split(call).join(`(cloudMaintenanceQuit.fault(), ${call})`);
  }
  assert.equal(code.split(quitCompleted).length, 2, 'Maintenance quit completion changed');
  code = code.replace(quitCompleted, `${quitCompleted}      cloudMaintenanceQuit.completed(reason);\n`);
  return `/* cloud-maintenance-v1 */\nimport { cloudMaintenanceQuit } from '${virtualId}';\n${code}`;
}
export function transformMaintenanceSource(code, relative) {
  if (!targets.includes(relative)) return null;
  assert.ok(!code.includes('/* cloud-maintenance-v1 */'), 'Maintenance overlay applied twice');
  if (relative === lifecycle) return transformLifecycle(code);
  if (relative === bootstrap) {
    const marker = '    const stopStatus = startInstanceStatus(';
    assert.equal(code.split(marker).length, 2, 'Maintenance activity integration changed');
    return `/* cloud-maintenance-v1 */\nimport { configureMaintenanceActivity } from '${virtualId}';\nimport { readMaintenanceActivity } from 'virtual:cindy-cloud-task-activity';\n`
      + code.replace(marker, `    configureMaintenanceActivity(readMaintenanceActivity);\n${marker}`);
  }
  if (relative === 'packages/maker-scheduler/src/engine/scheduler.ts') {
    // An unfinished Once claim computes no wake; the gate keeps an undefined wake unchanged.
    const anchor = '        next = unfinishedOnce ? undefined : computeNextFireAt(current, now);';
    assert.equal(code.split(anchor).length, 2, 'Maintenance schedule recovery integration changed');
    code = code.replace(anchor, `${anchor}\n        next = cloudMaintenance.restoreScheduleWake(current, next, now);`);
  }
  const required = entries[relative], found = new Set(), edits = [];
  const source = ts.createSourceFile(relative, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function walk(node) {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.body && node.name && required[node.name.getText(source)]) {
      const name = node.name.getText(source), [kind, existing] = required[name];
      assert.ok(!found.has(name), `Ambiguous maintenance method ${relative}:${name}`); found.add(name);
      const start = node.body.getStart(source) + 1, end = node.body.end - 1;
      const body = code.slice(start, end);
      const async = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
      edits.push({ start, end, text: kind === 'tick'
        ? `\nreturn cloudMaintenance.scan(async () => {${body}\n});\n`
        : kind === 'plugin-result'
        ? `\ntry { return await cloudMaintenance.run('plugin-work', async () => {${body}\n}, (payload as {kind?: unknown})?.kind === 'query_job'); } catch (error) { if ((error as {code?: string})?.code === 'CLOUD_MAINTENANCE_RETRY') return {ok:false,message:String(error)}; throw error; }\n`
        : `\nreturn cloudMaintenance.run('${kind}', ${async ? 'async ' : ''}() => {${body}\n}, ${existing});\n` });
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
  assert.deepEqual([...found].sort(), Object.keys(required).sort(), `Maintenance entry drift: ${relative}`);
  for (const edit of edits.sort((a,b) => b.start-a.start)) code = code.slice(0,edit.start) + edit.text + code.slice(edit.end);
  return `/* cloud-maintenance-v1 */\nimport { cloudMaintenance } from '${virtualId}';\n${code}`;
}
export function cloudMaintenancePlugin({ sourceRoot, expectedRegion, onTransform = () => {} }) {
  const seen = new Set();
  const host = fs.readFileSync(new URL('./host.mjs', import.meta.url), 'utf8')
    .replace("'./gate.mjs'", JSON.stringify(fileURLToPath(new URL('./gate.mjs', import.meta.url))));
  return {
    name: 'cindy-cloud-maintenance-v1', enforce: 'pre',
    configResolved(config) {
      assert.ok(['cn', 'global'].includes(expectedRegion), 'Cloud build must explicitly select its deployment region');
      assert.equal(config.define?.['import.meta.env.VITE_CINDY_AUTH_REGION'], JSON.stringify(expectedRegion),
        'Cloud main region must match the deployment endpoint manifest');
    },
    resolveId(id) { return id === virtualId ? '\0' + virtualId : null; },
    load(id) { return id === '\0' + virtualId ? host : null; },
    transform(code,id) {
      const relative = path.relative(sourceRoot, id.split('?')[0]).split(path.sep).join('/');
      const transformed = transformMaintenanceSource(code, relative);
      if (transformed === null) return null;
      seen.add(relative); onTransform({ relativePath: relative }); return { code: transformed, map: null };
    },
    buildEnd(error) { if (!error) assert.deepEqual([...seen].sort(), [...targets].sort(), 'Missing maintenance ingress'); },
  };
}
