// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  providers: [] as any[],
  catalogs: [] as any[],
  pluginEngines: [] as any[],
  remotePluginEngines: [] as any[],
  refreshLocal: vi.fn(),
  refreshRemote: vi.fn(),
  invoke: vi.fn(async () => ({ id: "schedule-1" })),
  picker: null as any,
  sheet: null as any,
  capabilities: { supportsScheduleAgentDeviceSelection: true } as any,
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  AppState: { currentState: "active" },
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 402, height: 874 }),
  ScrollView: "div",
  StyleSheet: { create: (v: unknown) => v },
  View: "div",
  Switch: ({ value, onValueChange }: any) => createElement("input", {
    type: "checkbox", checked: value, onChange: (e: any) => onValueChange(e.target.checked),
  }),
  Pressable: ({ onPress, disabled, children }: any) =>
    createElement("button", { onClick: onPress, disabled }, children),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
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
vi.mock("@/session/pluginEngines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/session/pluginEngines")>();
  return {
    ...actual,
    usePluginEngines: () => ({ engines: h.pluginEngines, refresh: h.refreshLocal }),
    useControlledRemotePluginEngines: () => ({ engines: h.remotePluginEngines, settled: true, refresh: h.refreshRemote }),
  };
});
vi.mock("@/session/SheetModal", () => ({ SheetModal: (p: any) => {
  h.sheet = p;
  return p.children;
} }));
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
const renderDraft = async (draftIntent: typeof intent | (typeof intent & { preRunPlugin: { pluginId: string; onFailure: 'allow' } }) = intent) => {
  await act(async () => {
    root.render(
      createElement(PluginScheduleDraft, {
        intent: draftIntent,
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
  h.pluginEngines = [];
  h.remotePluginEngines = [];
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
  h.sheet = null;
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

it("waits for each native modal to close before opening the next and keeps the draft", async () => {
  await renderDraft({ ...intent, preRunPlugin: { pluginId: 'p1', onFailure: 'allow' } });
  const check = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
  await act(async () => check.click());
  await clickButton('plugins.taskModel');
  expect(h.sheet.visible).toBe(false);
  expect(h.picker.visible).toBe(false);
  await act(async () => h.sheet.onClosed());
  expect(h.picker.visible).toBe(true);
  await act(async () => h.picker.unified.onSelect(configuration, { deviceId: 'studio' }));
  expect(h.picker.visible).toBe(false);
  expect(h.sheet.visible).toBe(false);
  await act(async () => h.picker.onClosed());
  expect(h.sheet.visible).toBe(true);
  expect(check.checked).toBe(false);
  await clickButton('plugins.saveConfiguration');
  const [, , [input]] = h.invoke.mock.calls[0] as unknown as [string, string, [any]];
  expect(input.model).toBe('remote-model');
  expect(input.preRunPlugin).toBeUndefined();
});

it.each([true, false])('saves the visible pre-run check choice (%s) on the original computer', async enabled => {
  await renderDraft({ ...intent, preRunPlugin: { pluginId: 'p1', onFailure: 'allow' } });
  await act(async () => h.picker.unified.onSelect(configuration, { deviceId: 'studio' }));
  const check = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
  expect(check.checked).toBe(true);
  if (!enabled) await act(async () => check.click());
  await clickButton('plugins.saveConfiguration');
  const [deviceId, channel, [input]] = h.invoke.mock.calls[0] as unknown as [string, string, [any]];
  expect(deviceId).toBe('host');
  expect(channel).toBe('maker:schedule:create');
  expect(input.preRunPlugin).toEqual(enabled ? { pluginId: 'p1', onFailure: 'allow' } : undefined);
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

it("selects local and remote plugin engines and submits acp schedule inputs", async () => {
  h.pluginEngines = [{
    key: "dsh:dsh",
    providerId: "acp-plugin:dsh:dsh",
    ghostId: "dsh",
    harnessId: "dsh",
    name: "DeepSeek Harness",
    availability: { state: "available" },
    models: [{ id: "deepseek-v4", displayName: "DeepSeek V4", efforts: ["high"] }],
    permissionModes: [{ id: "default", displayName: "Default" }],
    defaultPermissionMode: "default",
  }];
  h.remotePluginEngines = [{
    ...h.pluginEngines[0],
    deviceId: "studio",
    deviceName: "Studio",
  }];
  // Exercise the combined paths: the native picker must dismiss before the
  // draft reopens, and engine selection must preserve the draft's pre-run check.
  const draftIntent = { ...intent, preRunPlugin: { pluginId: "p1", onFailure: "allow" } } as const;
  await renderDraft(draftIntent);
  expect(h.picker.unified.pluginEngines.engines).toHaveLength(2);
  const firstOnOpen = h.picker.unified.pluginEngines.onOpen;
  await renderDraft(draftIntent);
  expect(h.picker.unified.pluginEngines.onOpen).toBe(firstOnOpen);
  await clickButton("plugins.taskModel");
  await act(async () => h.sheet.onClosed());
  expect(h.picker.visible).toBe(true);
  await act(async () => {
    await h.picker.unified.pluginEngines.onSelect({
      providerId: "acp-plugin:dsh:dsh",
      deviceId: "studio",
      modelId: "deepseek-v4",
      effort: "high",
    });
  });
  expect(h.picker.visible).toBe(false);
  expect(h.sheet.visible).toBe(false);
  await act(async () => h.picker.onClosed());
  expect(h.sheet.visible).toBe(true);
  expect(host.textContent).toContain("DeepSeek Harness · DeepSeek V4 · Studio");
  await clickButton("plugins.saveConfiguration");
  const [deviceId, channel, [input]] = h.invoke.mock.calls[0] as unknown as [string, string, [any]];
  expect(deviceId).toBe("host");
  expect(channel).toBe("maker:schedule:create");
  expect(input).toMatchObject({
    agentKind: "acp",
    modelAgentKind: "acp",
    modelAgentDeviceId: "studio",
    providerId: "acp-plugin:dsh:dsh",
    model: "deepseek-v4",
    effort: "high",
    fastMode: false,
    preRunPlugin: draftIntent.preRunPlugin,
  });
});
