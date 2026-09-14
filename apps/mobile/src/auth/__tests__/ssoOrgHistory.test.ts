import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: storage.getItem,
    setItem: storage.setItem,
  },
}));

import {
  __testing,
  getSsoOrgHistorySnapshot,
  hydrateSsoOrgHistory,
  rememberSsoOrgIdentifier,
} from "../ssoOrgHistory";

beforeEach(() => {
  storage.values.clear();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  __testing.reset();
});

describe("mobile SSO organization history", () => {
  it("hydrates a versioned AsyncStorage record", async () => {
    storage.values.set(
      __testing.storageKey,
      JSON.stringify({ version: 1, entries: ["remembered-corp"] }),
    );
    await expect(hydrateSsoOrgHistory()).resolves.toEqual(["remembered-corp"]);
    expect(getSsoOrgHistorySnapshot()).toEqual(["remembered-corp"]);
  });

  it("serializes concurrent MRU writes without losing an entry", async () => {
    await Promise.all([
      rememberSsoOrgIdentifier("first-corp"),
      rememberSsoOrgIdentifier("second-corp"),
    ]);
    expect(getSsoOrgHistorySnapshot()).toEqual(["second-corp", "first-corp"]);
    expect(
      JSON.parse(storage.values.get(__testing.storageKey) ?? "{}"),
    ).toEqual({
      version: 1,
      entries: ["second-corp", "first-corp"],
    });
  });

  it("retries a failed read before persisting a new identifier", async () => {
    storage.values.set(
      __testing.storageKey,
      JSON.stringify({ version: 1, entries: ["saved-corp"] }),
    );
    storage.getItem.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(rememberSsoOrgIdentifier("new-corp")).resolves.toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(
      JSON.parse(storage.values.get(__testing.storageKey) ?? "{}"),
    ).toEqual({
      version: 1,
      entries: ["saved-corp"],
    });

    await expect(rememberSsoOrgIdentifier("new-corp")).resolves.toEqual([
      "new-corp",
      "saved-corp",
    ]);
  });

  it("keeps the in-memory result when persistence fails", async () => {
    storage.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(rememberSsoOrgIdentifier("memory-corp")).resolves.toEqual([
      "memory-corp",
    ]);
    expect(getSsoOrgHistorySnapshot()).toEqual(["memory-corp"]);
  });
});
