import { expect, it } from "vitest";
import {
  requestSessionTagCatalog,
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
