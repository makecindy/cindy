import { expect, it, vi } from "vitest";
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
