import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_UI_CAPABILITIES, type PluginUiHostMessage, type PluginUiView } from '@cindy/maker-shared';
import { PluginUiService, isLocalPluginUiSession, pluginCommandShortcuts, selectPluginUiRenderer, type PluginUiInstance, type PluginUiRendererCandidate } from '../pluginUiService.js';

/* C1-C4 production service: exact install/controller/task bindings, paired reads,
 * one terminal action result, invalidation races and timeout without replay.
 * Existing card tests do not cover independent native contribution bindings.
 * Minimal failure: two same-name instances or a late reply. Tier: unit. */
const ui = { version: 1, contributions: [{ id: 'format', point: 'composer.tools', scope: 'session' }] };
const content = { controls: [{ kind: 'button', id: 'save', label: 'Save format', actionId: 'save' }],
  blocks: [], actions: [{ id: 'save', label: 'Save format' }], fallbackMarkdown: 'Format' };
const request = (sessionId = 'task-1') => ({ sessionId, point: 'composer.tools', capabilities: PLUGIN_UI_CAPABILITIES });
function setup(initial: PluginUiInstance[] = [{ id: 'root__sample', token: 'owner:approved:runtime-1', ui }]) {
  const instances = new Map(initial.map(i => [i.id, i]));
  const sent: { id: string; message: PluginUiHostMessage }[] = [];
  const changed = vi.fn();
  const bindingRemoved = vi.fn();
  const disabled = new Set<string>();
  const unavailableMessages = new Set<string>();
  const unavailableTurns = new Set<string>();
  const wake = vi.fn(async () => true);
  const authorize = vi.fn(async () => ({ current: () => true, allows: (id: string) => !disabled.has(id) }));
  const contextReads = vi.fn(async (scope: { sessionId: string }, fields: readonly string[]) =>
    fields.includes('session.summary') ? { session: { id: scope.sessionId, title: 'Task title', status: 'active' } } : {});
  const prepareNavigation = vi.fn(() => ({ requestId: 'host-navigation' }));
  const service = new PluginUiService({
    current: id => instances.get(id) ?? null,
    wake,
    authorize,
    resolveScope: async (sessionId, point, target) => target?.kind === 'message' && !unavailableMessages.has(target.id) && target.id === 'message-1' && sessionId === 'task-1' &&
      ['message.actions', 'message.shortcuts', 'turn.footer'].includes(point) &&
      (point !== 'turn.footer' || !unavailableTurns.has(target.id)) ? { kind: 'message', sessionId, messageClientId: target.id } : null,
    readContext: contextReads,
    send: (id, message) => { sent.push({ id, message }); return true; },
    changed, bindingRemoved, prepareNavigation, queryTimeoutMs: 50, actionTimeoutMs: 100,
  });
  service.reconcile([...instances.values()]);
  for (const i of initial) service.handle(i.id, { type: 'ui-register', contributionId: 'format' });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const answer = (entry = sent.at(-1)!) => {
    if (entry.message.type !== 'ui-view-request') throw new Error('not a view request');
    service.handle(entry.id, { type: 'ui-view-result', requestId: entry.message.requestId,
      viewId: entry.message.viewId, content });
  };
  const view = async (controller = 'phone', sessionId = 'task-1') => {
    const pending = service.read(controller, request(sessionId)); await flush();
    for (const entry of sent.filter(e => e.message.type === 'ui-view-request')) answer(entry);
    return (await pending).views[0];
  };
  const invoke = (v: PluginUiView, invocationId = 'click-1', controller = 'phone', values = {}) =>
    service.invoke(controller, 'task-1', { viewId: v.viewId, expectedRevision: v.revision,
      actionId: 'save', invocationId, values });
  return { service, instances, sent, changed, bindingRemoved, prepareNavigation, disabled, flush, answer, view, invoke, contextReads, unavailableMessages, unavailableTurns, wake, authorize };
}
afterEach(() => vi.useRealTimers());

