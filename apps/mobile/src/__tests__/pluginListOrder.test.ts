import { describe, expect, it } from "vitest";
import { sortPluginItems } from "@/plugins/pluginListOrder";
import { normalizeRemoteCollectionItems } from "@/device-link/remoteResources";
import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";

const row = (
  id: string,
  order?: HostedRemoteCollectionItem["item"]["pluginOrder"],
  device = "mac",
): HostedRemoteCollectionItem => ({
  key: device + ":" + id,
  host: { deviceId: device, deviceName: device },
  item: {
    ref: { collectionId: "plugins", kind: "plugin", id },
    display: { title: id, timestamp: 999999 },
    revision: "1",
    links: [],
    ...(order ? { pluginOrder: order } : {}),
  },
});
describe("installed plugin ordering", () => {
  it("preserves legacy order and promotes only known recent use", () => {
    const items = [row("a"), row("b")];
    expect(sortPluginItems(items, []).map((i) => i.key)).toEqual([
      "mac:a",
      "mac:b",
    ]);
    expect(sortPluginItems(items, ["mac:b"]).map((i) => i.key)).toEqual([
      "mac:b",
      "mac:a",
    ]);
    expect(sortPluginItems(items, ["other:b"]).map((i) => i.key)).toEqual([
      "mac:a",
      "mac:b",
    ]);
  });
  it("sorts real addition dates newest-first and keeps unknown chronology stable", () => {
    const items = [
      row("unknown"),
      row("old", { addedAt: 10 }),
      row("new", { addedAt: 20 }),
      row("also-unknown"),
    ];
    expect(sortPluginItems(items, []).map((item) => item.item.ref.id)).toEqual([
      "new",
      "old",
      "unknown",
      "also-unknown",
    ]);
    expect(items[0].item.ref.id).toBe("unknown");
  });
  it("uses local MRU before Host MRU, isolates the same plugin on different computers", () => {
    const items = [
      row("p", { addedAt: 10 }, "a"),
      row("p", { addedAt: 20 }, "b"),
      row("other", { recentIndex: 0 }),
    ];
    expect(sortPluginItems(items, ["a:p"]).map((item) => item.key)).toEqual([
      "a:p",
      "mac:other",
      "b:p",
    ]);
  });
  it("ignores malformed metadata and never uses notification time as an addition date", () => {
    const items = [
      row("first", { addedAt: NaN, recentIndex: -1 }),
      row("second", { addedAt: Infinity }),
    ];
    expect(sortPluginItems(items, []).map((item) => item.key)).toEqual([
      "mac:first",
      "mac:second",
    ]);
  });
  it("normalizes only inert plugin ordering facts, without dropping legacy items", () => {
    const items = normalizeRemoteCollectionItems(
      {
        items: [
          row("valid", { addedAt: 1234, recentIndex: 0 }).item,
          row("invalid", { addedAt: -1, recentIndex: 1.5 }).item,
          row("legacy").item,
        ],
      },
      "plugins",
    );
    expect(items).toHaveLength(3);
    expect(items[0].pluginOrder).toEqual({ addedAt: 1234, recentIndex: 0 });
    expect(items[1].pluginOrder).toBeUndefined();
    expect(items[2].pluginOrder).toBeUndefined();
  });
});
