import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findRememberedMode,
  readRememberedResolution,
  rememberResolution,
} from "../resolutionMemory";

// Node >= 25 replaces jsdom's localStorage (AsyncStorage's web fallback) with a
// method-less stub, so keep storage in memory like the other mobile tests.
const storage = vi.hoisted(() => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: async (key: string) => {
      items.delete(key);
    },
    getAllKeys: async () => [...items.keys()],
    multiRemove: async (keys: readonly string[]) => {
      keys.forEach((key) => items.delete(key));
    },
    clear: async () => items.clear(),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storage,
}));

const key = "cindy.mobile.remote-desktop.resolution.v1.computer.display";
const modes = [
  { id: "a", width: 1920, height: 1080, current: true },
  { id: "b", width: 2560, height: 1440, current: false },
  { id: "c", width: 2560, height: 1440, current: false },
];

describe("remote desktop resolution memory", () => {
  beforeEach(() => {
    storage.items.clear();
  });

  it("stores the choice per computer and monitor", async () => {
    const mode = {
      kind: "mode" as const,
      modeId: "b",
      width: 2560,
      height: 1440,
    };
    await rememberResolution("computer", "display", mode);
    expect(await readRememberedResolution("computer", "display")).toEqual(mode);
    expect(await readRememberedResolution("computer", "other")).toBeNull();
    expect(await readRememberedResolution("other", "display")).toBeNull();
  });

  it("remembers the fitted size with its viewport and forgets on restore", async () => {
    const fit = {
      kind: "fit" as const,
      width: 658,
      height: 1280,
      viewport: { width: 390, height: 760 },
    };
    await rememberResolution("computer", "display", fit);
    expect(await readRememberedResolution("computer", "display")).toEqual(fit);
    await rememberResolution("computer", "display", null);
    expect(await readRememberedResolution("computer", "display")).toBeNull();
  });

  it("keeps the app window of a fit and drops an invalid one", async () => {
    const fit = {
      kind: "fit" as const,
      width: 658,
      height: 1280,
      viewport: { width: 390, height: 760 },
    };
    const window = { width: 390, height: 844 };
    await rememberResolution("computer", "display", { ...fit, window });
    expect(await readRememberedResolution("computer", "display")).toEqual({
      ...fit,
      window,
    });
    await AsyncStorage.setItem(
      key,
      JSON.stringify({ ...fit, window: { width: "390", height: 844 } }),
    );
    expect(await readRememberedResolution("computer", "display")).toEqual(fit);
  });

  it("ignores malformed stored values", async () => {
    await AsyncStorage.setItem(
      key,
      '{"kind":"mode","modeId":"b","width":"2560","height":1440}',
    );
    expect(await readRememberedResolution("computer", "display")).toBeNull();
    await AsyncStorage.setItem(key, '{"kind":"fit","width":658,"height":1280}');
    expect(await readRememberedResolution("computer", "display")).toBeNull();
    await AsyncStorage.setItem(key, "not json");
    expect(await readRememberedResolution("computer", "display")).toBeNull();
  });

  it("matches the same mode id, then falls back to the same size", () => {
    expect(
      findRememberedMode(modes, { modeId: "c", width: 2560, height: 1440 })?.id,
    ).toBe("c");
    expect(
      findRememberedMode(modes, { modeId: "gone", width: 2560, height: 1440 })
        ?.id,
    ).toBe("b");
    expect(
      findRememberedMode(modes, { modeId: "a", width: 3840, height: 2160 }),
    ).toBeUndefined();
  });
});
