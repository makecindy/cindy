import { expect, it, vi } from 'vitest';
import type { SchedulerHookScriptService } from '../types.js';
import { RoutineEngine, type RoutineState } from '@cindy/maker-scheduler';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { registerBotRoutineTools, type BotRoutineCallbacks } from '../xdt-helper/botRoutineTools.js';

it('creates and reads back a persistent routine through the essential companion tools, then triggers it', async () => {
  let snapshot: RoutineState | null = null;
  let now = 1000;
  let sequence = 0;
  const execute = vi.fn(async () => ({ resultText: '起来活动一下吧' }));
  const engine = new RoutineEngine({
    load: async () => snapshot,
    save: async (state) => { snapshot = structuredClone(state); },
    now: () => now, id: () => String(++sequence), execute,
    changed: vi.fn(), onError: vi.fn(),
  });
  await engine.start();
  const resolveBotId = vi.fn(async () => 'my-bot');
  const service: BotRoutineCallbacks['service'] = {
    list: async (id) => engine.list(id), sources: async () => engine.listSources(),
    save: (botId, input, id) => engine.put(botId, input, id),
    remove: (botId, id) => engine.remove(botId, id),
    history: async (_botId, id) => engine.history(id),
    runNow: (botId, id) => engine.runNow(botId, id),
  };
  const registry = new XdtHelperToolRegistry();
  registerBotRoutineTools(registry, { service, resolveBotId }, () => 'canonical-session');
  expect(registry.list('bots').map((tool) => tool.name)).toContain('routine_save');
  const args = {
    name: '休息提醒', prompt: '提醒我休息一下', enabled: true, silentWhenIdle: false, preRunHook: { command: 'node check.mjs', timeoutMs: 3000 },
    triggers: [{ id: 'minute', kind: 'interval', intervalMs: 60000 }],
  };
  const denied = await registry.call('routine_save', { ...args, botId: 'someone-else' });
  expect(denied.isError).toBe(true);
  expect(engine.list()).toHaveLength(0);
  expect((await registry.call('routine_save', args)).isError).not.toBe(true);
  const read = await registry.call('routine_list', {});
  expect(JSON.parse((read.content[0] as { text: string }).text).result).toHaveLength(1);
  expect(snapshot!.routines[0].botId).toBe('my-bot');
  expect(snapshot!.routines[0]).toMatchObject({ silentWhenIdle: false, preRunHook: args.preRunHook });
  expect(snapshot!.routines[0].triggers).toEqual(args.triggers);
  expect(resolveBotId).toHaveBeenCalledWith('canonical-session');
  now += 60000;
  await engine.tick();
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  await engine.stop();
});

it('does not access the native service for an unbound caller', async () => {
  const registry = new XdtHelperToolRegistry();
  const list = vi.fn();
  const resolveBotId = vi.fn(async () => { throw new Error('not canonical'); });
  registerBotRoutineTools(registry, {
    service: { list } as unknown as BotRoutineCallbacks['service'], resolveBotId,
  }, () => undefined);
  expect((await registry.call('routine_list', {})).isError).toBe(true);
  expect(resolveBotId).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});

it('rejects unrelated and background callers before reaching any routine operation', async () => {
  const registry = new XdtHelperToolRegistry();
  const operation = vi.fn();
  const service: BotRoutineCallbacks['service'] = {
    list: operation, sources: operation, save: operation,
    history: operation, remove: operation, runNow: operation,
  };
  registerBotRoutineTools(registry, {
    service, resolveBotId: async () => { throw new Error('not canonical'); },
  }, () => 'ordinary-background-session');
  for (const name of ['routine_list', 'routine_sources', 'routine_history', 'routine_delete', 'routine_run_now']) {
    const args = ['routine_list', 'routine_sources'].includes(name) ? {} : { id: 'routine' };
    expect((await registry.call(name, args)).isError).toBe(true);
  }
  expect((await registry.call('routine_save', {
    name: 'Other', prompt: 'Do work', enabled: true,
    triggers: [{ id: 'tick', kind: 'interval', intervalMs: 60000 }],
  })).isError).toBe(true);
  expect(operation).not.toHaveBeenCalled();
});


it('exposes caller-bound notification and installer without executing checks during discovery', async () => {
  const registry = new XdtHelperToolRegistry();
  const notifyRun = vi.fn(() => true);
  const resolveInflightRunForSession = vi.fn(() => 'current-run');
  const install = vi.fn<SchedulerHookScriptService['install']>(async () => ({ command: 'node installed.mjs', filePath: '/checks/installed.mjs', content: 'process.exit(2)', test: { decision: 'skip', status: 'skipped', exitCode: 2, timedOut: false, aborted: false, durationMs: 1, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false } }));
  registerBotRoutineTools(registry, {
    service: {} as BotRoutineCallbacks['service'], resolveBotId: async () => 'bot',
    scheduler: { getScheduler: () => ({ notifyRun, resolveInflightRunForSession }) as never,
      hookScript: { install, resolveSessionWorkDir: async () => '/routine' } },
  }, () => 'canonical');
  expect(registry.list('bots').map((tool) => tool.name)).toContain('schedule_notify_current_run');
  expect(registry.get('schedule_set_pre_run_hook')?.inputShape).not.toHaveProperty('workingDir');
  expect(install).not.toHaveBeenCalled();
  expect((await registry.call('schedule_notify_current_run', {})).isError).not.toBe(true);
  expect(resolveInflightRunForSession).toHaveBeenCalledWith('canonical');
  expect(notifyRun).toHaveBeenCalledExactlyOnceWith('current-run');
  expect((await registry.call('schedule_notify_current_run', { runId: 'other' })).isError).toBe(true);
  expect((await registry.call('schedule_set_pre_run_hook', { script: 'process.exit(2)', scheduleId: 'other' })).isError).toBe(true);
  expect((await registry.call('schedule_set_pre_run_hook', { script: 'process.exit(2)', workingDir: '/unrelated' })).isError).toBe(true);
  expect(install).not.toHaveBeenCalled();
  expect((await registry.call('schedule_set_pre_run_hook', { script: 'process.exit(2)' })).isError).not.toBe(true);
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ workingDir: '/routine' }));
});

it('does not install a companion check when its canonical workspace cannot be resolved', async () => {
  const registry = new XdtHelperToolRegistry();
  const install = vi.fn<SchedulerHookScriptService['install']>();
  registerBotRoutineTools(registry, {
    service: {} as BotRoutineCallbacks['service'], resolveBotId: async () => 'bot',
    scheduler: { getScheduler: () => ({}) as never,
      hookScript: { install, resolveSessionWorkDir: async () => undefined } },
  }, () => 'canonical');
  expect((await registry.call('schedule_set_pre_run_hook', { script: 'process.exit(2)' })).isError).toBe(true);
  expect(install).not.toHaveBeenCalled();
});
