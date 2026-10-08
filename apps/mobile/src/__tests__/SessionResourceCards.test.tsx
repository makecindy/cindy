// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteResource } from "@cindy/device-link";
import { SessionResourceCards } from "@/session/SessionResourceCards";
import type { useSessionResourceCards } from "@/session/useSessionResourceCards";

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    View,
    Text: View,
    ScrollView: View,
    ActivityIndicator: () => createElement("progress"),
    StyleSheet: { create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
}));
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  return {
    MainWindowActionButton: ({
      action,
    }: {
      action: { label: string; onPress(): void; disabled?: boolean };
    }) =>
      createElement(
        "button",
        { onClick: action.onPress, disabled: action.disabled },
        action.label,
      ),
  };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (value: typeof tokens.lightColors) => unknown) =>
      make(tokens.lightColors),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type State = ReturnType<typeof useSessionResourceCards>;
const card: RemoteResource = {
  ref: { collectionId: "workflow", kind: "session", id: "task" },
  revision: "1",
  display: { title: "Preparing test" },
  links: [],
  blocks: [
    {
      id: "controls",
      primitive: "session-controls",
      fallbackMarkdown: "Preparing test",
      data: { input: "blocked" },
    },
  ],
  actions: [{ id: "start", label: "Start" }],
};
const state = (patch: Partial<State>): State => ({
  resources: [],
  failed: false,
  fresh: true,
  pending: null,
  act: vi.fn(),
  openLink: vi.fn(),
  blocked: false,
  blockedReason: undefined,
  ...patch,
});
let root: Root | undefined;
let host: HTMLDivElement;
function render(value: State) {
  host = document.createElement("div");
  root = createRoot(host);
  act(() =>
    root!.render(createElement(SessionResourceCards, { state: value })),
  );
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe("SessionResourceCards failure presentation", () => {
  it("renders nothing when the first manifest read fails", () => {
    render(state({ failed: true, fresh: false }));
    expect(host.textContent).toBe("");
  });
  it("shows a failed read of known cards as syncing, without a retry card", () => {
    render(
      state({ resources: [card], failed: true, fresh: false, blocked: true }),
    );
    expect(host.textContent).toContain("Preparing test");
    expect(host.textContent).toContain("shared.syncing");
    expect(host.querySelector("progress")).not.toBeNull();
    expect(host.textContent).not.toContain("session.screen.operationFailed");
    expect(host.textContent).not.toContain("devices.resources.retry");
    expect(host.querySelector("button")?.disabled).toBe(true);
  });
  it("shows syncing while input stays blocked before any card is readable", () => {
    render(state({ failed: true, fresh: false, blocked: true }));
    expect(host.textContent).toBe("shared.syncing");
    expect(host.querySelector("button")).toBeNull();
  });
});
