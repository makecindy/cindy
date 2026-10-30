import { expect, it, vi } from "vitest";
import { RoutineEngine, type RoutineState } from "@cindy/maker-scheduler";
import { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { registerBotRoutineTools } from "../xdt-helper/botRoutineTools.js";
import { SchedulerToolRegistry } from "../cindy_schedulerToolRegistry.js";
import { registerRoutineTools } from "../scheduler/routines.js";
import type { RoutineToolService } from "../types.js";
it("exposes local management only when supported and propagates the host error", async () => {
  const registry = new SchedulerToolRegistry();
  registerRoutineTools(registry, {});
  expect(registry.list()).toHaveLength(0);
  const save = vi.fn(async () => {
    throw new Error("Teammate not found");
  });
  registerRoutineTools(registry, {
    routines: { save },
  } as unknown as { routines: RoutineToolService });
  expect(registry.list().map((tool) => tool.name)).toEqual([
    "routine_list",
    "routine_sources",
    "routine_save",
    "routine_history",
    "routine_delete",
    "routine_run_now",
  ]);
  const result = await registry
    .get("routine_save")!
    .handler({
      botId: "bot",
      name: "Review",
      prompt: "Review PRs",
      enabled: true,
      triggers: [{ id: "tick", kind: "interval", intervalMs: 60000 }],
    });
  expect(result.isError).toBe(true);
  expect(result.content[0]).toEqual({
    type: "text",
    text: JSON.stringify({ ok: false, message: "Teammate not found" }),
  });
  expect(save).toHaveBeenCalledWith(
    "bot",
    expect.objectContaining({ name: "Review" }),
    undefined,
  );
});

it.each([
  { id: 'tick', kind: 'once' as const, at: 30000 },
  { id: 'tick', kind: 'interval' as const, intervalMs: 60000, anchorMs: 30000 },
].flatMap(trigger => ['scheduler', 'companion'].map(entry => ({ trigger, entry }))))(
  'preserves an imported $trigger.kind trigger when renamed through $entry', async ({ trigger, entry }) => {
    let snapshot: RoutineState | null = null;
    let now = 1000;
    let sequence = 0;
    const execute = vi.fn(async () => ({}));
    const engine = new RoutineEngine({
      load: async () => snapshot,
      save: async state => { snapshot = structuredClone(state); },
      now: () => now, id: () => String(++sequence), execute,
      changed: vi.fn(), onError: vi.fn(),
    });
    await engine.start();
    try {
      const input = { name: 'Imported', prompt: 'Read data', enabled: true, triggers: [trigger] };
      const imported = await engine.put('bot', input);
      const service: RoutineToolService = {
        list: async botId => engine.list(botId), sources: async () => engine.listSources(),
        save: (botId, value, id) => engine.put(botId, value, id),
        remove: (botId, id) => engine.remove(botId, id),
        history: async (_botId, id) => engine.history(id),
        runNow: (botId, id) => engine.runNow(botId, id),
      };
      const registry = entry === 'scheduler' ? new SchedulerToolRegistry() : new XdtHelperToolRegistry();
      if (registry instanceof SchedulerToolRegistry) registerRoutineTools(registry, { routines: service });
      else registerBotRoutineTools(registry, { service, resolveBotId: async () => 'bot' }, () => 'canonical');
      now = 20000;
      const result = await registry.call('routine_save', {
        ...input, id: imported.id, name: 'Renamed', ...(entry === 'scheduler' ? { botId: 'bot' } : {}),
      });
      expect(result.isError).not.toBe(true);
      expect(engine.list('bot')[0]).toMatchObject({ name: 'Renamed', triggers: [trigger] });
      expect(snapshot!.next[`${imported.id}:tick`]).toBe(30000);
      now = 29999;
      await engine.tick();
      expect(execute).not.toHaveBeenCalled();
      now = 30000;
      await engine.tick();
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    } finally { await engine.stop(); }
  },
);
