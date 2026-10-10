// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginCardActions } from "../plugins/PluginCardActions";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) =>
    createElement("div", {}, children);
  return {
    View,
    KeyboardAvoidingView: View,
    Pressable: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress(): void;
      disabled: boolean;
    }) => createElement("button", { onClick: onPress, disabled }, children),
    Modal: ({
      children,
      visible,
    }: {
      children?: ReactNode;
      visible: boolean;
    }) => (visible ? createElement("div", {}, children) : null),
    Platform: { OS: "ios" },
    StyleSheet: { create: (value: unknown) => value },
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => {} }),
    },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn() },
  };
});
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: { children?: ReactNode }) =>
    createElement("span", {}, children),
  TextInput: () => null,
}));
vi.mock("@/theme", () => ({ useThemedStyles: () => ({}) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("expo-router", () => ({ useIsFocused: () => true }));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: h.invoke, status: "online" }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => ({ accountKey: "owner" }),
  isMobileAuthOwnerCurrent: () => true,
}));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  vi.clearAllMocks();
});
describe("native plugin card deliberate actions", () => {
  it.each([false, true])(
    "releases only a known successful delivery (unknown=%s)",
    async (unknown) => {
      const dispatch = vi.fn(async () => {
        if (unknown) throw new Error("lost receipt");
        return { effects: [] };
      });
      h.invoke.mockImplementation(
        async (_device: string, _channel: string, args: any[]) => {
          if (args[0].collectionId === "plugin-results") return dispatch();
          if (args[0].actionId === "open-interaction")
            return { result: { pageId: "page" } };
          if (args[0].actionId === "poll") return { result: { confirms: [] } };
          return { effects: [] };
        },
      );
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      unmount = () => {
        act(() => root.unmount());
        container.remove();
      };
      await act(async () =>
        root.render(
          createElement(PluginCardActions, {
            deviceId: "device",
            sessionId: "session",
            callId: "call",
            data: {
              pluginId: "practice",
              revision: "unchanged",
              items: [{ id: "again", label: "Again", disabled: false }],
            },
          }),
        ),
      );
      const button = container.querySelector("button")!;
      await act(async () => button.click());
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(button.disabled).toBe(unknown);
      await act(async () => button.click());
      expect(dispatch).toHaveBeenCalledTimes(unknown ? 1 : 2);
    },
  );
});
