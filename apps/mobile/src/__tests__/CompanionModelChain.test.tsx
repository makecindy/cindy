vi.mock('@/session/useRemoteAgentCatalogs', () => ({ useRemoteAgentCatalogs: () => [] }));
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  catalog: { providers: [] as any[], ready: true },
  pluginEngines: [] as any[],
  device: vi.fn(),
  change: vi.fn(),
  picker: null as any,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (v: unknown) => v },
  View: "div",
  Pressable: ({
    onPress,
    accessibilityRole,
    accessibilityLabel,
    style,
    ...p
  }: any) =>
    createElement("button", {
      ...p,
      onClick: onPress,
      "aria-label": accessibilityLabel,
    }),
  Switch: () => null,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["ChevronRight", "ChevronDown", "ChevronUp", "MinusCircle", "Plus", "ArrowUp"].map((key) => [
      key,
      () => null,
    ]),
  ),
);
vi.mock("@/theme", () => ({
  iconSize: {},
  spacing: {},
  typeScale: {},
  lineHeight: {},
  useTheme: () => ({ colors: {} }),
}));
vi.mock("@/components/AppText", () => ({ Text: "span" }));
vi.mock("@/platform/chrome/NativeSwitch", () => ({ NativeSwitch: () => null }));
vi.mock("@/device-link/useDeviceProviders", () => ({
  useDeviceProviders: (id: string) => {
    h.device(id);
    return h.catalog;
  },
}));
vi.mock("@/device-link/useMobileMakerTransport", () => ({
  useMobileMakerTransport: () => ({}),
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ user: { id: "owner" } }),
}));
vi.mock("@/session/ModelPickerSheet", () => ({
  ModelPickerSheet: (p: any) => {
    h.picker = p;
    return null;
  },
}));
vi.mock("@/session/pluginEngines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/session/pluginEngines")>();
  return {
    ...actual,
    usePluginEngines: () => ({ engines: h.pluginEngines, loading: false, refresh: vi.fn() }),
  };
});
import {
  CompanionModelChain,
  CompanionModelPicker,
} from "@/session/CompanionModelChain";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const route = {
  harness: "codex" as const,
  model: "gpt-6",
  providerId: "openai:second",
  effort: "high",
  fastMode: true,
};
const provider = (id: string, identity: string) => ({
  id,
  name: "OpenAI",
  openAiAccount: { source: "oauth", identity },
  agents: ["codex"],
  models: {
    codex: [
      { id: "gpt-6", name: "GPT-6", contextWindow: 200000, efforts: ["high"] },
    ],
  },
  connected: true,
  routing: { codex: {} },
});
let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  node = document.createElement("div");
  root = createRoot(node);
  h.catalog = {
    providers: [
      provider("openai", "first@example.com"),
      provider("openai:second", "second@example.com"),
    ],
    ready: true,
  };
  h.pluginEngines = [];
});
afterEach(() => {
  act(() => root.unmount());
});
async function render(device = "remote-mac", routes = [route]) {
  await act(async () =>
    root.render(
      createElement(CompanionModelChain, {
        deviceId: device,
        values: { modelChain: JSON.stringify(routes), followsDefault: false },
        onChange: h.change,
        onPick: () => {},
        disabled: false,
      }),
    ),
  );
}
it("shows the selected remote account and catalog model name without changing its route", async () => {
  await render();
  expect(h.device).toHaveBeenCalledWith("remote-mac");
  expect(node.textContent).toContain("OpenAI · second@example.com");
  expect(node.textContent).toContain("GPT-6");
  expect(node.textContent).not.toContain("first@example.com");
  expect(node.textContent).not.toContain("openai:second");
  expect(h.change).not.toHaveBeenCalled();
});
// cindy-bots-runtime.md「伙伴只用一个模型」: a chain an older computer saved with backups shows only its
// primary; there is nothing to add, reorder or remove.
it("shows only the primary of a chain an older computer saved with backups", async () => {
  await render("remote-mac", [{ ...route, providerId: "openai" }, route]);
  expect(node.textContent).not.toContain("second@example.com");
  expect(node.textContent).not.toContain("devices.companionProfile.addModel");
  expect(node.querySelectorAll('[role="button"], button')).toHaveLength(1);
  expect(h.change).not.toHaveBeenCalled();
});
it("does not expose the previous device account while the new catalog is loading", async () => {
  await render();
  h.catalog = { ...h.catalog, ready: false };
  await render("other-mac");
  expect(node.textContent).not.toContain("second@example.com");
  expect(h.change).not.toHaveBeenCalled();
});
it("preserves a missing explicit source instead of naming another account with the same model", async () => {
  h.catalog.providers = [provider("openai", "first@example.com")];
  await render();
  expect(node.textContent).not.toContain("first@example.com");
  expect(h.change).not.toHaveBeenCalled();
});
it("passes the full account, engine, effort and fast route back from the unified picker", async () => {
  const select = vi.fn(() => true);
  await act(async () =>
    root.render(
      createElement(CompanionModelPicker, {
        visible: true,
        deviceId: "remote-mac",
        onClose() {},
        onClosed() {},
        onSelect: select,
      }),
    ),
  );
  await h.picker.unified.onSelect({
    agent: "codex",
    modelId: "gpt-6",
    providerId: "openai:second",
    effort: "high",
    fast: true,
  });
  expect(select).toHaveBeenCalledWith({ ...route, agentDeviceId: null });
});

