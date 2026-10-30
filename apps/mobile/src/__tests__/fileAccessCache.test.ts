import { describe, expect, it, vi } from "vitest";
import { sharedTaskHostPeer } from "@cindy/device-link";
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
    }, "device-a");
    expect(
      getCachedPreviewText("account-a/device-b", "/same", "a", 1, "device-b"),
    ).toBeNull();
    expect(
      getCachedPreviewText("account-b/device-a", "/same", "a", 1, "device-a"),
    ).toBeNull();
    // A changed listing mtime doesn't block rendering the previous bounded text.
    expect(getCachedPreviewText("account-a/device-a", "/same", "a", 2, "device-a")?.lines).toEqual(['private']);
  });
  it("does not serve or retain shared-task preview bodies across opens", () => {
    const guest = sharedTaskHostPeer("shared-task", "host");
    const scope = JSON.stringify(["account", guest]);
    const body = { lines: ["private"], totalLines: 1, truncated: false };
    // An old entry must not bypass the next host authorization check.
    storeCachedPreviewText(scope, "/shared", "old.md", 1, body, "host");
    expect(getCachedPreviewText(scope, "/shared", "old.md", 2, guest)).toBeNull();
    // Even an authorized guest read must not seed a future cache-first reopen.
    storeCachedPreviewText(scope, "/shared", "new.md", 1, body, guest);
    expect(getCachedPreviewText(scope, "/shared", "new.md", 1, "host")).toBeNull();
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
