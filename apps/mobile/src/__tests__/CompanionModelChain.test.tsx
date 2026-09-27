// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  catalog: { providers: [] as any[], ready: true },
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
import {
  CompanionModelChain,
  CompanionModelPicker,
} from "@/session/CompanionModelChain";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const route = {
  harness: "codex",
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
it("keeps the primary first and reorders separate same-model backup accounts inside the folded chain", async () => {
  const third = { ...route, providerId: "openai:third" };
  h.catalog.providers.push(provider("openai:third", "third@example.com"));
  await render("remote-mac", [{ ...route, providerId: "openai" }, route, third]);
  const moves = () => node.querySelectorAll('[aria-label="devices.companionProfile.moveModelUp"]');
  const removes = () => node.querySelectorAll('[aria-label="devices.companionProfile.removeModel"]');
  // Folded: only the primary shows, and it can be neither moved nor removed.
  expect(node.textContent).toContain("devices.companionProfile.backupModels");
  expect(node.textContent).not.toContain("second@example.com");
  expect(moves()).toHaveLength(0);
  expect(removes()).toHaveLength(0);
  const toggle = [...node.querySelectorAll('button')].find(button => button.textContent === 'devices.companionProfile.backupModels')!;
  await act(async () => toggle.click());
  expect(node.textContent).toContain("second@example.com");
  // Backup 1 cannot move above the primary; backup 2 moves above backup 1.
  expect(moves()).toHaveLength(1);
  expect(removes()).toHaveLength(2);
  await act(async () => (moves()[0] as HTMLButtonElement).click());
  expect(
    JSON.parse(h.change.mock.lastCall![0].modelChain).map(
      (r: any) => r.providerId,
    ),
  ).toEqual(["openai", "openai:third", "openai:second"]);
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
  expect(select).toHaveBeenCalledWith(route);
});
