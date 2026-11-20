import { expect, it } from "vitest";
import { parseRoutineInput, type RoutineInput } from "../routines.js";

const input: RoutineInput = {
  name: "PR review",
  prompt: "Check whether the new PR can merge",
  enabled: true,
  triggers: [
    {
      id: "github",
      kind: "event",
      sourceId: "github",
      eventType: "pr",
      filters: [{ field: "repo", operator: "equals", value: "team/app" }],
    },
    { id: "fallback", kind: "interval", intervalMs: 3600_000 },
  ],
};

it("rejects invalid timing and duplicate trigger identities", () => {
  expect(() =>
    parseRoutineInput({
      ...input,
      triggers: [{ id: "bad", kind: "interval", intervalMs: 0 }],
    }),
  ).toThrow("Interval");
  expect(() =>
    parseRoutineInput({
      ...input,
      triggers: [input.triggers[0], input.triggers[0]],
    }),
  ).toThrow("unique");
  expect(() =>
    parseRoutineInput({
      ...input,
      triggers: [
        { id: "bad", kind: "cron", expression: "invalid", timezone: "UTC" },
      ],
    }),
  ).toThrow();
});

it('keeps an explicit delivery destination and rejects an empty one', () => {
  const delivery = { kind: 'im' as const, targetId: 'connected-chat' };
  expect(parseRoutineInput({ ...input, delivery }).delivery).toEqual(delivery);
  expect(() => parseRoutineInput({ ...input, delivery: { kind: 'im', targetId: '' } })).toThrow();
});

it('normalizes the model discovery local sentinel in a routine route', () => {
  const parsed = parseRoutineInput({ ...input, modelOverride: { agentKind: 'pi', model: 'economy', providerId: 'connected', agentDeviceId: 'local' } });
  expect(parsed.modelOverride?.agentDeviceId).toBeNull();
});
