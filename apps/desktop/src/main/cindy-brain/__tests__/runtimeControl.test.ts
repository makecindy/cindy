import { describe, expect, it, vi } from 'vitest';
import { createRuntimePluginControl, RuntimePluginControlError } from '../runtimeControl.js';
import type { GhostRuntimeControlPointResult, GhostRuntimePointData } from '../../../shared/ghost.js';
import type { RuntimePluginPoint, RuntimePluginSettings, RuntimePluginTarget } from '../../../shared/pluginRuntime.js';
import { MODEL_REQUEST_CONTROL } from '@cindy/maker-core';
import { createTaskRuntimePlugins } from '../../maker-ipc/runtimePlugins.js';

// Test value: the production controller must never load data or call plugins for
// unselected tasks, must preserve selected order, and must not apply stale answers.
// Existing gateway tests cover one recipient; they do not cover task selection or
// host effects. Minimum failure: an empty selection or revocation during an ask.
// Tier: unit, injected transport, no processes/network/waits.
describe('task runtime plugin control', () => {
  const input: GhostRuntimePointData = { sessionId: 'task', text: 'work', route: { agentKind: 'pi', providerId: 'p', model: 'm1' } };

  function fixture(initial: RuntimePluginSettings = {}) {
    let settings = initial;
    let owner = true;
    const screen = vi.fn(async (_point: RuntimePluginPoint, _data: GhostRuntimePointData, _target: RuntimePluginTarget): Promise<GhostRuntimeControlPointResult> => ({ action: 'allow' }));
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
    expect(f.control.run('will-start-turn', 'task', read, f.apply)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
  });

  it('composes only selected providers in task order', async () => {
    const f = fixture({ 'will-start-turn': [{ pluginId: 'second', onFailure: 'block' }, { pluginId: 'first', onFailure: 'block' }] });
    f.screen.mockImplementation(async (_point, data, target) => ({ action: 'route', ghostId: target.pluginId, ghostName: target.pluginId,
      reason: '', route: { ...data.route, model: `${data.route.model}-next` } }));
    const apply = vi.fn(async (result: GhostRuntimeControlPointResult, data: GhostRuntimePointData) =>
      result.action === 'route' ? { ...data, route: result.route } : data);
    const output = await f.control.run('will-start-turn', 'task', async () => input, apply);
    expect(output?.route.model).toBe('m1-next-next');
    expect(f.screen.mock.calls.map(call => call[2].pluginId)).toEqual(['second', 'first']);
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
      ? { action: 'route', ghostId: target.pluginId, ghostName: 'Router', reason: '', route: { ...data.route, model: 'm2' } }
      : { action: 'transform', ghostId: target.pluginId, ghostName: 'Editor', request: { ...data.request, messages: null } });
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
});
