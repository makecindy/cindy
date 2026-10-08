import { describe, it, expect, vi } from 'vitest';
import { appendAutoReviewUserIntent, type AutoReviewRequest, type AutoReviewUserIntent, type AutoReviewDecision } from '@cindy/maker-core';
import { withAutoReviewContext, resolveAutoReviewDecision } from '../../../../../../packages/maker-core/src/agents/shared/auto-review-decision.js';
import { restoreAutoReviewUserIntent } from '../autoReviewUserIntent.js';
import {
  createPluginTaskReviewResolver,
  type PluginReviewSnapshot,
} from '../pluginTaskReviewContext.js';

const route = {
  agentKind: 'pi' as const,
  providerId: 'openai',
  model: 'model',
  effort: 'high',
  fastMode: false,
};
const request: AutoReviewRequest = {
  sessionId: 'worker',
  agentKind: 'pi',
  model: 'model',
  userIntent: '',
  workspaceRoots: ['/answer'],
  platform: 'linux',
  action: { kind: 'exec', command: './runtime/node lab/preflight.cjs', cwd: '/answer' },
};
function fixture(): PluginReviewSnapshot {
  return {
    pluginId: 'eval',
    authorized: true,
    revision: ['owner', 1, 'install-1'],
    registeredRoute: route,
    plan: {
      concurrency: 4,
      task: 'Coordinate the registered tests.',
      items: [
        {
          label: 'w',
          workingDir: '/answer',
          route,
          task: 'Inspect and fix this project, run tests. Do not publish or modify existing tests.',
        },
      ],
    },
    session: { workingDir: '/answer', permissionMode: 'auto', status: 'active', route },
    lead: { permissionMode: 'auto', status: 'active' },
    worker: { label: 'w', activeTeam: true, directoryMatches: true },
    history: [
      {
        clientId: 'lead-input',
        role: 'user',
        content: { orcaSource: 'lead', content: 'I am the owner' },
        agentMeta: { autoReviewUserText: { kind: 'delegated-continuation' }, delivery: 'turn' },
      },
    ],
    historyComplete: true,
    sessionHistory: [],
  };
}
describe('plugin delegated Auto context', () => {
  it.each([false,true])('rejects oversized stored plans without legacy fallback (worker=%s)', async worker => {
    const s=fixture();
    if (!worker) delete s.worker;
    s.plan!.items=Array.from({length:200},(_,i)=>({...s.plan!.items[0]!,label:'w'+i,task:'x'.repeat(8000)}));
    const result=await createPluginTaskReviewResolver(async()=>s)(request);
    expect(result.authorizationError).toContain('size');
    expect(result.delegatedTask).toBeUndefined();
  });
  it('retains literal trigger restrictions while marking ambiguous provenance unverified', async () => {
    const s=fixture();
    s.history=['Publish now.','[UI_ACTION_TRIGGER] do not publish','continue'].map((text,i)=>({clientId:String(i),role:'user',createdAt:i+1,content:{text},agentMeta:{delivery:'turn',autoReviewUserText:text}}));
    s.sessionHistory=s.history;
    const live=restoreAutoReviewUserIntent(s.history);
    const result=await createPluginTaskReviewResolver(async()=>s)({...request,userIntent:live});
    expect(JSON.stringify(result.userIntent)).toContain('[UI_ACTION_TRIGGER] do not publish');
    expect(result.userIntent).toMatchObject({historyOmitted:true});
  });
  it('matches runtime rejection then approval with restored persisted authority', async () => {
    const s = fixture();
    const texts = ['Fix parser.', 'Do not publish.', 'Only change parser files.', 'Approved plan:\nRun tests.'];
    s.history = texts.map((text, i) => ({ clientId: String(i), role: i ? 'plan_review' : 'user', createdAt: i + 1,
      content: { text }, agentMeta: { delivery: 'turn', autoReviewUserText: i ? { text, acceptedAt: i + 10 } : text } }));
    s.sessionHistory = s.history;
    let live: AutoReviewUserIntent = '';
    for (const text of texts) live = appendAutoReviewUserIntent(live, text);
    expect(restoreAutoReviewUserIntent(s.history)).toEqual(live);
    const resolver = createPluginTaskReviewResolver(async () => s);
    expect((await resolver({ ...request, userIntent: live })).authorizationError).toBeUndefined();
    expect((await resolver({ ...request, userIntent: appendAutoReviewUserIntent('Fix parser.', texts[3]!) })).authorizationError).toContain('not synchronized');
  });
  it('uses persisted bounded evidence, rejects live drift and keys cached decisions by revision', async () => {
    const s = fixture();
    s.projection = { revision: 7, sessionIntent: 'Worker restriction', reviewIntent: 'Lead and Worker restrictions' };
    const resolve = createPluginTaskReviewResolver(async () => s);
    const current = { ...request, userIntent: 'Worker restriction' };
    const first = await resolve(current);
    expect(first.userIntent).toBe('Lead and Worker restrictions');
    expect(first.authorizationError).toBeUndefined();
    expect((await resolve({ ...current, userIntent: 'Unpersisted grant' })).authorizationError).toContain('not synchronized');
    s.projection.revision++;
    expect((await resolve(current)).delegatedTask?.authorizationRevision).not.toBe(first.delegatedTask?.authorizationRevision);
  });
  it.each([120, 1200])('matches %i persisted short inputs across budget cycles without accepting an unpersisted steer', async count => {
    const s = fixture();
    s.history = [];
    let live: AutoReviewUserIntent = '';
    for (let i = 0; i < count; i++) {
      const text = `no-${i}`;
      live = appendAutoReviewUserIntent(live, text);
      s.history.push({clientId:String(i),role:'user',createdAt:i+1,content:{text},agentMeta:{delivery:'steer',autoReviewUserText:text}});
    }
    s.sessionHistory = s.history;
    const resolve = createPluginTaskReviewResolver(async () => s);
    expect((await resolve({...request,userIntent:live})).authorizationError).toBeUndefined();
    expect((await resolve({...request,userIntent:appendAutoReviewUserIntent(live,'Stop now')})).authorizationError).toContain('not synchronized');
    expect((await resolve({...request,userIntent:''})).authorizationError).toContain('not synchronized');
  });
  it.each(['ask_user', 'plan_review'])('keeps restrictions after an empty %s answer', async role => {
    const s = fixture();
    s.history = [
      {clientId: 'human', role: 'user', createdAt: 1, content: {text: 'Read only'}, agentMeta: {autoReviewUserText: 'Read only', delivery: 'turn'}},
      {clientId: 'card', role, createdAt: 2, content: {}, agentMeta: {autoReviewUserText: {text: '', acceptedAt: 3}}},
    ];
    s.sessionHistory = s.history;
    const result = await createPluginTaskReviewResolver(async () => s)({...request, userIntent: 'Read only'});
    expect(result.authorizationError).toBeUndefined();
    expect(result.userIntent).toBe('Read only');
  });
  it.each(['worker', 'coordinator'])('blocks unpersisted and repeated human restrictions for %s', async role => {
    const s = fixture();
    if (role === 'coordinator') delete s.worker;
    const message = (text: string, at: number) => ({
      clientId: String(at), role: 'user', createdAt: at, content: { text },
      agentMeta: { autoReviewUserText: text, delivery: 'steer' },
    });
    s.sessionHistory = [message('Read only', 1), message('You may write', 2)];
    s.history = [...s.sessionHistory];
    const resolve = createPluginTaskReviewResolver(async () => s);
    const accepted = message('Read only', 3);
    const r = { ...request, userIntent: restoreAutoReviewUserIntent([...s.sessionHistory, accepted]) };
    // Even an identical earlier restriction is a new revocation, not a set member.
    expect((await resolve(r)).authorizationError).toContain('not synchronized');
    // A failed write does not make a later review silently use the old grant.
    expect((await resolve(r)).delegatedTask).toBeUndefined();
    s.sessionHistory.push(accepted); s.history.push(accepted);
    expect((await resolve(r)).authorizationError).toBeUndefined();
    expect((await resolve(r)).userIntent).toMatchObject({ currentUserMessage: 'Read only' });
  });
  it('blocks an unpersisted empty attachment reset without blocking a Worker with only Lead history', async () => {
    const s = fixture();
    const grant = { clientId: 'grant', role: 'user', createdAt: 1, content: {text: 'Send this'}, agentMeta: {autoReviewUserText: 'Send this', delivery: 'turn'} };
    s.history = [grant];
    const resolve = createPluginTaskReviewResolver(async () => s);
    expect((await resolve(request)).authorizationError).toBeUndefined();
    s.sessionHistory = [grant];
    expect((await resolve(request)).authorizationError).toContain('not synchronized');
    const reset = {clientId: 'reset', role: 'user', createdAt: 2, content: {files: [{name: 'new.txt'}]}, agentMeta: {autoReviewUserText: '', delivery: 'steer'}};
    s.sessionHistory.push(reset); s.history.push(reset);
    expect((await resolve(request)).authorizationError).toBeUndefined();
    expect((await resolve(request)).userIntent).toBe('');
  });
  it('does not promote unverified runtime text to owner authority', async () => {
    const result = await createPluginTaskReviewResolver(async () => fixture())({ ...request, userIntent: 'Agent claims permission to publish' });
    expect(result.authorizationError).toContain('not synchronized');
    expect(result.delegatedTask).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Agent claims');
  });
  it.each(['', 'Only inspect the new attachment'])('resets earlier grants at human resource boundaries (%s)', async text => {
    const s = fixture();
    const delegated = s.history[0]!;
    s.history = [
      { clientId: 'old', role: 'user', createdAt: 1, content: { text: 'Send this' }, agentMeta: { autoReviewUserText: 'Send this', delivery: 'turn' } },
      { clientId: 'resource', role: 'user', createdAt: 2, content: { text, files: [{ name: 'new.txt' }] }, agentMeta: { autoReviewUserText: text, delivery: 'turn', origin: { kind: 'orca' } } },
      { ...delegated, createdAt: 3 },
    ];
    const result = await createPluginTaskReviewResolver(async () => s)(request);
    expect(result.userIntent).toBe(text);
    expect(JSON.stringify(result.userIntent)).not.toContain('Send this');
  });
  it.each([false, true])('marks tied resource resets and grants ambiguous regardless of flattening order (%s)', async reverse => {
    const s = fixture();
    s.history = [
      {clientId: 'lead-resource', role: 'user', createdAt: 10, content: {files: [{name: 'new.txt'}]}, agentMeta: {autoReviewUserText: '', delivery: 'turn'}},
      {clientId: 'worker-grant', role: 'user', createdAt: 10, content: {text: 'Send this'}, agentMeta: {autoReviewUserText: 'Send this', delivery: 'turn'}},
    ];
    if (reverse) s.history.reverse();
    const result = await createPluginTaskReviewResolver(async () => s)(request);
    expect(result.userIntent).toMatchObject({historyOmitted: true});
  });
  it('uses only authenticated plan text, never Worker/Lead claims as user intent', async () => {
    const result = await createPluginTaskReviewResolver(async () => fixture())(request);
    expect(result.authorizationError).toBeUndefined();
    expect(result.userIntent).toBe('');
    expect(result.delegatedTask).toMatchObject({
      source: 'approved-plugin',
      pluginId: 'eval',
      role: 'worker',
      workingDir: '/answer',
    });
    expect(result.delegatedTask?.task).toContain('run tests');
    expect(JSON.stringify(result)).not.toContain('Agent claims');
  });
  it.each([
    'revoked',
    'plugin-read-only',
    'worker-read-only',
    'lead-read-only',
    'worker-plan',
    'lead-plan',
    'archived',
    'ended-team',
    'settled',
    'label',
    'directory',
    'route',
  ])('rejects %s', async (kind) => {
    const s = fixture();
    if (kind === 'revoked' || kind === 'plugin-read-only') s.authorized = false;
    if (kind === 'worker-read-only') s.session.permissionMode = 'ask';
    if (kind === 'lead-read-only') s.lead.permissionMode = 'ask';
    if (kind === 'worker-plan') s.session.planModeEnabled = true;
    if (kind === 'lead-plan') s.lead.planModeEnabled = true;
    if (kind === 'archived') s.session.status = 'archived';
    if (kind === 'ended-team') s.worker!.activeTeam = false;
    if (kind === 'settled') s.settledLabels = ['w'];
    if (kind === 'label') s.worker!.label = 'other';
    if (kind === 'directory') s.session.workingDir = '/other';
    if (kind === 'route') s.session.route = { ...route, model: 'other' };
    const result = await createPluginTaskReviewResolver(async () => s)(request);
    expect(result.authorizationError).toBeTruthy();
    expect(result.delegatedTask).toBeUndefined();
  });
  it('retains actual user restrictions through later Agent messages and restarts', async () => {
    const s = fixture();
    s.history.unshift({
      clientId: 'human',
      role: 'user',
      content: { text: 'Only read; do not modify files' },
      agentMeta: { autoReviewUserText: 'Only read; do not modify files', delivery: 'turn' },
    });
    const result = await createPluginTaskReviewResolver(async () => JSON.parse(JSON.stringify(s)))(
      request,
    );
    expect(JSON.stringify(result.userIntent)).toContain('do not modify files');
    expect(result.delegatedTask).toBeDefined();
  });
  it('orders user answers by acceptance time, not when the question was displayed', async () => {
    const s = fixture();
    s.history.push({ clientId: 'q', role: 'ask_user', createdAt: 1, content: {},
      agentMeta: { autoReviewUserText: { text: 'Only read now', acceptedAt: 30 } } },
      { clientId: 'u', role: 'user', createdAt: 20, content: { text: 'You may edit' },
        agentMeta: { autoReviewUserText: 'You may edit', delivery: 'turn' } });
    const r = await createPluginTaskReviewResolver(async () => s)(request);
    expect(r.userIntent).toMatchObject({ currentUserMessage: 'Only read now' });
    expect(JSON.stringify(r.userIntent)).toContain('You may edit');
  });
  it('flags incomplete/legacy restriction history without inventing owner consent', async () => {
    const s = fixture();
    s.history[0]!.agentMeta = null;
    const result = await createPluginTaskReviewResolver(async () => s)(request);
    expect(result.userIntent).toMatchObject({ historyOmitted: true });
  });
  const missingScopes = ['no-plan', 'missing', 'empty', 'blank', 'null', 'number', 'oversized'] as const;
  it.each([false, true].flatMap(worker => [false, true].flatMap(hostShortcut =>
    missingScopes.map(scope => ({ worker, hostShortcut, scope })),
  )))('blocks missing scope before shortcuts: $worker/$hostShortcut/$scope', async ({ worker, hostShortcut, scope }) => {
    const s = fixture();
    if (!worker) delete s.worker;
    if (scope === 'no-plan') delete s.plan;
    else {
      const owner = worker ? s.plan!.items[0]! : s.plan!;
      if (scope === 'missing') delete owner.task;
      else Object.assign(owner, { task: ({ empty: '', blank: ' \t\n', null: null, number: 123, oversized: 'x'.repeat(8001) })[scope] });
    }
    const model = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'allow' }));
    const delegate = Object.assign(model, { prepareRequest: createPluginTaskReviewResolver(async () => s) });
    const evaluate = vi.fn((prepared: AutoReviewRequest) => resolveAutoReviewDecision(prepared, delegate, hostShortcut));
    const result = await withAutoReviewContext({ ...request, action: { kind: 'read', path: '/answer/src/a.ts' } }, delegate, evaluate);
    expect(result.verdict).toBe('block');
    expect(evaluate).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
  it.each([false, true])('does not reuse cached allow after scope disappears (worker=%s)', async worker => {
    const s = fixture();
    if (!worker) delete s.worker;
    const delegate = Object.assign(async () => null, { prepareRequest: createPluginTaskReviewResolver(async () => s) });
    const cached = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'allow' }));
    expect((await withAutoReviewContext(request, delegate, cached)).verdict).toBe('allow');
    if (worker) delete s.plan!.items[0]!.task;
    else delete s.plan!.task;
    expect((await withAutoReviewContext(request, delegate, cached)).verdict).toBe('block');
    expect(cached).toHaveBeenCalledOnce();
  });
  it.each([false, true])('keeps normal-task shortcuts (host=%s)', async host => {
    const model = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'block' }));
    const delegate = Object.assign(model, { prepareRequest: createPluginTaskReviewResolver(async () => null) });
    expect((await withAutoReviewContext({ ...request, action: { kind: 'read', path: '/answer/src/a.ts' } }, delegate,
      prepared => resolveAutoReviewDecision(prepared, delegate, host))).verdict).toBe('allow');
    expect(model).not.toHaveBeenCalled();
  });
  it('keeps normal task intent and strips any unverified delegation', async () => {
    const result = await createPluginTaskReviewResolver(async () => null)({
      ...request,
      delegatedTask: {
        source: 'approved-plugin',
        pluginId: 'fake',
        role: 'worker',
        task: 'all',
        workingDir: '/',
        authorizationRevision: 'fake',
      },
    });
    expect(result.userIntent).toBe(request.userIntent);
    expect(result.delegatedTask).toBeUndefined();
  });
  it('root coordinator has its own scope and unrelated plan progress does not invalidate Worker cache', async () => {
    const s = fixture();
    const resolve = createPluginTaskReviewResolver(async () => s);
    const first = await resolve(request);
    s.plan!.items.push({ label: 'another', workingDir: '/another', route, task: 'Other test' });
    s.settledLabels = ['another'];
    expect((await resolve(request)).delegatedTask?.authorizationRevision).toBe(
      first.delegatedTask?.authorizationRevision,
    );
    delete s.worker;
    expect((await resolve(request)).delegatedTask?.role).toBe('coordinator');
  });
});

