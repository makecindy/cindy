import { describe, expect, it, vi } from "vitest";
const store = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));
vi.mock("@/theme/ThemeProvider", () => ({
  useTheme: () => ({ mode: "light" }),
}));
import AsyncStorage from "@react-native-async-storage/async-storage";
import { saveUserBubblePreference } from "@/theme/userBubblePreference";
describe("mobile bubble appearance persistence", () => {
  it("serializes rapid choices and removes the override on reset", async () => {
    await Promise.all([
      saveUserBubblePreference("blue"),
      saveUserBubblePreference("red"),
    ]);
    expect([...store.values()]).toEqual(["red"]);
    await saveUserBubblePreference("default");
    expect(store.size).toBe(0);
  });
  it("reports save failures and lets the next choice recover", async () => {
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(
      new Error("disk full"),
    );
    await expect(saveUserBubblePreference("peach")).rejects.toThrow(
      "disk full",
    );
    await saveUserBubblePreference("sage");
    expect([...store.values()]).toEqual(["sage"]);
  });
});
