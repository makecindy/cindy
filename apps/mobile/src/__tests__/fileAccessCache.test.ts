import { describe, expect, it, vi } from "vitest";
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    multiRemove: vi.fn(async () => {}),
  },
}));
import {
  getCachedListingSync,
  storeCachedListing,
  getCachedPreviewText,
  storeCachedPreviewText,
  loadAllFilesIndex,
} from "@/session/fileBrowserCache";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
describe("file cache identity", () => {
  it("isolates identical paths and timestamps by account and device", () => {
    const entries = [
      { name: "a", relPath: "a", type: "file" as const, size: 1, mtimeMs: 1 },
    ];
    storeCachedListing("account-a/device-a", "/same", "", entries);
    expect(getCachedListingSync("account-a/device-a", "/same", "")).toEqual(
      entries,
    );
    expect(getCachedListingSync("account-a/device-b", "/same", "")).toBeNull();
    expect(getCachedListingSync("account-b/device-a", "/same", "")).toBeNull();
    storeCachedPreviewText("account-a/device-a", "/same", "a", 1, {
      lines: ["private"],
      totalLines: 1,
      truncated: false,
    });
    expect(
      getCachedPreviewText("account-a/device-b", "/same", "a", 1),
    ).toBeNull();
    expect(
      getCachedPreviewText("account-b/device-a", "/same", "a", 1),
    ).toBeNull();
  });
  it("does not coalesce indexes on different devices and preserves the real RPC path", async () => {
    const make = (scope: string) => ({
      fileBrowser: {
        cacheScope: scope,
        listAllFiles: vi.fn(async () => ({ files: [scope] })),
      },
    });
    const a = make("a"),
      b = make("b");
    const results = await Promise.all(
      [a, b].map((maker) =>
        loadAllFilesIndex(
          maker as unknown as MobileMakerTransport,
          "/real",
          10,
        ),
      ),
    );
    expect(results).toEqual([["a"], ["b"]]);
    expect(a.fileBrowser.listAllFiles).toHaveBeenCalledWith("/real", 10);
    expect(b.fileBrowser.listAllFiles).toHaveBeenCalledWith("/real", 10);
  });
});