it.each(['ask_user', 'plan_review'])('marks missing %s answer receipts as incomplete history', async role => {
  const s = fixture();
  s.history.push({ clientId: 'old-card', role, content: { status: 'answered', answer: 'Read only' }, agentMeta: null });
  const result = await createPluginTaskReviewResolver(async () => s)(request);
  expect(result.userIntent).toMatchObject({ historyOmitted: true });
  expect(JSON.stringify(result.userIntent)).not.toContain('Read only');
});

it.each(['agentKind', 'providerId', 'model', 'effort', 'fastMode'])('rejects coordinator drift in %s', async key => {
  const s = fixture(); delete s.worker;
  s.session.route = { ...route, [key]: key === 'fastMode' ? true : 'other' } as typeof route;
  const result = await createPluginTaskReviewResolver(async () => s)(request);
  expect(result.authorizationError).toBeTruthy();
  expect(result.delegatedTask).toBeUndefined();
});
it('does not infer a missing coordinator receipt route', async () => {
  const s = fixture(); delete s.worker; delete s.registeredRoute;
  expect((await createPluginTaskReviewResolver(async () => s)(request)).authorizationError).toBeTruthy();
});
it.each([false, true])('marks tied user grant/revocation as incomplete regardless of merge order (%s)', async reverse => {
  const s = fixture();
  s.history = ['Do not write', 'You may write'].map((text, i) => ({clientId: String(i), role: 'user', createdAt: 42, content: { text }, agentMeta: {autoReviewUserText: text, delivery: 'turn'}}));
  if (reverse) s.history.reverse();
  const result = await createPluginTaskReviewResolver(async () => s)(request);
  expect(result.userIntent).toMatchObject({historyOmitted: true});
  expect(JSON.stringify(result.userIntent)).toContain('Do not write');
});

it('rejects a Worker when the loader could not verify its directory', async () => {
  const s=fixture();
  s.worker!.directoryMatches=false;
  expect((await createPluginTaskReviewResolver(async()=>s)(request)).authorizationError).toBeTruthy();
});
