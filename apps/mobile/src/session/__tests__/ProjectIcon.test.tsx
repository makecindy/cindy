// @vitest-environment jsdom
// Unit: review #10636, duplicate manual-image downloads and stale account/device results.
// Existing host tests do not mount icon consumers. Two simultaneous icons and one owner switch
// are the minimal regression; only transport and native presentation are replaced.
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ owner: { id: "a" }, read: vi.fn() }));
vi.mock("react-native", () => ({
  Image: ({ source }: any) => <img src={source.uri} />,
  View: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("lucide-react-native", () => ({ Folder: () => null }));
vi.mock("../projectSymbolIcons", () => ({ projectSymbolIcons: {} }));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@/theme", () => ({
  useTheme: () => ({ colors: { textPrimary: "#222222" }, mode: "light" }),
  typeScale: {},
  lineHeight: {},
  radius: {},
  fontWeight: {},
  iconStroke: {},
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ invoke: h.read }),
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => h.owner,
  isMobileAuthOwnerCurrent: (owner: unknown) => owner === h.owner,
}));
import { ProjectIcon } from "../ProjectIcon";
it("shares image downloads and never displays bytes belonging to the previous owner or device", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement("div");
  const root = createRoot(element);
  const icon = `cindy-media://blobs/${"a".repeat(64)}.png`;
  const image = "data:image/png;base64,YQ==";
  const props = {
    value: icon,
    projectKey: "local:/repo",
    projectName: "Repo",
    deviceId: "pc",
  };
  const render = async (overrides = {}) =>
    act(async () => {
      root.render(
        <>
          <ProjectIcon {...props} {...overrides} />
          <ProjectIcon {...props} {...overrides} />
        </>,
      );
    });
  try {
    h.read.mockResolvedValue(image);
    await render();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(element.querySelectorAll("img")).toHaveLength(2);
    let resolve!: (data: string) => void;
    h.read.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    h.owner = { id: "b" };
    await render();
    expect(element.querySelector("img")).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(2);
    const previousDevice = resolve;
    await render({ deviceId: "other" });
    const settle = resolve;
    await act(async () => previousDevice(image));
    expect(element.querySelector("img")).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(3);
    await act(async () => settle(image));
    expect(element.querySelectorAll("img")).toHaveLength(2);
    await render({
      value: `cindy-media://blobs/${"b".repeat(64)}.png`,
      deviceId: "other",
    });
    expect(element.querySelector("img")).toBeNull();
    expect(h.read).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
  }
});
