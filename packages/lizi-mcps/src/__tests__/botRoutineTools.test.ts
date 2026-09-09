import { expect, it, vi } from 'vitest';
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
    name: '休息提醒', prompt: '提醒我休息一下', enabled: true,
    triggers: [{ id: 'minute', kind: 'interval', intervalMs: 60000 }],
  };
  const denied = await registry.call('routine_save', { ...args, botId: 'someone-else' });
  expect(denied.isError).toBe(true);
  expect(engine.list()).toHaveLength(0);
  expect((await registry.call('routine_save', args)).isError).not.toBe(true);
  const read = await registry.call('routine_list', {});
  expect(JSON.parse((read.content[0] as { text: string }).text).result).toHaveLength(1);
  expect(snapshot!.routines[0].botId).toBe('my-bot');
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