it('keeps the selected shared location in the complete route', async () => {
  const select = vi.fn(() => true);
  await act(async () => root.render(createElement(CompanionModelPicker, {
    visible: true, deviceId: 'remote-mac', onClose() {}, onClosed() {}, onSelect: select,
  })));
  await h.picker.unified.onSelect({ agent: 'codex', modelId: 'gpt-6', providerId: 'openai:second', effort: 'high', fast: true }, { deviceId: 'share:one' });
  expect(select).toHaveBeenCalledWith({ ...route, agentDeviceId: 'share:one' });
});

// model-groups.md §6.2, user 2026-11-20「漏了补全客户端」: the phone picks the host computer's model groups for a
// companion. Production entries: CompanionModelChain (row) and CompanionModelPicker (unified picker options).
// Observable: a group entry shows the group, not its saved model; the picker lists the host's groups and a pick
// records the group with a usable saved model (the current one, or the group's first source for a new entry);
// a plain pick drops the group. Minimal input: one group from the host. tier: unit (jsdom).
const hostGroup = { id: 'night', name: 'Night', strategy: 'order' as const, sources: 2,
  fallback: { harness: 'pi' as const, model: 'glm', providerId: 'xd' } };
it('shows a group entry by its group and lets the picker choose the host\'s groups', async () => {
  await act(async () => root.render(createElement(CompanionModelChain, {
    deviceId: 'remote-mac', values: { modelChain: JSON.stringify([{ ...route, modelGroup: 'night' }]), followsDefault: false },
    onChange: h.change, onPick: () => {}, disabled: false, modelGroups: [hostGroup],
  })));
  expect(node.textContent).toContain('Night');
  expect(node.textContent).toContain('models.modelGroups.sourceCount');
  expect(node.textContent).not.toContain('GPT-6');

  const select = vi.fn(() => true);
  const picker = (current?: typeof route) => act(async () => root.render(createElement(CompanionModelPicker, {
    visible: true, deviceId: 'remote-mac', onClose() {}, onClosed() {}, onSelect: select, modelGroups: [hostGroup],
    ...(current ? { route: current } : {}),
  })));
  await picker({ ...route, modelGroup: 'night' } as typeof route);
  expect(h.picker.unified.modelGroups.rows).toEqual([expect.objectContaining({ id: 'night', title: 'Night', selected: true })]);
  await picker(route);
  h.picker.unified.modelGroups.onSelect('night');
  expect(select).toHaveBeenLastCalledWith({ ...route, modelGroup: 'night' });
  await picker();
  h.picker.unified.modelGroups.onSelect('night');
  expect(select).toHaveBeenLastCalledWith({ harness: 'pi', model: 'glm', providerId: 'xd', effort: '', fastMode: false, modelGroup: 'night' });
  await h.picker.unified.onSelect({ agent: 'codex', modelId: 'gpt-6', providerId: 'openai:second', effort: 'high', fast: true });
  expect(select).toHaveBeenLastCalledWith({ ...route, agentDeviceId: null });
});

// 生产入口与可观察结果：手机端 CompanionModelChain 与 CompanionModelPicker 展示并写回插件引擎路由(harness='acp')。
// 依据：docs/plans/acp-plugin-bridge.md「伙伴完整支持插件引擎」。
// 覆盖缺口：此前 readCompanionModelChain 丢弃 harness='acp'，且 CompanionModelPicker 未透传 pluginEngines。
// 最小失败输入与 tier：unit（jsdom），单台被控电脑上的 DSH 插件引擎路由展示与选择。
it('renders plugin engine companion routes and selects plugin engines from the mobile picker', async () => {
  h.pluginEngines = [{
    key: 'dsh-acp:dsh',
    providerId: 'acp-plugin:dsh-acp:dsh',
    ghostId: 'dsh-acp',
    harnessId: 'dsh',
    name: 'DeepSeek Harness',
    availability: { state: 'available' },
    models: [{ id: 'deepseek-v4', displayName: 'DeepSeek V4', efforts: ['high'] }],
    permissionModes: [{ id: 'ask', displayName: 'Ask' }],
    defaultPermissionMode: 'ask',
  }];
  const acpRoute = {
    harness: 'acp',
    model: 'deepseek-v4',
    providerId: 'acp-plugin:dsh-acp:dsh',
    effort: 'high',
    fastMode: false,
  };
  await render('remote-mac', [acpRoute as any]);
  expect(node.textContent).toContain('DeepSeek V4');
  expect(node.textContent).toContain('DeepSeek Harness');

  const select = vi.fn(() => true);
  await act(async () => root.render(createElement(CompanionModelPicker, {
    visible: true,
    deviceId: 'remote-mac',
    route: acpRoute as any,
    onClose() {},
    onClosed() {},
    onSelect: select,
  })));
  expect(h.picker.unified.pluginEngines.active).toEqual({
    providerId: 'acp-plugin:dsh-acp:dsh',
    modelId: 'deepseek-v4',
    effort: 'high',
  });
  h.picker.unified.pluginEngines.onSelect({
    providerId: 'acp-plugin:dsh-acp:dsh',
    modelId: 'default',
  });
  expect(select).toHaveBeenCalledWith({
    agentDeviceId: null,
    harness: 'acp',
    model: 'default',
    providerId: 'acp-plugin:dsh-acp:dsh',
    effort: '',
    fastMode: false,
  });
});
