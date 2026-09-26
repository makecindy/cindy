import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it('restores human authorization for both live and cold internal delegated sends', () => {
  for(const target of ['live','session']) {
    const start=source.lastIndexOf(`sendUserMessageWithAwaitedGitBaseline(${target}, message, clientId, {`);
    expect(start).toBeGreaterThan(0);
    const options=source.slice(start,source.indexOf('onAccepted: persistUserMessage',start));
    expect(options).toContain('params.autoReviewUserText');
    expect(options).toContain('[AUTO_REVIEW_SOURCE_CONTENT]:');
    expect(options).toContain('restoreAutoReviewUserIntent(await readAutoReviewHistory(targetSessionId))');
  }
});

it('marks plugin dispatch and every queue fallback with the host-only receipt', () => {
  const start = source.indexOf('async function sendToSessionInternal(params: {');
  const end = source.indexOf('const startOrcaTeamForCaller', start);
  const dispatch = source.slice(start, end);
  expect(dispatch).toContain("message: text, autoReviewUserText: { kind: 'delegated-continuation' }, forceQueue: true");
  const queues = [...dispatch.matchAll(/await enqueueSendToSessionMessage\(\{([\s\S]*?)\}\);/g)];
  expect(queues).toHaveLength(4);
  for (const call of queues) expect(call[1]).toContain('autoReviewUserText: params.autoReviewUserText');
  // Both newly created and resumed direct tasks persist the same authored metadata.
  expect(dispatch.match(/agentMeta: inputAgentMeta/g)).toHaveLength(2);
});

it('keeps empty receipts distinct from missing authorship on direct persistence', () => {
  const start = source.indexOf('const inputAgentMeta: AgentMeta');
  const end = source.indexOf('    if (!message)', start);
  expect(start).toBeGreaterThan(0);
  const build = new Function('params', 'queuedOrigin', compile(source.slice(start, end) + '\nreturn inputAgentMeta;'));
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, undefined)).toEqual({ autoReviewUserText: { kind: 'delegated-continuation' }, delivery: 'turn' });
  expect(build({}, undefined)).toBeUndefined();
  expect(build({ autoReviewUserText: { kind: 'delegated-continuation' } }, { kind: 'orca' })).toMatchObject({ origin: { kind: 'orca' }, autoReviewUserText: { kind: 'delegated-continuation' } });
});

it('builds a durable queued plugin input without promoting plugin text to user intent', async () => {
  const start = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const end = source.indexOf('  const orcaInterAgentDispatcher:', start);
  expect(start).toBeGreaterThan(0);
  const createOpts = { model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' };
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode,
    );
  const base = { targetSessionId: 'lead', clientId: 'plugin-input', message: 'Plugin instructions', persistedContent: 'Plugin instructions', meta: {} };
  const queued = JSON.parse(JSON.stringify(await build({ ...base, autoReviewUserText: { kind: 'delegated-continuation' } })));
  expect(queued).toMatchObject({ text: base.message, persistedContent: base.persistedContent, autoReviewUserText: { kind: 'delegated-continuation' }, permissionMode: 'auto' });
  expect(await build(base)).not.toHaveProperty('autoReviewUserText');
});

it.each(['empty', 'user', 'worker', 'reserved', 'unavailable'])('seals initial plans against persisted activity: %s', async state => {
  const start = source.indexOf('assertTeamPlanUnstarted: async taskId => {');
  const end = source.indexOf('\n      createSession:', start);
  const property = source.slice(start, end).trim().replace(/,$/, '');
  const tables = ['messages', 'orcaWorkers', 'orcaTeams', 'orcaWorkerCreationReservations'];
  const records = Object.fromEntries(tables.map(name => [name, { name }]));
  let drained = false;
  const snapshot = { client: { drizzle: { select: () => {
    let table: {name: string};
    const query = {
      from(value: {name: string}) { table = value; return query; },
      innerJoin() { return query; }, where() { return query; },
      async limit() {
        expect(drained).toBe(true);
        if (state === 'unavailable') throw new Error('unavailable');
        const populated = { user: 'messages', worker: 'orcaWorkers', reserved: 'orcaWorkerCreationReservations' }[state];
        return table.name === populated ? [{ id: 'existing' }] : [];
      },
    };
    return query;
  } } } };
  class PlanError extends Error { constructor(code: string) { super(code); } }
  const check = new Function('snapshot', 'assertCurrent', 'drainPersistQueue', 'PluginTaskError', 'eq', 'and', 'gte', ...tables,
    compile(`return ({${property}}).assertTeamPlanUnstarted;`))(
    snapshot, vi.fn(), async () => { drained = true; }, PlanError, vi.fn(), vi.fn(), vi.fn(), ...tables.map(t => records[t]),
  );
  if (state === 'empty') await expect(check('task')).resolves.toBeUndefined();
  else await expect(check('task')).rejects.toThrow(state === 'unavailable' ? 'unavailable' : 'TASK_BUSY');
});

it('aborts both internal delegated entry points when authorization history cannot be read', async () => {
  for (const target of ['live', 'session']) {
    const start = source.lastIndexOf(`sendUserMessageWithAwaitedGitBaseline(${target}, message, clientId, {`);
    const options = source.slice(start, source.indexOf('onAccepted: persistUserMessage', start));
    const expression = options.slice(options.indexOf('restoreAutoReviewUserIntent('), options.indexOf('),', options.indexOf('restoreAutoReviewUserIntent(')) + 1);
    const evaluate = new Function('readAutoReviewHistory', 'restoreAutoReviewUserIntent', 'targetSessionId', `return (async () => ${expression})();`);
    const restore = vi.fn();
    await expect(evaluate(async () => { throw new Error('unavailable'); }, restore, 'task')).rejects.toThrow('unavailable');
    expect(restore).not.toHaveBeenCalled();
  }
});