describe('PluginUiService', () => {
  // PR #8909: an idle mounted outlet has a live subscription, not an abandoned
  // read projection. A later outlet must not invalidate its controls or page.
  it.each([false, true])('expires only unsubscribed idle projections (subscribed=%s)', async subscribed => {
    vi.useFakeTimers({ now: 0 });
    const h = setup();
    const read = async (sessionId: string, subscriptionId?: string) => {
      const pending = h.service.read('phone', { ...request(sessionId), subscriptionId });
      await h.flush(); h.answer(); return (await pending).views[0];
    };
    const first = await read('task-1', subscribed ? 'live' : undefined);
    vi.setSystemTime(300_001);
    await read('task-2', 'other');
    if (!subscribed) {
      expect(h.bindingRemoved).toHaveBeenCalledWith(first.viewId);
      await expect(h.invoke(first)).rejects.toThrow();
      return;
    }
    expect(h.bindingRemoved).not.toHaveBeenCalledWith(first.viewId);
    const pending = h.invoke(first, 'after-idle'); await h.flush();
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: first.viewId,
      invocationId: 'after-idle', result: { status: 'completed' } });
    expect(await pending).toMatchObject({ status: 'completed' });
    h.service.release('phone', 'live');
    expect(h.bindingRemoved).toHaveBeenCalledWith(first.viewId);
    await expect(h.invoke(first, 'after-release')).rejects.toThrow();
  });
  // 4.3: sequence belongs to accepted intent, never asynchronous plugin replies.
  // Unit: real service invokes and forged/missing destinations, absent in old effects tests.
  it('issues navigation for its own declared view with source intent order and at-most-once invocation', async () => {
    const h = setup([{ id: 'root__sample', token: 'one', ui: { ...ui,
      tabViews: [{ id: 'log', title: 'Log', scope: 'session', page: 'log.html' }] } }]);
    const view = await h.view('local:1');
    const a = h.invoke(view, 'a', 'local:1'); await h.flush();
    const b = h.invoke(view, 'b', 'local:1'); await h.flush();
    const reply = (invocationId: string, id: string) => h.service.handle('root__sample', {
      type: 'ui-action-result', viewId: view.viewId, invocationId,
      result: { status: 'completed', openView: { id, params: { item: invocationId }, instanceId: 'forged' } },
    });
    reply('b', 'log'); expect(await b).toMatchObject({ status: 'completed', navigation: { requestId: 'host-navigation' } });
    reply('a', 'log'); await a;
    expect(h.prepareNavigation.mock.calls).toHaveLength(2);
    const calls = h.prepareNavigation.mock.calls as unknown as [{ sequence: number; instanceId: string; sessionId: string }][];
    expect(calls[0][0]).toMatchObject({ instanceId: 'root__sample', sessionId: 'task-1' });
    expect(calls[0][0].sequence).toBeGreaterThan(calls[1][0].sequence);
    await h.invoke(view, 'a', 'local:1');
    expect(h.prepareNavigation).toHaveBeenCalledTimes(2);
    const missing = h.invoke(view, 'missing', 'local:1'); await h.flush(); reply('missing', 'undeclared');
    expect(await missing).toMatchObject({ status: 'completed', navigationError: 'VIEW_UNAVAILABLE' });
  });
  // User's existing-footer extension: the production entry must accept a compact
  // contribution and dispatch its declared click, without page/draft capabilities.
  // Other outlet cases do not cover this point. Minimum: one status + button; unit.
  it('reads and invokes a statusbar contribution with only compact capabilities', async () => {
    const h = setup([{ id: 'root__sample', token: 'one', ui: { version: 1, contributions: [
      { id: 'format', point: 'session.statusbar', scope: 'session', editor: ['append'] },
    ] } }]);
    const pending = h.service.read('local:1', { ...request(), point: 'session.statusbar' });
    await h.flush();
    const query = h.sent.at(-1)!.message;
    expect(query).toMatchObject({ type: 'ui-view-request', context: { scope: { kind: 'session', sessionId: 'task-1' },
      capabilities: { primitives: ['button', 'status'], effects: [], pages: [] } } });
    if (query.type !== 'ui-view-request') throw new Error('not a view request');
    h.service.handle('root__sample', { type: 'ui-view-result', requestId: query.requestId, viewId: query.viewId,
      content: { ...content, controls: [
        { kind: 'status', id: 'status', label: 'State', text: 'Ready' }, ...content.controls,
      ], blocks: [{ id: 'large', kind: 'markdown', text: 'A multiline block is not a statusbar item.' }] } });
    const view = (await pending).views[0];
    expect(view).toMatchObject({ point: 'session.statusbar', blocks: [], controls: [
      { kind: 'status', text: 'Ready' }, { kind: 'button', actionId: 'save' },
    ] });
    expect(view.editor).toBeUndefined();
    const result = h.invoke(view, 'status-click', 'local:1');
    await h.flush();
    expect(h.sent.at(-1)!.message).toMatchObject({ type: 'event', name: 'ui-action', viewId: view.viewId,
      actionId: 'save', context: { scope: { kind: 'session', sessionId: 'task-1' } } });
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: view.viewId,
      invocationId: 'status-click', result: { status: 'completed' } });
    expect(await result).toEqual({ invocationId: 'status-click', status: 'completed' });
  });
  it('binds a packaged page to its original view, task and controller', async () => {
    const declared = { version: 1, contributions: [{ ...ui.contributions[0], page: 'ui/view.html', context: ['session.summary'] }] };
    const h = setup([{ id: 'root__sample', token: 'one', ui: declared }]);
    const unsupported = await h.service.read('local:1', { ...request(), capabilities: { ...PLUGIN_UI_CAPABILITIES, pages: [] } });
    expect(unsupported.views).toEqual([]);
    expect(h.wake).not.toHaveBeenCalled();
    const view = await h.view('local:1');
    expect(view.page).toBe(true);
    const page = await h.service.bindPage('local:1', 'task-1', view.viewId, view.revision);
    expect(page).toMatchObject({ instanceId: 'root__sample', contributionId: 'format', readOnly: false });
    expect(await page.read()).toMatchObject({ session: { title: 'Task title' }, capabilities: { effects: [] } });
    await expect(h.service.bindPage('local:2', 'task-1', view.viewId, view.revision)).rejects.toThrow();
    await expect(h.service.bindPage('local:1', 'task-1', view.viewId, 'wrong')).rejects.toThrow();
    // Unit regression: the real bound page used to drop both structured input
    // and plugin results. Existing native-control tests only check status.
    const input = { filters: { tags: ['one', 'two'] }, offset: 0 };
    const data = { items: [{ id: 'one', text: 'plugin-owned result' }], next: null };
    const pending = page.invoke({ actionId: 'save', values: { title: 'plugin input' }, data: input });
    await h.flush();
    expect(h.sent.at(-1)?.message).toMatchObject({ name: 'ui-action', actionId: 'save', values: { title: 'plugin input' }, data: input });
    const action = h.sent.at(-1)!.message;
    if (action.type !== 'event' || action.name !== 'ui-action') throw new Error('not an action');
    h.service.handle('other-instance', { type: 'ui-action-result', viewId: view.viewId,
      invocationId: action.invocationId, result: { status: 'completed', data: { forged: true } } });
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: view.viewId,
      invocationId: action.invocationId, result: { status: 'completed', data } });
    expect(await pending).toEqual({ status: 'completed', data });
    const late = page.invoke({ actionId: 'save', values: {}, data: { load: 'late' } });
    await h.flush();
    const lateAction = h.sent.at(-1)!.message;
    if (lateAction.type !== 'event' || lateAction.name !== 'ui-action') throw new Error('not an action');
    h.service.revoke('root__sample');
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: view.viewId,
      invocationId: lateAction.invocationId, result: { status: 'completed', data: { private: 'late' } } });
    expect(await late).toEqual({ status: 'outcome-unknown' });
    expect(h.bindingRemoved).toHaveBeenCalledWith(view.viewId);
    expect(page.current()).toBe(false);
    await expect(page.read()).rejects.toThrow();
    await expect(page.invoke({ actionId: 'save', values: {} })).rejects.toThrow();
  });
  it('admits native UI only for sessions whose local ownership is confirmed by the host', () => {
    expect(isLocalPluginUiSession({ remoteHostId: null, agentDeviceId: null })).toBe(true);
    expect(isLocalPluginUiSession({ remoteHostId: 'ssh-host', agentDeviceId: null })).toBe(false);
    expect(isLocalPluginUiSession({ remoteHostId: null, agentDeviceId: 'other-device' })).toBe(false);
    expect(isLocalPluginUiSession({ remoteHostId: null })).toBe(false);
    expect(isLocalPluginUiSession(null)).toBe(false);
  });
  it('never wakes or sends a record to unselected renderers and revokes the old view after a choice', async () => {
    const source = { kind: 'plugin' as const, instanceId: 'owner', name: 'format' };
    const records = [
      { id: 'owner', token: 'one', name: 'Owner', ui: { version: 1, contributions: [{ id: 'own', point: 'tool.body', scope: 'tool', match: { kind: 'self', name: 'format' }, context: ['tool.input'] }] } },
      { id: 'other', token: 'two', name: 'Other', ui: { version: 1, contributions: [{ id: 'other', point: 'tool.body', scope: 'tool', page: 'ui/tool.html', match: { kind: 'plugin', instanceId: 'owner', name: 'format' }, context: ['tool.input'] }] } },
    ];
    let choice: { instanceId: string; contributionId: string } | null | undefined;
    const sent: { id: string; message: PluginUiHostMessage }[] = [], disabled = new Set<string>();
    const wake = vi.fn(async () => true);
    const service = new PluginUiService({
      current: id => records.find(record => record.id === id) ?? null, wake,
      authorize: async () => ({ current: () => true, allows: id => !disabled.has(id) }),
      resolveScope: async (sessionId, point, target) => point === 'tool.body' && target?.kind === 'tool' && target.id === 'tool-1'
        ? { kind: 'tool', sessionId, toolUseId: target.id } : null,
      resolveRendererSource: async () => ({ source }),
      readRendererChoice: () => choice,
      writeRendererChoice: async (_target, next) => { choice = next; },
      readContext: async () => ({ tool: { id: 'tool-1', name: 'format', input: { private: 'only-selected' } } }),
      send: (id, message) => { sent.push({ id, message }); return true; }, changed: () => {}, queryTimeoutMs: 50,
    });
    service.reconcile(records);
    service.handle('owner', { type: 'ui-register', contributionId: 'own' });
    service.handle('other', { type: 'ui-register', contributionId: 'other' });
    const request = { sessionId: 'task-1', point: 'tool.body', target: { kind: 'tool', id: 'tool-1' }, capabilities: PLUGIN_UI_CAPABILITIES };
    const initial = await service.read('local:1', request);
    expect(initial.renderer?.candidates.map(candidate => candidate.instanceId)).toEqual(['other', 'owner']);
    expect(initial.views).toEqual([]); expect(wake).not.toHaveBeenCalled(); expect(sent).toEqual([]);
    await service.chooseRenderer('local:1', request, { instanceId: 'other', contributionId: 'other' });
    const pending = service.read('local:1', request);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(wake).toHaveBeenCalledOnce(); expect(wake).toHaveBeenCalledWith('other');
    const entry = sent[0]; expect(entry.id).toBe('other');
    expect(entry.message).toMatchObject({ type: 'ui-view-request', context: { tool: { input: { private: 'only-selected' } } } });
    if (entry.message.type !== 'ui-view-request') throw new Error('not a view request');
    service.handle('other', { type: 'ui-view-result', requestId: entry.message.requestId, viewId: entry.message.viewId, content });
    const view = (await pending).views[0];
    const page = await service.bindPage('local:1', 'task-1', view.viewId, view.revision);
    expect(page.readOnly).toBe(true);
    await expect(page.invoke({ actionId: 'save', values: {} })).rejects.toThrow();
    const sentBeforeHistoryAction = sent.length;
    await expect(service.invoke('local:1', 'task-1', { viewId: view.viewId, expectedRevision: view.revision,
      invocationId: 'history', actionId: 'save', values: {} })).rejects.toThrow();
    expect(sent).toHaveLength(sentBeforeHistoryAction);
    await service.chooseRenderer('local:1', request, null);
    await expect(service.invoke('local:1', 'task-1', { viewId: view.viewId, expectedRevision: view.revision,
      invocationId: 'old', actionId: 'save', values: {} })).rejects.toThrow();
    expect((await service.read('local:1', request)).views).toEqual([]);
    disabled.add('other');
    await expect(service.chooseRenderer('local:1', request, { instanceId: 'other', contributionId: 'other' })).rejects.toThrow();
  });
  it('selects a renderer only for the exact saved source and honors an explicit choice', () => {
    const source = { kind: 'plugin' as const, instanceId: '_root__writer', name: 'format' };
    const own = { instanceId: '_root__writer', contribution: { id: 'own', point: 'tool.body', scope: 'tool', match: { kind: 'self', name: 'format' } } };
    const other = { instanceId: '_ns__team__formatter', contribution: { id: 'other', point: 'tool.body', scope: 'tool',
      match: { kind: 'plugin', instanceId: '_root__writer', name: 'format' } } };
    const select = (candidates: PluginUiRendererCandidate[], choice?: { instanceId: string; contributionId: string } | null, legacy = false) =>
      selectPluginUiRenderer({ point: 'tool.body', source, candidates, choice, legacy });
    expect(select([own]).selected).toBe(own);
    expect(select([own, other]).selected).toBeUndefined();
    expect(select([own, other], { instanceId: other.instanceId, contributionId: 'other' }).selected).toBe(other);
    expect(select([own], { instanceId: other.instanceId, contributionId: 'other' }).selected).toBeUndefined();
    expect(select([own], null).selected).toBeUndefined();
    expect(select([own], undefined, true).selected).toBeUndefined();
    expect(selectPluginUiRenderer({ point: 'tool.body', source: undefined, candidates: [own] }).candidates).toEqual([]);
    expect(selectPluginUiRenderer({ point: 'tool.body', source: { ...source, instanceId: '_ns__other__writer' }, candidates: [own, other] }).candidates).toEqual([]);
  });
  it('binds a registered command to its real task and keeps a same-name contribution independent', async () => {
    const declared = { ...ui, commands: [{ id: 'format', title: 'Run command', points: ['composer.tools'],
      scope: 'session', context: ['selection'], editor: ['append'] }] };
    const h = setup([{ id: 'root__sample', token: 'one', ui: declared }]);
    expect(h.service.handle('root__sample', { type: 'ui-command-register', commandId: 'missing' })).toEqual({ ok: false });
    expect(h.service.handle('root__sample', { type: 'ui-command-register', commandId: 'format' })).toEqual({ ok: true });
    const read = h.service.read('phone', request()); await h.flush(); h.answer();
    const views = (await read).views;
    expect(views).toHaveLength(2);
    const command = views.find(view => view.fallbackMarkdown === 'Run command')!;
    const write = h.service.invoke('phone', 'task-1', { viewId: command.viewId, expectedRevision: command.revision,
      actionId: 'run', invocationId: 'command-1', values: {}, editor: { draftKey: 'draft', revision: '1',
        selection: { start: 0, end: 2 }, selectedText: 'hi' } });
    await h.flush();
    expect(h.sent.at(-1)?.message).toMatchObject({ type: 'event', name: 'ui-command', commandId: 'format',
      context: { scope: { kind: 'session', sessionId: 'task-1' }, selection: { text: 'hi' } } });
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: command.viewId,
      invocationId: 'command-1', result: { status: 'completed' } });
    expect(await write).toMatchObject({ status: 'completed' });
    h.service.handle('root__sample', { type: 'ui-command-unregister', commandId: 'format' });
    await expect(h.service.invoke('phone', 'task-1', { viewId: command.viewId, expectedRevision: command.revision,
      actionId: 'run', invocationId: 'command-2', values: {} })).rejects.toThrow();
    expect(h.service.inspect().bindings).toBe(1);
  });
  it('projects command shortcut identities by owner and physical instance, independent of runtime generation', async () => {
    const declared = { version: 1, commands: [{ id: 'format', title: 'Format', scope: 'session' }] };
    const instance = { id: 'root__sample', token: 'runtime-1', shortcutScope: 'owner-a', name: 'Sample', ui: declared };
    const [definition] = pluginCommandShortcuts([instance]);
    expect(definition).toMatchObject({ label: 'Format', pluginName: 'Sample', instanceId: instance.id, scope: 'session' });
    expect(pluginCommandShortcuts([{ ...instance, token: 'runtime-2' }])[0].id).toBe(definition.id);
    expect(pluginCommandShortcuts([{ ...instance, shortcutScope: 'owner-b' }])[0].id).not.toBe(definition.id);
    const h = setup([instance]);
    expect(h.service.handle(instance.id, { type: 'ui-command-register', commandId: 'format' })).toEqual({ ok: true });
    const result = await h.service.read('phone', { ...request(), point: 'session.shortcuts' });
    expect(result.views).toHaveLength(1);
    expect(result.views[0].command?.shortcutId).toBe(definition.id);
  });
  it('keeps message shortcuts on their resolved target and filters turn-only commands', async () => {
    const declared = { version: 1, commands: [
      { id: 'message', title: 'Message', scope: 'message', points: ['message.actions'] },
      { id: 'turn', title: 'Turn', scope: 'message', points: ['turn.footer'] },
    ] };
    const instance = { id: 'root__sample', token: 'one', shortcutScope: 'owner-a', ui: declared };
    expect(pluginCommandShortcuts([instance]).find(command => command.label === 'Turn')?.points).toEqual(['turn.footer']);
    const h = setup([instance]);
    h.service.handle(instance.id, { type: 'ui-command-register', commandId: 'message' });
    h.service.handle(instance.id, { type: 'ui-command-register', commandId: 'turn' });
    const messageRequest = { ...request(), point: 'message.shortcuts', target: { kind: 'message', id: 'message-1' } };
    const initial = await h.service.read('phone', messageRequest);
    const turn = initial.views.find(view => view.contributionId === 'turn')!;
    h.unavailableTurns.add('message-1');
    await expect(h.service.invoke('phone', 'task-1', { viewId: turn.viewId, expectedRevision: turn.revision,
      actionId: 'run', invocationId: 'changed-turn', values: {} })).rejects.toThrow('UI target unavailable');
    const result = await h.service.read('phone', messageRequest);
    expect(result.views.map(view => view.contributionId)).toEqual(['message']);
    h.unavailableMessages.add('message-1');
    const view = result.views[0];
    await expect(h.service.invoke('phone', 'task-1', { viewId: view.viewId, expectedRevision: view.revision,
      actionId: 'run', invocationId: 'deleted', values: {} })).rejects.toThrow('UI target unavailable');
  });
  it('releases only the original outlet while preserving another outlet and controller', async () => {
    const h = setup();
    const read = async (controller: string, subscriptionId: string) => {
      const pending = h.service.read(controller, { ...request(), subscriptionId }); await h.flush(); h.answer();
      return (await pending).views[0];
    };
    const first = await read('phone', 'first'), second = await read('phone', 'second'), tablet = await read('tablet', 'first');
    h.service.release('phone', 'first');
    expect(h.service.inspect().bindings).toBe(2);
    await expect(h.invoke(first)).rejects.toThrow();
    const write = h.invoke(second); await h.flush();
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: second.viewId, invocationId: 'click-1', result: { status: 'completed' } });
    expect(await write).toMatchObject({ status: 'completed' });
    expect(h.service.inspect().views.some(v => v.viewId === tablet.viewId)).toBe(true);
  });
  it('cancels a released read before a delayed runtime wake can query the plugin', async () => {
    const h = setup(); let resolve!: (value: boolean) => void;
    h.wake.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = h.service.read('phone', { ...request(), subscriptionId: 'departed' }); await h.flush();
    h.service.release('phone', 'departed'); resolve(true);
    await expect(pending).rejects.toThrow(); expect(h.sent).toEqual([]);
    await expect(h.service.read('phone', { ...request(), subscriptionId: 'departed' })).rejects.toThrow();
  });
  it('reads only declared context and freezes an edit to the original controller snapshot', async () => {
    const declared = { version: 1, contributions: [{ ...ui.contributions[0], context: ['session.summary', 'selection'], editor: ['append'] }] };
    const h = setup([{ id: 'root__sample', token: 'one', ui: declared }]); const v = await h.view();
    expect(h.sent[0].message).toMatchObject({ context: { session: { title: 'Task title' } } });
    expect(h.sent[0].message).not.toHaveProperty('context.selection');
    const pending = h.service.invoke('phone', 'task-1', { viewId: v.viewId, expectedRevision: v.revision,
      invocationId: 'edit-1', actionId: 'save', values: {}, editor: { draftKey: 'original-draft', revision: '7',
        selection: { start: 2, end: 5 }, selectedText: 'selected' } });
    await h.flush();
    expect(h.sent.at(-1)?.message).toMatchObject({ context: { selection: { text: 'selected' }, capabilities: { effects: ['composer-edit.append'] } } });
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: v.viewId, invocationId: 'edit-1',
      result: { status: 'completed', edit: { operation: 'append', text: 'Hello', draftKey: 'forged-target' } } });
    expect(await pending).toMatchObject({ status: 'completed', effects: [{ kind: 'composer-edit', draftKey: 'original-draft',
      expectedDraftRevision: '7', selection: { start: 2, end: 5 }, operation: 'append', text: 'Hello' }] });
  });
  it('does not disclose undeclared selection or apply an undeclared edit after business completion', async () => {
    const h = setup(); const v = await h.view(); expect(h.contextReads).not.toHaveBeenCalled();
    const pending = h.service.invoke('phone', 'task-1', { viewId: v.viewId, expectedRevision: v.revision,
      invocationId: 'edit-2', actionId: 'save', values: {}, editor: { draftKey: 'draft', revision: '1',
        selection: { start: 0, end: 1 }, selectedText: 'private' } });
    await h.flush(); expect(h.sent.at(-1)?.message).not.toHaveProperty('context.selection');
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: v.viewId, invocationId: 'edit-2',
      result: { status: 'completed', edit: { operation: 'append', text: 'Hello' } } });
    expect(await pending).toMatchObject({ status: 'completed', effectError: 'UNSUPPORTED_EFFECT' });
    expect(await pending).not.toHaveProperty('effects');
  });
  it('anchors message contributions to a Host-resolved object and rejects an unrelated target', async () => {
    const messageUi = { version: 1, contributions: [{ id: 'format', point: 'message.actions', scope: 'message' }] };
    const h = setup([{ id: 'root__sample', token: 'one', ui: messageUi }]);
    await expect(h.service.read('phone', { ...request(), point: 'message.actions', target: { kind: 'message', id: 'other' } })).rejects.toThrow();
    const pending = h.service.read('phone', { ...request(), point: 'message.actions', target: { kind: 'message', id: 'message-1' } });
    await h.flush(); h.answer();
    const v = (await pending).views[0]; expect(v.point).toBe('message.actions');
    expect(h.sent[0].message).toMatchObject({ context: { scope: { kind: 'message', sessionId: 'task-1', messageClientId: 'message-1' } } });
    h.unavailableMessages.add('message-1');
    await expect(h.invoke(v)).rejects.toThrow('UI target unavailable');
  });
  it('reports unsupported required primitives without exposing fields or allowing a partial submit', async () => {
    const h = setup(); const pending = h.service.read('phone', request()); await h.flush();
    const query = h.sent[0].message;
    if (query.type !== 'ui-view-request') throw new Error('missing query');
    h.service.handle('root__sample', { type: 'ui-view-result', requestId: query.requestId, viewId: query.viewId,
      content: { ...content, controls: [{ kind: 'future.input', required: true, id: 'secret', label: 'private value' }] } });
    const v = (await pending).views[0]; expect(v.controls).toEqual([]); expect(v.actions).toEqual([]);
    expect(h.service.inspect().views[0]).toMatchObject({ stage: 'unsupported-primitive', capabilities: { version: 1 } });
    expect(JSON.stringify(h.service.inspect())).not.toContain('private value');
    await expect(h.invoke(v)).rejects.toThrow();
  });
  it('filters workdir-disabled instances and rejects a previously visible action after disabling', async () => {
    const h = setup(); const v = await h.view(); h.disabled.add('root__sample');
    await expect(h.invoke(v)).rejects.toThrow();
    expect((await h.service.read('phone', request())).views).toEqual([]);
  });
  it('cannot reuse a view created under a previous controller connection', async () => {
    const h = setup(); let connected = true;
    const pending = h.service.read('phone', request(), () => connected); await h.flush(); h.answer();
    const old = (await pending).views[0]; connected = false;
    await expect(h.invoke(old)).rejects.toThrow();
    const next = await h.view(); expect(next.viewId).not.toBe(old.viewId);
  });
  it('isolates physical installs, tasks and controllers without guessing plugin names', async () => {
    const h = setup([{ id: 'root__same', token: 'one', ui }, { id: 'org__same', token: 'two', ui }]);
    const pending = h.service.read('phone', request()); await h.flush();
    const queries = h.sent.filter(e => e.message.type === 'ui-view-request');
    expect(queries.map(e => e.id).sort()).toEqual(['org__same', 'root__same']);
    for (const query of queries) h.answer(query);
    const result = await pending;
    expect(new Set(result.views.map(v => v.viewId)).size).toBe(2);
    const original = result.views[0];
    await expect(h.invoke(original, 'forged', 'other-controller')).rejects.toThrow();
    await expect(h.service.invoke('phone', 'another-task', { viewId: original.viewId,
      expectedRevision: original.revision, actionId: 'save', invocationId: 'forged', values: {} })).rejects.toThrow();
  });
  it('does not load unknown points or scopes, and does no work when no UI is installed', async () => {
    const h = setup([]);
    expect(await h.service.read('phone', request())).toMatchObject({ views: [] });
    expect(h.sent).toEqual([]);
    await expect(h.service.read('phone', { ...request(), point: 'future.point' })).rejects.toThrow();
    await expect(h.service.read('phone', { ...request(), target: { kind: 'message', id: 'm' } })).rejects.toThrow();
  });
  it('rejects cross-instance and mismatched query responses before publishing content', async () => {
    const h = setup();
    const pending = h.service.read('phone', request()); await h.flush();
    const query = h.sent[0].message;
    if (query.type !== 'ui-view-request') throw new Error('missing query');
    h.service.handle('other-instance', { type: 'ui-view-result', requestId: query.requestId, viewId: query.viewId, content });
    h.service.handle('root__sample', { type: 'ui-view-result', requestId: query.requestId, viewId: 'forged', content });
    expect(h.service.inspect().queries).toBe(1);
    h.answer(); expect((await pending).views).toHaveLength(1);
  });
  it('cannot publish a stale query after invalidation; it re-reads the same exact scope', async () => {
    const h = setup(); const pending = h.service.read('phone', request()); await h.flush();
    const old = h.sent[0];
    h.service.handle(old.id, { type: 'ui-update', contributionId: 'format', scope: { kind: 'session', sessionId: 'task-1' } });
    h.answer(old); await h.flush();
    expect(h.sent.filter(e => e.message.type === 'ui-view-request')).toHaveLength(2);
    h.answer(h.sent.at(-1)); expect((await pending).views).toHaveLength(1);
  });
  it('dispatches a duplicate invocation once, rejects changed parameters and settles once', async () => {
    const h = setup(); const v = await h.view();
    const first = h.invoke(v), duplicate = h.invoke(v); await h.flush();
    expect(h.sent.filter(e => e.message.type === 'event')).toHaveLength(1);
    await expect(h.invoke(v, 'click-1', 'phone', { changed: true })).rejects.toThrow();
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: v.viewId, invocationId: 'click-1', result: { status: 'completed' } });
    expect(await first).toEqual({ invocationId: 'click-1', status: 'completed' });
    expect(await duplicate).toEqual(await first);
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: v.viewId, invocationId: 'click-1', result: { status: 'rejected' } });
    expect(await first).toMatchObject({ status: 'completed' });
  });
  it('ends a timeout as unknown, ignores late effects, and never replays the write', async () => {
    vi.useFakeTimers(); const h = setup(); const v = await h.view();
    const pending = h.invoke(v); await h.flush(); await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ status: 'outcome-unknown', invocationId: 'click-1' });
    h.service.handle('root__sample', { type: 'ui-action-result', viewId: v.viewId,
      invocationId: 'click-1', result: { status: 'completed', effects: [{ kind: 'composer-edit', text: 'late' }] } });
    expect(await h.invoke(v)).toEqual(await pending);
    expect(h.sent.filter(e => e.message.type === 'event')).toHaveLength(1);
  });
  it('revokes old bindings on runtime/install changes and completes pending actions as unknown', async () => {
    const h = setup(); const v = await h.view(); const pending = h.invoke(v); await h.flush();
    h.instances.set('root__sample', { id: 'root__sample', token: 'replacement', ui });
    h.service.reconcile([...h.instances.values()]);
    expect(await pending).toMatchObject({ status: 'outcome-unknown' });
    await expect(h.invoke(v, 'another-click')).rejects.toThrow();
    expect(h.service.inspect().bindings).toBe(0);
  });
  it('invalidates only existing exact-scope views and keeps diagnostics free of business values', async () => {
    const h = setup(); const v = await h.view(); h.changed.mockClear();
    h.service.handle('root__sample', { type: 'ui-update', contributionId: 'format', scope: { kind: 'session', sessionId: 'other-task' } });
    expect(h.changed).not.toHaveBeenCalled();
    h.service.handle('root__sample', { type: 'ui-update', contributionId: 'format', scope: { kind: 'session', sessionId: 'task-1' } });
    expect(h.changed).toHaveBeenCalledWith('task-1');
    await expect(h.invoke(v)).rejects.toThrow();
    expect(JSON.stringify(h.service.inspect())).not.toContain('Save format');
  });
});
