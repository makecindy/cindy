import { describe, expect, it, vi } from 'vitest';
import { createRuntimePluginControl, RuntimePluginControlError } from '../runtimeControl.js';
import type { GhostControlPointData, GhostRuntimeControlPointResult, GhostRuntimePointData } from '../../../shared/ghost.js';
import type { RuntimePluginPoint, RuntimePluginSettings, RuntimePluginTarget } from '../../../shared/pluginRuntime.js';
import { MODEL_REQUEST_CONTROL } from '@cindy/maker-core';
import { createTaskRuntimePlugins } from '../../maker-ipc/runtimePlugins.js';
import { createRuntimeContextProviders } from '../runtimeContext.js';
import { createStaticPromptProvider } from '../staticPrompt.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { assembleSystemPromptSections } from '@cindy/maker-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as ownerContext from '../../ownerContext.js';
import * as runtimePreferences from '../../maker-host/runtime-plugin-settings.js';

// Test value: the production controller must never load data or call plugins for
// unselected tasks, must preserve selected order, and must not apply stale answers.
// Existing gateway tests cover one recipient; they do not cover task selection or
// host effects. Minimum failure: an empty selection or revocation during an ask.
// Tier: unit, injected transport, no processes/network/waits.
describe('task runtime plugin control', () => {
  // System prompt contract, unit: task opt-in and package scope filter before
  // registration; order/name are stable, and the fixed prefix is untouched.
  it('assembles selected static sections in stable order after the fixed prefix', () => {
    let settings: RuntimePluginSettings = {};
    const find = vi.fn((id: string) => ({ enabled: true, approvedControlPoints: ['system-prompt'],
      manifest: { systemPrompt: [
        { id: 'last', order: 20, text: 'LAST', scope: 'selected-task' },
        { id: 'first', order: 10, text: `${id} {{literal}}`, scope: 'selected-task', agentKinds: ['pi'] },
      ] },
    } as unknown as InstalledGhost));
    const provider = createStaticPromptProvider({ readSettings: () => settings, find });
    const prefix = 'Fixed prefix\n\nOriginal task instructions';
    expect(provider('unselected', 'pi')).toBe('');
    expect(find).not.toHaveBeenCalled();
    expect(assembleSystemPromptSections(prefix, [])).toBe(prefix);
    settings = { 'system-prompt': [{ pluginId: 'z', onFailure: 'block' }, { pluginId: 'a', onFailure: 'block' }] };
    const text = provider('selected', 'pi');
    expect(text).toBe('a {{literal}}\n\nz {{literal}}\n\nLAST\n\nLAST');
    expect(assembleSystemPromptSections(prefix, [{ name: 'task', order: 0, text }])).toBe(prefix + '\n\n' + text);
    expect(provider('selected', 'codex')).toBe('LAST\n\nLAST');
  });
  const input: GhostRuntimePointData = { sessionId: 'task', text: 'work', route: { agentKind: 'pi', providerId: 'p', model: 'm1' } };

  function fixture(initial: RuntimePluginSettings = {}) {
    let settings = initial;
    let owner = true;
    const screen = vi.fn(async (_point: RuntimePluginPoint, _data: GhostControlPointData, _target: RuntimePluginTarget): Promise<GhostRuntimeControlPointResult> => ({ action: 'allow' }));
    const apply = vi.fn(async (_result: GhostRuntimeControlPointResult, _data: GhostRuntimePointData) => {});
    const control = createRuntimePluginControl({
      readSettings: () => settings,
      captureOwner: () => () => owner,
      screen,
    });
    return { control, screen, apply, setSettings: (value: RuntimePluginSettings) => { settings = value; }, revokeOwner: () => { owner = false; } };
  }

  it('does no async work and never reads task input without a selection', () => {
    const f = fixture();
    const read = vi.fn(async () => input);
    for (const point of ['will-start-turn', 'will-model-request', 'will-compose-context', 'will-search-memory'] as const) {
      expect(f.control.run(point, 'task', read, f.apply)).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
  });

  // Performance contract, unit: initialize the real bounded preference store
  // before messages. The first unselected send must use memory, including when
  // another task has persisted selections. Previous tests injected settings.
  it('keeps the first unselected lookup off disk after owner initialization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-plugin-prefs-'));
    const file = path.join(dir, 'runtime-plugin-prefs.json');
    fs.writeFileSync(file, JSON.stringify({ tasks: { selected: { 'will-start-turn': [{ pluginId: 'router', onFailure: 'block' }] } } }));
    const ownerPath = vi.spyOn(ownerContext, 'ownerScopedPath').mockReturnValue(file);
    const owner = vi.spyOn(ownerContext, 'activeDataOwnerId').mockReturnValue('fixture');
    let read: { mockRestore(): void } | undefined;
    let stat: { mockRestore(): void } | undefined;
    let exists: { mockRestore(): void } | undefined;
    try {
      (runtimePreferences as typeof runtimePreferences & { warmRuntimePluginSettings?: () => void }).warmRuntimePluginSettings?.();
      read = vi.spyOn(fs, 'readFileSync'); stat = vi.spyOn(fs, 'statSync'); exists = vi.spyOn(fs, 'existsSync');
      expect(runtimePreferences.readRuntimePluginSettings('unselected')).toBeUndefined();
      expect(runtimePreferences.readRuntimePluginSettings('selected')?.['will-start-turn']?.[0].pluginId).toBe('router');
      expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(exists).not.toHaveBeenCalled();
    } finally {
      read?.mockRestore(); stat?.mockRestore(); exists?.mockRestore(); owner.mockRestore(); ownerPath.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes only selected providers in task order', async () => {
    const f = fixture({ 'will-start-turn': [{ pluginId: 'second', onFailure: 'block' }, { pluginId: 'first', onFailure: 'block' }] });
    f.screen.mockImplementation(async (_point, data, target) => {
      if (!('route' in data)) throw new Error('Route fixture required');
      return { action: 'route', ghostId: target.pluginId, ghostName: target.pluginId,
        reason: '', route: { ...data.route, model: `${data.route.model}-next` } };
    });
    const apply = vi.fn(async (result: GhostRuntimeControlPointResult, data: GhostRuntimePointData) =>
      result.action === 'route' ? { ...data, route: result.route } : data);
    const output = await f.control.run('will-start-turn', 'task', async () => input, apply);
    expect(output?.route.model).toBe('m1-next-next');
    expect(f.screen.mock.calls.map(call => call[2].pluginId)).toEqual(['second', 'first']);
  });

  // New runtime latency contract, unit/fake clock: only transport wait consumes
  // the 5s turn budget, and exhaustion must retain each selected failure policy.
  it.each(['allow', 'skip', 'block'] as const)('bounds cumulative plugin wait and honors exhausted policy: %s', async onFailure => {
    let clock = 0;
    const settings = { 'will-start-turn': [{ pluginId: 'router', onFailure }] };
    const screen = vi.fn(async (_point: string, _data: unknown, _target: RuntimePluginTarget, timeoutMs?: number) => { clock += timeoutMs ?? 0; return { action: 'allow' as const }; });
    const control = createRuntimePluginControl({ readSettings: () => settings,
      captureOwner: () => () => true, screen, now: () => clock });
    control.beginTurn('task');
    const read = async () => { clock += 10_000; return input; };
    const apply = async () => { clock += 10_000; };
    for (let i = 0; i < 5; i++) await control.run('will-start-turn', 'task', read, apply);
    expect(screen.mock.calls.map(call => call[3])).toEqual([1000, 1000, 1000, 1000, 1000]);
    const pending = control.run('will-start-turn', 'task', read, apply);
    if (onFailure === 'allow') await expect(pending).resolves.toEqual(input);
    else await expect(pending).rejects.toMatchObject({ action: onFailure, failure: true });
    expect(screen).toHaveBeenCalledTimes(5);
  });

  // Shared memory_search has no App turn boundary. Unit/fake clock: exhausting
  // the App budget must not suppress later searches or renew the App budget.
  it('keeps memory searches independent after the same task exhausts its App budget', async () => {
    let clock = 0;
    const settings: RuntimePluginSettings = {
      'will-start-turn': Array.from({ length: 5 }, (_, i) => ({ pluginId: `router-${i}`, onFailure: 'block' })),
      'will-search-memory': [{ pluginId: 'memory', onFailure: 'allow' }],
    };
    const screen = vi.fn(async (point: string, _data: unknown, _target: RuntimePluginTarget, timeoutMs?: number): Promise<GhostRuntimeControlPointResult> => {
      clock += timeoutMs ?? 0;
      return point === 'will-search-memory'
        ? { action: 'memories', ghostId: 'memory', ghostName: 'Memory', entries: [{ id: 'm', title: 'Fixture', content: 'Reference' }] }
        : { action: 'allow' };
    });
    const control = createRuntimePluginControl({ readSettings: () => settings, captureOwner: () => () => true,
      screen, now: () => clock });
    const apply = vi.fn(async () => {});
    await control.run('will-start-turn', 'task', async () => input, apply);
    expect(clock).toBe(5000);
    const providers = createRuntimeContextProviders(control);
    for (let i = 0; i < 2; i++) {
      expect(await providers.search({ sessionId: 'task', query: 'fixture', limit: 10 }))
        .toMatchObject({ hits: [{ id: 'm', content: 'Reference', sourcePlugin: { id: 'memory' } }] });
    }
    expect(screen.mock.calls.filter(call => call[0] === 'will-search-memory').map(call => call[3])).toEqual([1500, 1500]);
    await expect(control.run('will-start-turn', 'task', async () => input, apply)).rejects.toMatchObject({ action: 'block', failure: true });
    expect(screen).toHaveBeenCalledTimes(7);
  });

  it.each(['will-compose-context', 'will-search-memory'] as const)('collects %s concurrently but merges in the selected order', async point => {
    let settings: RuntimePluginSettings = { [point]: [
      { pluginId: 'first', onFailure: 'allow' }, { pluginId: 'second', onFailure: 'allow' },
    ] };
    const answers = new Map<string, (value: GhostRuntimeControlPointResult) => void>();
    const screen = vi.fn((_point: string, _data: unknown, target: RuntimePluginTarget) => new Promise<GhostRuntimeControlPointResult>(resolve => answers.set(target.pluginId, resolve)));
    const control = createRuntimePluginControl({ readSettings: () => settings, captureOwner: () => () => true, screen });
    const providers = createRuntimeContextProviders(control);
    const collect = () => point === 'will-compose-context' ? providers.compose('task', 'reference')
      : providers.search({ sessionId: 'task', query: 'reference', limit: 10 });
    const pending = collect();
    await Promise.resolve(); await Promise.resolve();
    expect(screen).toHaveBeenCalledTimes(2);
    for (const id of ['second', 'first']) answers.get(id)!(point === 'will-compose-context'
      ? { action: 'context', ghostId: id, ghostName: id, blocks: [{ id, text: id }] }
      : { action: 'memories', ghostId: id, ghostName: id, entries: [{ id, title: id, content: id }] });
    const output = await pending;
    const ordered = typeof output === 'string' ? output : output!.hits.map(hit => hit.id).join(',');
    expect(ordered.indexOf('first')).toBeLessThan(ordered.indexOf('second'));
    settings = {};
    expect(collect()).toBeUndefined();
  });

  // A new message must renew the shared budget even when only context is selected.
  // Unit/fake clock: the prior request-routing fixture cannot cover this entry.
  it('renews context-only message budgets without reading input or a model route', async () => {
    let clock = 0;
    const settings = { 'will-compose-context': [{ pluginId: 'context', onFailure: 'allow' as const }] };
    const timeouts: number[] = [];
    const control = createRuntimePluginControl({ readSettings: () => settings, captureOwner: () => () => true, now: () => clock,
      screen: async (_point, _data, _target, timeoutMs) => {
        timeouts.push(timeoutMs!); clock += Math.min(1800, timeoutMs!);
        return { action: 'context', ghostId: 'context', ghostName: 'Context', blocks: [{ id: 'b', text: 'reference' }] };
      } });
    const readRoute = vi.fn(async () => input.route);
    const readContent = vi.fn(() => 'message');
    const service = createTaskRuntimePlugins({ control, readSettings: () => settings, readRoute,
      routeAvailable: async () => true, applyRoute: vi.fn(), changed: vi.fn() });
    const providers = createRuntimeContextProviders(control);
    const message = { get content() { return readContent(); } };
    await service.prepare('task', message);
    for (let i = 0; i < 3; i++) expect(await providers.compose('task', 'reference')).toContain('reference');
    expect(await providers.compose('task', 'reference')).toBe('');
    await service.prepare('task', message);
    expect(await providers.compose('task', 'reference')).toContain('reference');
    expect(timeouts).toEqual([2000, 2000, 1400, 2000]);
    expect(readRoute).not.toHaveBeenCalled();
    expect(readContent).not.toHaveBeenCalled();
  });

  it('caps merged provider memories globally and marks truncated results', async () => {
    const settings = { 'will-search-memory': ['first', 'second', 'third'].map(pluginId => ({ pluginId, onFailure: 'allow' as const })) };
    const control = createRuntimePluginControl({ readSettings: () => settings, captureOwner: () => () => true,
      screen: async (_point, _data, target) => ({ action: 'memories', ghostId: target.pluginId, ghostName: target.pluginId,
        entries: [{ id: target.pluginId, title: target.pluginId, content: target.pluginId === 'third' ? 'tail' : 'x'.repeat(20_000) }] }) });
    const result = await createRuntimeContextProviders(control).search({ sessionId: 'task', query: 'memory', limit: 50 });
    expect(result).toMatchObject({ truncated: true });
    expect(result!.hits.map(hit => hit.id)).toEqual(['first', 'second']);
    expect(result!.hits.reduce((sum, hit) => sum + hit.content.length, 0)).toBe(32768);
    expect(result!.hits[1].truncated).toBe(true);
  });

  it('shares one request budget across select and payload and resets it for the next request', async () => {
    let clock = 0;
    const settings = { 'will-model-request': [{ pluginId: 'request', onFailure: 'allow' as const }] };
    const timeouts: number[] = [];
    const control = createRuntimePluginControl({ readSettings: () => settings, captureOwner: () => () => true, now: () => clock,
      screen: async (_point, _data, _target, timeoutMs) => { timeouts.push(timeoutMs!); clock += Math.min(600, timeoutMs!); return { action: 'allow' }; } });
    const service = createTaskRuntimePlugins({ control, readSettings: () => settings, readRoute: async () => input.route,
      routeAvailable: async () => true, applyRoute: vi.fn(), changed: vi.fn() });
    const options = await service.prepare('task', 'message');
    const callback = options![MODEL_REQUEST_CONTROL]!;
    await callback({ phase: 'select', providerId: 'p', model: 'm1' });
    await callback({ phase: 'payload', providerId: 'p', model: 'm1', request: { model: 'm1' } });
    await callback({ phase: 'select', providerId: 'p', model: 'm1' });
    expect(timeouts).toEqual([1000, 400, 1000]);
  });

  it('caps the aggregate memory count at fifty in selected order', async () => {
    const settings = { 'will-search-memory': ['first', 'second'].map(pluginId => ({ pluginId, onFailure: 'allow' as const })) };
    const control = createRuntimePluginControl({ readSettings: () => settings, captureOwner: () => () => true,
      screen: async (_point, _data, target) => ({ action: 'memories', ghostId: target.pluginId, ghostName: target.pluginId,
        entries: Array.from({ length: 31 }, (_, i) => ({ id: `${target.pluginId}-${i}`, title: 'title', content: 'x' })) }) });
    const result = await createRuntimeContextProviders(control).search({ sessionId: 'task', query: 'memory', limit: 50 });
    expect(result?.truncated).toBe(true);
    expect(result?.hits).toHaveLength(50);
    expect(result!.hits[30].id).toBe('first-30');
    expect(result!.hits[49].id).toBe('second-18');
  });

  it.each(['allow', 'skip', 'block'] as const)('uses the task policy when a host effect fails: %s', async onFailure => {
    const f = fixture({ 'will-start-turn': [{ pluginId: 'router', onFailure }] });
    f.screen.mockResolvedValue({ action: 'route', ghostId: 'router', ghostName: 'Router', reason: '', route: input.route });
    f.apply.mockRejectedValue(new Error('unavailable route'));
    const pending = f.control.run('will-start-turn', 'task', async () => input, f.apply);
    if (onFailure === 'allow') await expect(pending).resolves.toEqual(input);
    else await expect(pending).rejects.toMatchObject({ action: onFailure, failure: true });
  });

  it.each(['selection', 'owner'] as const)('discards a late answer after %s changes', async boundary => {
    const f = fixture({ 'will-start-turn': [{ pluginId: 'router', onFailure: 'allow' }] });
    let answer!: (result: GhostRuntimeControlPointResult) => void;
    f.screen.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
    const pending = f.control.run('will-start-turn', 'task', async () => input, f.apply);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    if (boundary === 'owner') f.revokeOwner();
    else f.setSettings({});
    answer({ action: 'route', ghostId: 'router', ghostName: 'Router', reason: '', route: input.route });
    await expect(pending).rejects.toBeInstanceOf(RuntimePluginControlError);
    expect(f.apply).not.toHaveBeenCalled();
  });

  // Unit: exercise the host adapter used by send, including a malformed plugin
  // body and an unavailable route. Transport-only tests cannot observe either.
  it('routes before send and composes request bodies using the same task policy', async () => {
    const f = fixture({ 'will-start-turn': [{ pluginId: 'router', onFailure: 'block' }],
      'will-model-request': [{ pluginId: 'editor', onFailure: 'allow' }] });
    f.screen.mockImplementation(async (point, data, target) => point === 'will-start-turn'
      ? { action: 'route', ghostId: target.pluginId, ghostName: 'Router', reason: '', route: { ...input.route, model: 'm2' } }
      : { action: 'transform', ghostId: target.pluginId, ghostName: 'Editor', request: { ...('request' in data ? data.request : {}), messages: null } });
    let route = input.route;
    const applyRoute = vi.fn(async (_id, next) => { route = next; });
    const service = createTaskRuntimePlugins({ control: f.control,
      readSettings: () => ({ 'will-start-turn': [{ pluginId: 'router', onFailure: 'block' }],
        'will-model-request': [{ pluginId: 'editor', onFailure: 'allow' }] }),
      readRoute: async () => route, routeAvailable: async () => true, applyRoute, changed: vi.fn(),
    });
    const options = await service.prepare('task', 'hello');
    expect(applyRoute).toHaveBeenCalledOnce();
    expect(route.model).toBe('m2');
    const body = { model: 'm2', messages: [{ role: 'user', content: 'hello' }] };
    const output = await options![MODEL_REQUEST_CONTROL]!({ phase: 'payload', providerId: 'p', model: 'm2', request: body });
    expect(output.request).toEqual(body);
  });

  // Review regression, unit: an oversized Pi request cannot reach the plugin.
  // Apply the same task failure policy without a truncated provider body. The
  // existing malformed-response case only covers failures after plugin delivery.
  it.each(['allow', 'skip', 'block'] as const)('settles a request transport failure using task policy: %s', async onFailure => {
    const settings = { 'will-model-request': [{ pluginId: 'editor', onFailure }] };
    const f = fixture(settings);
    const service = createTaskRuntimePlugins({ control: f.control,
      readSettings: () => settings, readRoute: async () => input.route,
      routeAvailable: async () => true, applyRoute: vi.fn(), changed: vi.fn(),
    });
    const options = await service.prepare('task', 'hello');
    const pending = options![MODEL_REQUEST_CONTROL]!({ phase: 'payload', providerId: 'p', model: 'm1',
      failure: 'request-too-large' });
    if (onFailure === 'block') await expect(pending).rejects.toMatchObject({ action: 'block', failure: true });
    else await expect(pending).resolves.toEqual(onFailure === 'skip' ? { skip: true } : { request: undefined });
    expect(f.screen).not.toHaveBeenCalled();
  });

  // Provider origin belongs to the Host, and search input is the query alone.
  // Unit: production provider adapter, selected-only transport, no storage copy.
  it('supplies attributed context and memories only for the selected task', async () => {
    const f = fixture({ 'will-compose-context': [{ pluginId: 'context', onFailure: 'block' }],
      'will-search-memory': [{ pluginId: 'memory', onFailure: 'allow' }] });
    f.screen.mockImplementation(async (point, _data, target) => point === 'will-compose-context'
      ? { action: 'context', ghostId: target.pluginId, ghostName: 'Context', blocks: [{ id: 'b', text: 'reference' }] }
      : { action: 'memories', ghostId: target.pluginId, ghostName: 'Memory', entries: [{ id: 'm', title: 'Title', content: 'memory' }] });
    const providers = createRuntimeContextProviders(f.control);
    expect(await providers.compose('task', 'read only')).toContain('"sourcePlugin":{"id":"context","name":"Context"}');
    expect(await providers.search({ sessionId: 'task', query: 'word', limit: 10 })).toEqual({ hits: [
      { id: 'm', title: 'Title', content: 'memory', sourcePlugin: { id: 'memory', name: 'Memory' } },
    ] });
    expect(f.screen.mock.calls[1][1]).toEqual({ sessionId: 'task', query: 'word', limit: 10 });
    f.setSettings({});
    expect(providers.compose('task', 'private')).toBeUndefined();
    expect(providers.search({ sessionId: 'task', query: 'private', limit: 10 })).toBeUndefined();
    expect(f.screen).toHaveBeenCalledTimes(2);
  });
});
