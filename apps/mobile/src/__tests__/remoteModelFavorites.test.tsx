// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  push: null as null | ((device: string) => void),
  view: null as any,
  context: {
    connectionEpoch: 1,
    status: "online",
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  },
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ ...h.context, invoke: h.invoke }),
  subscribeRemoteFavoritesChanged: (fn: any) => {
    h.push = fn;
    return () => {
      h.push = null;
    };
  },
}));
import {
  useRemoteMobileFavorites,
  mobileFavorite,
  mobileFavoriteMutation,
} from "@/session/useRemoteMobileFavorites";
const item = {
  uid: "fav-1",
  providerId: "account",
  modelId: "model",
  agent: "cc" as const,
  effort: "high",
};
function Probe({ device = "a" }: { device?: string }) {
  h.view = useRemoteMobileFavorites(JSON.stringify(["user", device]), true);
  return null;
}
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.invoke.mockReset().mockResolvedValue([item]);
  h.context.status = "online";
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));
it("maps engine spelling and treats unchanged field order as no operation", () => {
  const mobile = mobileFavorite(item);
  expect(mobile.agent).toBe("claude-code");
  expect(
    mobileFavoriteMutation(
      [item],
      [
        {
          agent: mobile.agent,
          modelId: mobile.modelId,
          providerId: mobile.providerId,
          effort: "high",
          fast: false,
          uid: "fav-1",
        },
      ],
    ),
  ).toBeNull();
  expect(
    mobileFavoriteMutation([item], [{ ...mobile, fast: true }]),
  ).toMatchObject({
    kind: "update",
    expected: item,
    item: { agent: "cc", fast: true },
  });
  expect(mobileFavoriteMutation([item], [])).toEqual({
    kind: "remove",
    expected: item,
  });
});
it("reads only the controlled computer and reloads on its invalidation", async () => {
  await act(async () => root.render(createElement(Probe, {})));
  expect(h.invoke).toHaveBeenCalledWith("a", "maker:model-favorites:get", []);
  expect(h.view.items).toEqual([mobileFavorite(item)]);
  await act(async () => h.push?.("b"));
  expect(h.invoke).toHaveBeenCalledTimes(1);
  h.invoke.mockResolvedValue([]);
  await act(async () => h.push?.("a"));
  expect(h.view.items).toEqual([]);
});
it("discards a late snapshot when the target changes", async () => {
  let resolve!: (v: unknown) => void;
  h.invoke.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await act(async () => root.render(createElement(Probe, {})));
  h.invoke.mockResolvedValue([{ ...item, providerId: "other" }]);
  await act(async () => root.render(createElement(Probe, { device: "b" })));
  await act(async () => resolve([item]));
  expect(h.view.items[0].providerId).toBe("other");
});
it("writes a single mutation and re-reads after confirmed save", async () => {
  await act(async () => root.render(createElement(Probe, {})));
  h.invoke.mockImplementation(async (_device, channel) =>
    channel.endsWith(":apply") ? [] : [],
  );
  await act(async () => h.view.save([]));
  expect(h.invoke).toHaveBeenCalledWith("a", "maker:model-favorites:apply", [
    { kind: "remove", expected: item },
  ]);
  expect(h.view.items).toEqual([]);
});
it("old hosts do not fall back to local favorites or claim successful saves", async () => {
  h.invoke.mockRejectedValue(new Error("CHANNEL_NOT_ALLOWED"));
  await act(async () => root.render(createElement(Probe, {})));
  expect(h.view.items).toEqual([]);
  expect(h.view.error).toBeTruthy();
  await expect(h.view.save([mobileFavorite(item)])).rejects.toThrow(
    "not ready",
  );
});
