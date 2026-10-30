// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), owner: 1, locale: "zh-CN" }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: ({ children }: any) => createElement("div", {}, children),
    StyleSheet: { create: (styles: unknown) => styles },
  };
});
vi.mock("@/components/AppText", async () => {
  const { createElement } = await import("react");
  return { Text: ({ children }: any) => createElement("span", {}, children) };
});
vi.mock("@/session/CompanionCardButton", async () => {
  const { createElement } = await import("react");
  return {
    CompanionCardButton: ({ label, onPress, disabled, busy }: any) =>
      createElement(
        "button",
        { onClick: onPress, disabled: disabled || busy },
        label,
      ),
  };
});
vi.mock("@/theme", () => ({
  useThemedStyles: (make: (colors: unknown) => unknown) => make({}),
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ accountGeneration: h.owner }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => h.owner,
  isMobileAuthOwnerCurrent: (value: number) => value === h.owner,
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: h.invoke }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: h.locale },
  }),
}));
import { useThinkingTranslation } from "../session/useThinkingTranslation";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
function Harness({
  text = "Inspect files.",
  running = false,
}: {
  text?: string;
  running?: boolean;
}) {
  const translation = useThinkingTranslation(
    text,
    "b",
    "s",
    "device-1",
    running,
  );
  return createElement(
    "div",
    {},
    translation.displayContent,
    translation.controls,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 1;
  h.locale = "zh-CN";
  h.invoke.mockResolvedValue({ text: "检查文件。" });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
it("only translates on tap, uses the owning device, and switches locally", async () => {
  act(() => root.render(createElement(Harness)));
  expect(h.invoke).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(h.invoke).toHaveBeenCalledWith(
    "device-1",
    "maker:translate-thinking",
    [{ sessionId: "s", text: "Inspect files.", locale: "zh-CN" }],
    expect.objectContaining({ preSend: expect.any(Function) }),
  );
  expect(container.textContent).toContain("检查文件。");
  expect(container.textContent).toContain(
    "message.thinkingTranslation.machineTranslated",
  );
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Inspect files.");
  act(() => container.querySelector("button")!.click());
  expect(container.textContent).toContain("检查文件。");
  expect(h.invoke).toHaveBeenCalledTimes(1);
});
it("keeps the source and offers an update hint for an older host", async () => {
  h.invoke.mockRejectedValueOnce(new Error("[CHANNEL_NOT_ALLOWED]"));
  act(() => root.render(createElement(Harness)));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Inspect files.");
  expect(container.textContent).toContain(
    "message.thinkingTranslation.unsupported",
  );
});
it("discards a late response after recycling the row or switching accounts", async () => {
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => root.render(createElement(Harness)));
  act(() => container.querySelector("button")!.click());
  h.owner += 1;
  act(() => root.render(createElement(Harness, { text: "New source." })));
  await act(async () => finish({ text: "旧译文" }));
  expect(container.textContent).toContain("New source.");
  expect(container.textContent).not.toContain("旧译文");
});
it("does not offer translation while the source is streaming", () => {
  act(() => root.render(createElement(Harness, { running: true })));
  expect(container.querySelector("button")).toBeNull();
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each([true, false])(
  "allows manual retry after a language round trip (old reply first: %s)",
  async (oldReplyFirst) => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    h.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    act(() => root.render(createElement(Harness)));
    act(() => container.querySelector("button")!.click());
    h.locale = "en";
    act(() => root.render(createElement(Harness)));
    if (oldReplyFirst) await act(async () => finishOld({ text: "失效译文" }));
    h.locale = "zh-CN";
    act(() => root.render(createElement(Harness)));
    expect(container.querySelector("button")!.disabled).toBe(false);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        finishNew = resolve;
      }),
    );
    act(() => container.querySelector("button")!.click());
    expect(h.invoke).toHaveBeenCalledTimes(2);
    if (!oldReplyFirst) await act(async () => finishOld({ text: "失效译文" }));
    expect(container.textContent).not.toContain("失效译文");
    expect(container.querySelector("button")!.disabled).toBe(true);
    await act(async () => finishNew({ text: "新译文" }));
    expect(container.textContent).toContain("新译文");
    expect(h.invoke).toHaveBeenCalledTimes(2);
  },
);
