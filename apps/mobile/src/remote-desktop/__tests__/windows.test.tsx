// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteDesktopWindows } from "../RemoteDesktopWindows";
vi.mock("react-native", () => ({
  View: ({ children }: any) => <div>{children}</div>,
  Pressable: ({ children, onPress, disabled }: any) => (
    <button onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  ActivityIndicator: () => <span>loading</span>,
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: {} }),
  radius: {},
  spacing: {},
  typeScale: {},
  lineHeight: {},
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../RemoteDesktopChrome", () => ({
  RemoteDesktopPanel: ({ children }: any) => <div>{children}</div>,
}));
let dispose = () => {};
afterEach(() => {
  act(dispose);
});
async function mount(request: any) {
  const element = document.createElement("div");
  const root = createRoot(element);
  const close = vi.fn();
  dispose = () => root.unmount();
  await act(async () => {
    root.render(
      <RemoteDesktopWindows
        lease="lease"
        request={request}
        onClose={close}
        landscape={false}
        topInset={0}
        caption="Test"
      />,
    );
  });
  return { element, close };
}
it("lists host windows and activates the selected ID under the same lease", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce([{ id: "0xabc", title: "Document", app: "Editor" }])
    .mockResolvedValue(null);
  const h = await mount(request);
  expect(h.element.textContent).toContain("Document");
  await act(async () => {
    h.element.querySelector("button")!.click();
  });
  expect(request).toHaveBeenLastCalledWith({
    op: "windowAction",
    action: "activate",
    id: "0xabc",
    lease: "lease",
  });
  expect(h.close).toHaveBeenCalledOnce();
});
it("shows a retry for invalid responses and ignores late lists after closing", async () => {
  const request = vi
    .fn()
    .mockResolvedValue([{ id: ";exec", title: "bad", app: "bad" }]);
  const h = await mount(request);
  expect(h.element.textContent).toContain("remoteDesktop.windowsFailed");
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    h.element.querySelector("button")!.click();
  });
  act(dispose);
  dispose = () => {};
  await act(async () => {
    finish([{ id: "0xabc", title: "late", app: "Editor" }]);
  });
  expect(h.element.textContent).toBe("");
  expect(h.close).not.toHaveBeenCalled();
});
