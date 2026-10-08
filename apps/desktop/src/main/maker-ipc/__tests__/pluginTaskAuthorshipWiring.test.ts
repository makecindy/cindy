import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { appendAutoReviewUserIntent, AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, MAIN_OWNED_SEND_CONTEXT, type SendOptions } from '@cindy/maker-core';

const source = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

it.each(['Do not publish.', '', undefined])('keeps live authority through the final delegated steer boundary: %j', async previous => {
  const start = source.indexOf('await sess.steer(steerPayload as never, {');
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf('\n      });', start) + '\n      });'.length;
  const deliver = new Function('sess', 'steerPayload', 'so', 'meta', 'restoredSteerIntent',
    'MAIN_OWNED_SEND_CONTEXT', 'AUTO_REVIEW_SOURCE_CONTENT', 'AUTO_REVIEW_USER_INTENT', 'AUTO_REVIEW_DELEGATED_CONTINUATION',
    compile(`return (async () => { ${source.slice(start, end)} })();`));
  const invoke = async (delegated: boolean) => {
    let result;
    const steer = vi.fn(async (content: string, options: SendOptions) => {
      result = appendAutoReviewUserIntent(previous, content, options);
    });
    await deliver({ steer }, 'Publish now', { [AUTO_REVIEW_SOURCE_CONTENT]: '',
      ...(delegated ? { [AUTO_REVIEW_DELEGATED_CONTINUATION]: true } : {}) }, {}, 'Old persisted permission',
      MAIN_OWNED_SEND_CONTEXT, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION);
    expect(steer).toHaveBeenCalledOnce();
    return result;
  };
  expect(await invoke(true)).toEqual(previous ?? 'Old persisted permission');
  expect(await invoke(false)).toEqual('Old persisted permission');
});

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
  for (const call of queues) {
    expect(call[1]).toContain('autoReviewUserText: params.autoReviewUserText');
    // 插件来源随每个入队回退分支传递(含 queued-before-dispatch 竞态),排队项不丢插件身份。
    expect(call[1]).toMatch(/\bsourcePlugin\b/);
  }
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
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk', 'UI_ACTION_TRIGGER_PREFIX',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode, '[UI_ACTION_TRIGGER]',
    );
  const base = { targetSessionId: 'lead', clientId: 'plugin-input', message: 'Plugin instructions', persistedContent: 'Plugin instructions', meta: {} };
  const queued = JSON.parse(JSON.stringify(await build({ ...base, autoReviewUserText: { kind: 'delegated-continuation' } })));
  expect(queued).toMatchObject({ text: base.message, persistedContent: base.persistedContent, autoReviewUserText: { kind: 'delegated-continuation' }, permissionMode: 'auto' });
  expect(await build(base)).not.toHaveProperty('autoReviewUserText');
  expect(await build(base)).not.toHaveProperty('agentOmitsTriggerPrefix');
  // Plugin attribution travels on the queued item for the label and source note; it is not an origin.
  const fromPlugin = await build({ ...base, sourcePlugin: { pluginId: 'gh-1', name: 'Reviewer' } });
  expect(fromPlugin).toMatchObject({ sourcePlugin: { pluginId: 'gh-1', name: 'Reviewer' } });
  expect(fromPlugin).not.toHaveProperty('origin');
});

it('keeps host receipts hidden in the queue while the model text omits the trigger prefix', async () => {
  const start = source.indexOf('  async function buildSessionControlInputItem(params: {');
  const end = source.indexOf('  const orcaInterAgentDispatcher:', start);
  const createOpts = { model: 'm', effort: 'high', permissionMode: 'auto', workingDir: '/answer' };
  const build = new Function('buildCreateOptsForQueuedSession', 'permissionModeOrAsk', 'UI_ACTION_TRIGGER_PREFIX',
    compile(source.slice(start, end) + '\nreturn buildSessionControlInputItem;'))(
      vi.fn(async () => createOpts), (mode: string) => mode, '[UI_ACTION_TRIGGER]',
    );
  const receipt = '[任务回执] 后台任务已完成。task_id: d-1';
  const queued = await build({
    targetSessionId: 'lead', clientId: 'bot-delegation-completion:d-1', meta: {},
    message: receipt, persistedContent: `[UI_ACTION_TRIGGER]${receipt}`,
  });
  // Queue rows mask on `text`; the prefix stays there and is dropped at wire assembly.
  expect(queued).toMatchObject({ text: `[UI_ACTION_TRIGGER]${receipt}`, persistedContent: `[UI_ACTION_TRIGGER]${receipt}`, agentOmitsTriggerPrefix: true });
  // Ordinary prefixed synthetic input (continue prompts) is untouched.
  const continueItem = await build({
    targetSessionId: 'lead', clientId: 'c', meta: {},
    message: '[UI_ACTION_TRIGGER] continue', persistedContent: '[UI_ACTION_TRIGGER] continue',
  });
  expect(continueItem).not.toHaveProperty('agentOmitsTriggerPrefix');
});

it.each(['empty', 'user', 'worker', 'reserved', 'started', 'ended', 'unavailable'])('seals initial plans against persisted activity: %s', async state => {
  const start = source.indexOf('assertTeamPlanUnstarted: async taskId => {');
  const end = source.indexOf('\n      createSession:', start);
  const property = source.slice(start, end).trim().replace(/,$/, '');
  const tables = ['messages', 'sessions', 'orcaWorkers', 'orcaTeams', 'orcaWorkerCreationReservations'];
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
        if (table.name === 'sessions') {
          if (state === 'started') return [{ startedAt: 1, endedAt: null }];
          if (state === 'ended') return [{ startedAt: null, endedAt: 1 }];
          return [{ startedAt: null, endedAt: null }];
        }
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

it('shares the Lead send lock across whole plan registration and final Worker admission', () => {
  const registration = source.slice(source.indexOf("case 'setTeamPlan':"), source.indexOf("case 'releaseWorker':"));
  expect(registration).toContain('return withSendToSessionLock(request.taskId, async () => {');
  expect(registration.indexOf('await resolvePluginWorkerDirectory(')).toBeGreaterThan(registration.indexOf('withSendToSessionLock('));
  expect(registration.indexOf('return service.setTeamPlan(')).toBeGreaterThan(registration.indexOf('await resolvePluginWorkerDirectory('));
  expect(registration.trimEnd().endsWith('});')).toBe(true);
  const start=source.indexOf('const orcaWorkerCreationService = createOrcaWorkerCreationService({');
  const block=source.slice(start, source.indexOf('getLeadSessionRow:',start));
  expect(block).toContain('withLeadSendLock: withSendToSessionLock');
  expect(block.lastIndexOf('createPluginTaskStore(epoch.client).get')).toBeGreaterThan(block.indexOf('pluginTaskServiceForCurrentOwner!().get'));
});
