import { expect, it } from "vitest";
import {
  requestSessionTagCatalog,
  encodeModelSpeedPayload,
  decodeModelSpeedPayload,
  encodeSessionTagCatalog,
  decodeSessionTagCatalog,
} from "../sessionListTransport.js";

const channel = "local-db:sessions:list";
const options = [1000, "archived", { tagCatalog: 1 }];
it("opts in without mutating arguments and preserves legacy responses and peers", () => {
  const input = {
    channel,
    args: [20, "active", { fresh: true, includePinned: true }],
  };
  expect(requestSessionTagCatalog(input).args[2]).toEqual({
    fresh: true,
    includePinned: true,
    tagCatalog: 1,
  });
  expect(input.args[2]).toEqual({ fresh: true, includePinned: true });
  const rows = [{ id: "a", tags: [] }, { id: "b" }];
  expect(encodeSessionTagCatalog(channel, [], rows)).toBe(rows);
  expect(decodeSessionTagCatalog(channel, rows)).toBe(rows);
});
it("keeps every row and tag while reducing a >4MiB result below legacy frame limits", () => {
  const tags = Array.from({ length: 32 }, (_, i) => ({
    id: `tag-${i}`,
    name: "字".repeat(80),
    color: "blue",
    revision: 1,
  }));
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i),
    title: "task",
    tags,
  }));
  const packed = encodeSessionTagCatalog(channel, options, rows);
  expect(Buffer.byteLength(JSON.stringify(rows))).toBeGreaterThan(
    4 * 1024 * 1024,
  );
  expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThan(
    2 * 1024 * 1024,
  );
  expect(decodeSessionTagCatalog(channel, packed)).toEqual(rows);
});
it("preserves absent/empty tags, order and differing versions of the same tag ID", () => {
  const rows = [
    { id: "a" },
    { id: "b", tags: [] },
    { id: "c", tags: [{ id: "x", name: "Old" }] },
    { id: "d", tags: [{ id: "x", name: "New" }] },
  ];
  expect(
    decodeSessionTagCatalog(
      channel,
      encodeSessionTagCatalog(channel, options, rows),
    ),
  ).toEqual(rows);
});
it("rejects broken references instead of silently losing labels", () => {
  for (const id of [-1, 1, 0.5, "0"])
    expect(() =>
      decodeSessionTagCatalog(channel, {
        format: "session-tag-catalog-v1",
        tags: [{}],
        sessions: [{ tagIds: [id] }],
      }),
    ).toThrow();
  expect(() =>
    decodeSessionTagCatalog(channel, { format: "unknown" }),
  ).toThrow();
});

// Compatibility tier: legacy clients validate fastMode as a boolean. Content is never rewritten.
it("projects Ultrafast as an additive setting and restores it for new clients", () => {
  const rows = [{ id: 's1', fastMode: 'ultrafast', runtimeEffective: { fastMode: 'ultrafast' },
    messages: [{ content: { fastMode: 'ultrafast' } }] }, { id: 's2', fastMode: false }];
  const wire = encodeModelSpeedPayload(channel, rows);
  expect(wire).toEqual([{ ...rows[0], fastMode: true, fastModeTier: 'ultrafast',
    runtimeEffective: { fastMode: true, fastModeTier: 'ultrafast' } }, rows[1]]);
  expect(decodeModelSpeedPayload(channel, wire)).toEqual(rows);
  expect(rows[0].fastMode).toBe('ultrafast');
  expect(encodeModelSpeedPayload('local-db:messages:list', rows)).toBe(rows);
  expect(decodeModelSpeedPayload(channel, [{ fastMode: false, fastModeTier: 'ultrafast' }]))
    .toEqual([{ fastMode: false, fastModeTier: 'ultrafast' }]);
  const push = { sessionId: 's1', patch: { fastMode: 'ultrafast' } };
  expect(decodeModelSpeedPayload('local-db:sessions:patched', encodeModelSpeedPayload('local-db:sessions:patched', push)))
    .toEqual(push);
  const favorite = [{ uid: 'f', fast: 'ultrafast' }];
  expect(decodeModelSpeedPayload('maker:model-favorites:get', encodeModelSpeedPayload('maker:model-favorites:get', favorite)))
    .toEqual(favorite);
});

// Protocol regression: real draft snapshots and teammate settings have distinct nesting.
// The session-list fixture above did not exercise these channels or model-keyed preferences.
it("keeps legacy draft and teammate speeds boolean while new clients recover the exact tier", () => {
  const defaults = {
    model: 'gpt-6.1-sol', fastMode: 'ultrafast',
    fastModeByModel: { 'gpt-6.1-sol': 'ultrafast', standard: false, fast: true },
    providerModelMemory: { 'codex:*': {
      effortByModel: { 'gpt-6.1-sol': 'ultra' },
      fastByModel: { 'gpt-6.1-sol': 'ultrafast' },
    } },
  };
  const projected = {
    ...defaults, fastMode: true, fastModeTier: 'ultrafast',
    fastModeByModel: { 'gpt-6.1-sol': true, standard: false, fast: true },
    fastModeByModelTiers: { 'gpt-6.1-sol': 'ultrafast' },
    providerModelMemory: { 'codex:*': {
      effortByModel: { 'gpt-6.1-sol': 'ultra' },
      fastByModel: { 'gpt-6.1-sol': true },
      fastByModelTiers: { 'gpt-6.1-sol': 'ultrafast' },
    } },
  };
  for (const [name, input, expected] of [
    ['maker:get-new-maker-defaults', defaults, projected],
    ['maker:new-maker-draft:changed', { claudeCode: {}, codex: defaults, pi: {} },
      { claudeCode: {}, codex: projected, pi: {} }],
  ] as const) {
    const wire = encodeModelSpeedPayload(name, input);
    expect(wire).toEqual(expected);
    expect(decodeModelSpeedPayload(name, wire)).toEqual(input);
  }
  const route = { harness: 'codex', model: 'gpt-6.1-sol', fastMode: 'ultrafast' };
  const bot = { id: 'bot', capabilities: {
    modelChain: [route], modelChainOverride: [route], modelOverride: route,
    content: { fastMode: 'ultrafast' },
  } };
  const wireRoute = { ...route, fastMode: true, fastModeTier: 'ultrafast' };
  const wire = encodeModelSpeedPayload('local-db:bots:get', bot);
  expect(wire).toEqual({ ...bot, capabilities: { ...bot.capabilities,
    modelChain: [wireRoute], modelChainOverride: [wireRoute], modelOverride: wireRoute } });
  expect(decodeModelSpeedPayload('local-db:bots:get', wire)).toEqual(bot);
  expect(defaults.fastMode).toBe('ultrafast');
});
