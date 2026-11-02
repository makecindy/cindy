// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  providers: [] as any[],
  catalogs: [] as any[],
  invoke: vi.fn(async () => ({ id: "schedule-1" })),
  picker: null as any,
  capabilities: { supportsScheduleAgentDeviceSelection: true } as any,
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  AppState: { currentState: "active" },
  Platform: { OS: "ios" },
  ScrollView: "div",
  StyleSheet: { create: (v: unknown) => v },
  View: "div",
  Pressable: ({ onPress, disabled, children }: any) =>
    createElement("button", { onClick: onPress, disabled }, children),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/theme", () => ({
  fontWeight: {},
  lineHeight: {},
  radius: {},
  spacing: {},
  typeScale: {},
  useTheme: () => ({ colors: {} }),
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
}));
vi.mock("@/components/AppText", () => ({
  Text: "span",
  TextInput: () => null,
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({ connectionEpoch: 1, invoke: h.invoke }),
}));
vi.mock("@/device-link/useDeviceProviders", () => ({
  useDeviceProviders: () => ({ providers: h.providers, ready: true }),
}));
const maker = { getCapabilities: async () => h.capabilities };
vi.mock("@/device-link/useMobileMakerTransport", () => ({
  useMobileMakerTransport: () => maker,
}));
vi.mock("@/auth/authOwnerGeneration", () => ({
  getMobileAuthOwner: () => ({ accountKey: "owner" }),
  isMobileAuthOwnerCurrent: () => true,
}));
vi.mock("@/session/agentCapabilities", () => ({
  normalizeMobileAgentCapabilities: (value: any) => value,
}));
vi.mock("@/session/useRemoteAgentCatalogs", () => ({
  useRemoteAgentCatalogs: () => h.catalogs,
}));
vi.mock("@/session/SheetModal", () => ({ SheetModal: (p: any) => p.children }));
vi.mock("@/session/ModelPickerSheet", () => ({
  ModelPickerSheet: (p: any) => {
    h.picker = p;
    return null;
  },
}));
import { PluginScheduleDraft } from "@/plugins/PluginScheduleDraft";

const intent = {
  id: "i1",
  pluginId: "p1",
  ghostName: "Plugin",
  kind: "schedule",
  name: "Daily",
  prompt: "Run",
  intervalMs: 3600000,
} as const;
const configuration = {
  agent: "codex",
  providerId: "remote-provider",
  modelId: "remote-model",
  effort: "high",
  fast: false,
};
let root: Root;
let host: HTMLDivElement;
const renderDraft = async () => {
  await act(async () => {
    root.render(
      createElement(PluginScheduleDraft, {
        intent,
        deviceId: "host",
        onClose: () => {},
      }),
    );
  });
};
const clickButton = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  await act(async () => button?.click());
};

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  h.providers = [{ id: "local", models: {} }];
  h.capabilities = { supportsScheduleAgentDeviceSelection: true };
  h.catalogs = [
    {
      deviceId: "studio",
      name: "Studio",
      status: "ready",
      providers: [
        {
          id: "remote-provider",
          models: { codex: [{ id: "remote-model", name: "Remote Model" }] },
        },
      ],
    },
  ];
  h.invoke.mockClear();
  h.picker = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("lists remote catalogs and creates the schedule with the selected location", async () => {
  await renderDraft();
  expect(h.picker.unified.remote.catalogs).toBe(h.catalogs);
  expect(h.picker.unified.remote.hostDeviceId).toBe("host");
  await act(async () => {
    await h.picker.unified.onSelect(configuration, { deviceId: "studio" });
  });
  expect(h.picker.unified.remote.selectedDeviceId).toBe("studio");
  expect(host.textContent).toContain("Remote Model · Studio");
  await clickButton("plugins.saveConfiguration");
  const [, channel, [input]] = h.invoke.mock.calls[0] as unknown as [string, string, [any]];
  expect(channel).toBe("maker:schedule:create");
  expect(input).toMatchObject({
    modelAgentDeviceId: "studio",
    modelAgentKind: "codex",
    model: "remote-model",
    providerId: "remote-provider",
  });
});

it("clears the location when a local row is selected afterwards", async () => {
  await renderDraft();
  await act(async () => {
    await h.picker.unified.onSelect(configuration, { deviceId: "studio" });
  });
  await act(async () => {
    await h.picker.unified.onSelect(
      { ...configuration, providerId: "local", modelId: "local-model" },
      { deviceId: null },
    );
  });
  expect(h.picker.unified.remote.selectedDeviceId).toBeNull();
});

it("does not list remote rows for a computer without schedule location support", async () => {
  h.capabilities = { supportsScheduleAgentDeviceSelection: false };
  await renderDraft();
  expect(h.picker.unified.remote).toBeUndefined();
});

it("lists remote rows when the computer only has remote or shared providers", async () => {
  h.providers = [];
  await renderDraft();
  expect(h.picker.unified.remote.catalogs).toBe(h.catalogs);
});
