// @vitest-environment jsdom
/**
 * Android 模型 / 权限 / 目标面板与 iOS 的交互对齐(外观仍是 SheetModal + RN 自绘行)。
 * react-native 用 DOM 桩替身渲染,按 testID / aria 属性断言信息结构与交互时机。
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  budgetDisabled: false,
  menu: true,
  menus: new Map<
    string,
    {
      actions: Array<{ id: string; title: string; state?: string }>;
      onAction(id: string): void;
    }
  >(),
  onClosed: undefined as (() => void) | undefined,
  layouts: new Map<
    string,
    (event: { nativeEvent: { layout: { y: number } } }) => void
  >(),
}));

type AnyProps = Record<string, any>;
const flatStyle = (style: unknown): AnyProps => {
  const value = typeof style === "function" ? style({ pressed: false }) : style;
  if (Array.isArray(value)) return Object.assign({}, ...value.map(flatStyle));
  return value && typeof value === "object" ? (value as AnyProps) : {};
};
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => false, getCachedReduceMotionEnabled: () => false }));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const passthrough = ({ children }: AnyProps) => el("div", null, children);
  const View = ({
    children,
    testID,
    accessibilityRole,
    accessibilityValue,
    accessibilityLabel,
    onLayout,
  }: AnyProps) => {
    if (testID && onLayout) native.layouts.set(testID, onLayout);
    return el(
      "div",
      {
        "data-testid": testID,
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-valuenow": accessibilityValue?.now,
      },
      children,
    );
  };
  class Value {
    setValue() {}
    interpolate() {
      return this;
    }
  }
  return {
    ActivityIndicator: () => null,
    Animated: {
      Value,
      View: passthrough,
      timing: () => ({ start: (cb?: () => void) => cb?.() }),
    },
    Platform: {
      OS: "android",
      select: (v: AnyProps) => v.android ?? v.default,
    },
    Pressable: ({
      children,
      onPress,
      testID,
      disabled,
      accessibilityLabel,
      accessibilityState,
      onLayout,
    }: AnyProps) => {
      if (onLayout) native.layouts.set(`${testID}:selectedRow`, onLayout);
      return el(
        "button",
        {
          "data-testid": testID,
          "aria-label": accessibilityLabel,
          "aria-selected":
            accessibilityState?.selected === undefined
              ? undefined
              : String(accessibilityState.selected),
          "aria-expanded":
            accessibilityState?.expanded === undefined
              ? undefined
              : String(accessibilityState.expanded),
          disabled,
          onClick: onPress,
        },
        children,
      );
    },
    ScrollView: passthrough,
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Easing: { bezier: () => (t: number) => t },
    View,
    useWindowDimensions: () => ({ height: 800, width: 400 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: AnyProps) =>
      values?.mode ? `${key}:${values.mode}` : key,
  }),
}));
vi.mock("lucide-react-native", async () => {
  const { createElement: el } = await import("react");
  const icon =
    (name: string) =>
    ({ color, fill }: AnyProps) =>
      el("i", { "data-icon": name, "data-color": color, "data-fill": fill });
  return Object.fromEntries(
    [
      "Brain",
      "Check",
      "ChevronDown",
      "ChevronRight",
      "ChevronsUpDown",
      "LayoutGrid",
      "Search",
      "SlidersHorizontal",
      "Star",
      "X",
      "Zap",
      "Hand",
      "Sparkles",
      "TriangleAlert",
    ].map((name) => [name, icon(name)]),
  );
});
vi.mock("@/components/AppText", async () => {
  const { createElement: el } = await import("react");
  return {
    Text: ({ children, numberOfLines, style, testID }: AnyProps) =>
      el(
        "span",
        {
          "data-testid": testID,
          "data-color": flatStyle(style).color,
          "data-lines": numberOfLines,
        },
        children,
      ),
    TextInput: ({
      value,
      onChangeText,
      onFocus,
      testID,
      accessibilityLabel,
    }: AnyProps) =>
      el("input", {
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onChange: (event: { target: { value: string } }) =>
          onChangeText?.(event.target.value),
        onFocus,
        value: value ?? "",
      }),
  };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  const colors = new Proxy({}, { get: (_target, key) => `c.${String(key)}` });
  return {
    ...tokens,
    useTheme: () => ({ colors, mode: "light" }),
    useThemedStyles: (factory: (c: unknown) => unknown) => factory(colors),
  };
});
vi.mock("@/platform/chrome", async () => {
  const { createElement: el } = await import("react");
  return {
    usesNativePullDownMenu: () => native.menu,
    NativePullDownMenu: ({ actions, onAction, children, testID }: AnyProps) => {
      if (native.menu) native.menus.set(testID, { actions, onAction });
      return el("div", null, children);
    },
    NativeSwitch: ({ value, onValueChange, testID, disabled }: AnyProps) =>
      el("button", {
        "data-testid": testID,
        "aria-checked": String(value),
        disabled,
        onClick: () => onValueChange(!value),
      }),
  };
});
vi.mock("@/components/MobileAgentMark", async () => {
  const { createElement: el } = await import("react");
  return {
    MobileAgentMark: ({ agentKind }: AnyProps) =>
      el("i", { "data-agent": agentKind }),
  };
});
vi.mock("@/session/MobileProviderMark", async () => {
  const { createElement: el } = await import("react");
  return {
    MobileProviderMark: ({ providerId }: AnyProps) =>
      el("i", { "data-provider-mark": providerId }),
    MobileModelIconMark: ({ providerId }: AnyProps) =>
      el("i", { "data-model-mark": providerId }),
  };
});
vi.mock("@/session/sessionAgentSwitch", () => ({
  mobileAgentLabel: (agent: string) => `agent:${agent}`,
}));
vi.mock("@/session/contextSheetModel", () => ({
  computeContextSheetSnapHeights: () => ({ half: 400, full: 700 }),
}));
vi.mock("@/session/SheetModal", async () => {
  const { createElement: el } = await import("react");
  return {
    SheetModal: ({ children, onClosed, visible }: AnyProps) => {
      native.onClosed = onClosed;
      return visible ? el("div", null, children) : null;
    },
  };
});
vi.mock("@/session/SheetSurface", async () => {
  const { createElement: el } = await import("react");
  return {
    SheetSurface: ({ children, title, pinnedTop, onBack, testID }: AnyProps) =>
      el(
        "section",
        { "data-testid": testID, "data-title": title },
        onBack
          ? el("button", { "data-testid": `${testID}.back`, onClick: onBack })
          : null,
        pinnedTop,
        children,
      ),
  };
});
vi.mock("@/session/draftModelMemory", () => ({
  useDraftModelMemoryVersion: () => 0,
}));
vi.mock("@/session/sessionModelMirror", () => ({
  useSessionModelMirrorVersion: () => 0,
}));
vi.mock("@/session/permissionPresentation", async () => {
  const { createElement: el } = await import("react");
  const Icon = ({ color }: AnyProps) =>
    el("i", { "data-icon": "permission", "data-color": color });
  return {
    permissionPresentation: (id: string, label?: string) => ({
      Icon,
      label: label ?? id,
      accent:
        id === "auto"
          ? "auto"
          : id === "bypassPermissions"
            ? "bypass"
            : "neutral",
    }),
    permissionAccentColor: (accent: string, colors: AnyProps) =>
      accent === "auto"
        ? colors.permAutoAccent
        : accent === "bypass"
          ? colors.statusAccent
          : colors.textSecondary,
  };
});
vi.mock("@/session/goalStatusLabel", () => ({
  GOAL_STATUS_LABEL: {},
  goalReasonText: (reason?: string) => reason || null,
  goalStatusLabel: (status: string) => `status:${status}`,
}));
vi.mock("@/session/modelPickerRows", () => ({
  budgetDisabledHint: () => "needs key",
  budgetRowDisabled: () => native.budgetDisabled,
  effortLabelFor: (_model: unknown, effort: string) => `effort:${effort}`,
  modelRowAccessibilityLabel: ({ baseLabel }: AnyProps) => baseLabel,
  rowEffortOf: ({ selected, liveEffort, model }: AnyProps) =>
    selected ? liveEffort : model.defaultEffort,
  rowFastEditable: () => true,
  rowFastOn: ({ selected, liveFastMode }: AnyProps) => selected && liveFastMode,
}));

vi.mock("@/i18n", () => ({
  i18n: { t: (key: string) => key, language: "en", resolvedLanguage: "en" },
}));
vi.mock("@/session/UnifiedModelPickerSheet", () => ({
  UnifiedModelPickerSheet: () => null,
}));
vi.mock("@/session/ComposerSheet", () => ({ ComposerSheet: () => null }));
vi.mock("@/session/ModelPickerNativeHeader", () => ({
  ModelPickerNativeHeader: () => null,
}));
vi.mock("@/session/MobileAgentSwitcher", () => ({
  MobileAgentSwitcher: () => null,
}));

import { UnifiedModelPickerView } from "@/session/UnifiedModelPickerView";
import { ModelPickerSheet } from "@/session/ModelPickerSheet";
import { MobileModelPickerList } from "@/session/MobileModelPickerList";
import { MobilePermissionPickerList } from "@/session/MobilePermissionPickerList";
import { NativePermissionSheet } from "@/session/NativePermissionSheet";
import { ContextSheetGoalView } from "@/session/ContextSheetGoalView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  native.menu = true;
  native.menus.clear();
  native.onClosed = undefined;
  native.layouts.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const byId = (id: string) =>
  host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const click = (id: string) =>
  act(() => (byId(id) as HTMLButtonElement).click());
const render = (node: ReactNode) => act(() => root.render(node as never));

function unifiedRow(overrides: AnyProps = {}) {
  return {
    key: "p1::m1",
    entry: {
      displayName: "Model One",
      providerId: "p1",
      modelId: "m1",
      capabilities: {
        codex: {
          wireModelId: "m1-codex",
          efforts: ["low", "high"],
          defaultEffort: "high",
        },
        pi: { wireModelId: "m1-pi", efforts: [], defaultEffort: null },
      },
    },
    config: {
      providerId: "p1",
      modelId: "m1",
      agent: "codex",
      effort: "low",
      fast: false,
    },
    selected: true,
    disabled: false,
    subtitle: "me@example.com · Low",
    costMarks: "$$",
    effortLabel: "Low",
    quotaLabel: "2d · 70%",
    providerMark: { providerId: "p1", name: "Provider One" },
    ...overrides,
  };
}

function unifiedProps(overrides: AnyProps = {}): AnyProps {
  return {
    visible: true,
    onClose: vi.fn(),
    title: "models.picker.title",
    testID: "modelSheet",
    query: "",
    onQuery: vi.fn(),
    filter: "all",
    onFilter: vi.fn(),
    filters: [
      { id: "all", label: "All models" },
      { id: "favorites", label: "Favorites" },
      {
        id: "p1",
        label: "Provider One",
        providerMark: { providerId: "p1", name: "Provider One" },
        quota: { remaining: 40, label: "Week · 40% left" },
      },
    ],
    groups: [
      {
        key: "favorites",
        title: "Favorites",
        rows: [
          unifiedRow({
            key: "fav-1",
            selected: false,
            favorite: { uid: "fav-1" },
          }),
        ],
      },
      {
        key: "p1",
        title: "Provider One · me@example.com",
        rows: [unifiedRow()],
      },
    ],
    busy: false,
    error: null,
    loading: false,
    emptyHint: "empty",
    onSelect: vi.fn(),
    onOptions: vi.fn(),
    ...overrides,
  };
}

describe("Android unified model picker follows the iOS structure", () => {
  it("pins a labelled search field with a clear action and preserves the query value", () => {
    const props = unifiedProps({ query: "gpt" });
    render(createElement(UnifiedModelPickerView, props as never));
    const input = byId("modelSheet.search") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe(
      "models.picker.searchAccessibility",
    );
    expect(input.value).toBe("gpt");
    const clear = byId("modelSheet.search.clear")!;
    expect(clear.getAttribute("aria-label")).toBe(
      "devices.detail.search.clearA11y",
    );
    click("modelSheet.search.clear");
    expect(props.onQuery).toHaveBeenCalledWith("");
  });

  it("replaces chip filters with a Source entry that opens a secondary page with quota bars", () => {
    const props = unifiedProps();
    render(createElement(UnifiedModelPickerView, props as never));
    expect(byId("modelSheet.source.p1")).toBeNull();
    click("modelSheet.filter");
    expect(byId("modelSheet")!.getAttribute("data-title")).toBe(
      "models.unified.source",
    );
    // 搜索框只在列表页出现;来源页有返回。
    expect(byId("modelSheet.search")).toBeNull();
    const quota = byId("modelSheet.source.p1.quota")!;
    expect(quota.getAttribute("role")).toBe("progressbar");
    expect(quota.getAttribute("aria-valuenow")).toBe("40");
    expect(byId("modelSheet.source.all")!.getAttribute("aria-selected")).toBe(
      "true",
    );
    click("modelSheet.source.p1");
    expect(props.onFilter).toHaveBeenCalledWith("p1");
    expect(byId("modelSheet")!.getAttribute("data-title")).toBe(
      "models.picker.title",
    );
    expect(byId("modelSheet.search")).not.toBeNull();
  });

  it("renders titled groups in the given order with selection state and separate settings targets", () => {
    const props = unifiedProps();
    render(createElement(UnifiedModelPickerView, props as never));
    const groups = [
      ...host.querySelectorAll('[data-testid^="modelSheet.group."]'),
    ].map((node) => node.getAttribute("data-testid"));
    expect(groups).toEqual([
      "modelSheet.group.favorites",
      "modelSheet.group.p1",
    ]);
    expect(host.textContent).toContain("Provider One · me@example.com");
    expect(byId("modelSheet.model.p1::m1")!.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(byId("modelSheet.model.fav-1")!.getAttribute("aria-selected")).toBe(
      "false",
    );
    click("modelSheet.model.p1::m1");
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    click("modelSheet.model.p1::m1.optionsButton");
    expect(props.onOptions).toHaveBeenCalledTimes(1);
  });

  function optionsProps(overrides: AnyProps = {}) {
    const row = unifiedRow();
    return unifiedProps({
      onBack: vi.fn(),
      title: "Model One",
      options: {
        row,
        agents: ["codex", "pi", "claude-code"],
        fastCapable: true,
        onChange: vi.fn(),
        favoritesDisabled: false,
        onFavorite: vi.fn(),
        onReset: vi.fn(),
        context: "Provider One · 200K context",
        price: "Per 1M tokens\nInput $1 · Output $2",
        ...overrides,
      },
    });
  }

  it("opens Harness as a secondary page and returns to settings after choosing", () => {
    const props = optionsProps();
    render(createElement(UnifiedModelPickerView, props as never));
    expect(byId("modelSheet.harness")!.textContent).toContain("agent:codex");
    click("modelSheet.harness");
    expect(byId("modelSheet")!.getAttribute("data-title")).toBe(
      "models.unified.harness",
    );
    expect(
      byId("modelSheet.harness.codex")!.getAttribute("aria-selected"),
    ).toBe("true");
    // 缺能力的 Harness 不写配置(不再使用非空断言)。
    click("modelSheet.harness.claude-code");
    expect(props.options.onChange).not.toHaveBeenCalled();
    click("modelSheet.harness.pi");
    expect(props.options.onChange).toHaveBeenCalledWith({
      providerId: "p1",
      modelId: "m1-pi",
      agent: "pi",
      effort: "",
      fast: false,
    });
    expect(byId("modelSheet")!.getAttribute("data-title")).toBe("Model One");
    expect(byId("modelSheet.harness")).not.toBeNull();
  });

  it("uses a pull-down menu for effort, a switch for Fast and standalone favorite / reset rows", () => {
    const props = optionsProps();
    render(createElement(UnifiedModelPickerView, props as never));
    const menu = native.menus.get("modelSheet.effortMenu")!;
    expect(menu.actions.map((action) => [action.id, action.state])).toEqual([
      ["low", "on"],
      ["high", "off"],
    ]);
    act(() => menu.onAction("high"));
    expect(props.options.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ effort: "high" }),
    );
    act(() => menu.onAction("unknown"));
    expect(props.options.onChange).toHaveBeenCalledTimes(1);
    expect(byId("modelSheet.fast")!.getAttribute("aria-checked")).toBe("false");
    click("modelSheet.fast");
    expect(props.options.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ fast: true }),
    );
    click("modelSheet.favorite");
    expect(props.options.onFavorite).toHaveBeenCalledTimes(1);
    click("modelSheet.reset");
    expect(props.options.onReset).toHaveBeenCalledTimes(1);
    expect(byId("modelSheet.price")!.textContent).toContain("Input $1");
  });

  it("falls back to inline effort rows when the build has no native menu", () => {
    native.menu = false;
    const props = optionsProps();
    render(createElement(UnifiedModelPickerView, props as never));
    expect(byId("modelSheet.effort.high")).toBeNull();
    click("modelSheet.effort");
    expect(byId("modelSheet.effort.low")!.getAttribute("aria-selected")).toBe(
      "true",
    );
    click("modelSheet.effort.high");
    expect(props.options.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ effort: "high" }),
    );
    expect(byId("modelSheet.effort.high")).toBeNull();
  });

  it("hides the reset row for favorites", () => {
    const props = optionsProps({
      row: unifiedRow({ favorite: { uid: "fav-1" } }),
    });
    render(createElement(UnifiedModelPickerView, props as never));
    expect(byId("modelSheet.favorite")!.textContent).toContain(
      "models.unified.removeFavorite",
    );
    expect(byId("modelSheet.reset")).toBeNull();
  });
});

describe("Android legacy model list groups by source like iOS", () => {
  const provider = (id: string, name: string, extra: AnyProps = {}) => ({
    id,
    name,
    ...extra,
  });
  const model = (id: string) => ({
    id,
    displayName: `Model ${id}`,
    efforts: ["low"],
    defaultEffort: "low",
    supportsFastMode: true,
  });

  it("titles groups as source · account and shows subscription · effort · Fast with a check mark", () => {
    const subscription = provider("sub", "ChatGPT", {
      access: { kind: "subscription" },
      openAiAccount: { identity: "me@example.com" },
    });
    const api = provider("api", "API me@example.com", {
      openAiAccount: { identity: "me@example.com" },
    });
    render(
      createElement(MobileModelPickerList, {
        providerRows: [
          { provider: subscription, model: model("a") },
          { provider: subscription, model: model("b") },
          { provider: api, model: model("c") },
        ],
        flatOptions: [],
        activeModelId: "a",
        activeSourceId: "sub",
        agentKind: "codex",
        capabilities: { hasFastMode: true },
        selectedEffort: "high",
        selectedFastMode: true,
        onSelectProviderRow: vi.fn(),
        onSelectFlatModel: vi.fn(),
        onOpenOptions: vi.fn(),
        testID: "list",
      } as never),
    );
    const groups = [...host.querySelectorAll('[data-testid^="list.group."]')];
    expect(groups.map((node) => node.getAttribute("data-testid"))).toEqual([
      "list.group.sub",
      "list.group.api",
    ]);
    expect(groups[0].textContent).toContain("ChatGPT · me@example.com");
    // 账号已写进来源名时不重复。
    expect(groups[1].textContent).toContain("API me@example.com");
    expect(groups[1].textContent).not.toContain(
      "API me@example.com · me@example.com",
    );
    const rows = [...host.querySelectorAll('button[data-testid="list"]')];
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(rows[0].textContent).toContain(
      "models.picker.subscriptionBadge · effort:high · models.options.fastMode",
    );
    expect(rows[0].querySelector('[data-icon="Check"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-icon="Check"]')).toBeNull();
    // 来源品牌 mark 保留。
    expect(rows[0].querySelector('[data-model-mark="sub"]')).not.toBeNull();
  });

  it("keeps the missing-key hint on its own unrestricted line instead of truncating it", () => {
    native.budgetDisabled = true;
    try {
      render(
        createElement(MobileModelPickerList, {
          providerRows: [{ provider: provider("sub", "ChatGPT", { access: { kind: "subscription" } }), model: model("a") }],
          flatOptions: [],
          activeModelId: "b",
          activeSourceId: "sub",
          agentKind: "codex",
          capabilities: { hasFastMode: true },
          onSelectProviderRow: vi.fn(),
          onSelectFlatModel: vi.fn(),
          testID: "list",
        } as never),
      );
      const hint = host.querySelector('[data-testid="list.disabledHint"]')!;
      expect(hint.textContent).toBe("needs key");
      expect(hint.getAttribute("data-lines")).toBeNull();
      const row = host.querySelector('button[data-testid="list"]')!;
      const meta = [...row.querySelectorAll('span[data-lines="1"]')].map((node) => node.textContent);
      expect(meta.some((text) => text?.includes("needs key"))).toBe(false);
    } finally {
      native.budgetDisabled = false;
    }
  });

  it("reports the selected row offset in scroll-content coordinates after grouping", () => {
    const onSelectedRowLayout = vi.fn();
    const rowsFor = (id: string) => ({
      provider: provider(id, id),
      model: model(`${id}-m`),
    });
    render(
      createElement(MobileModelPickerList, {
        providerRows: [rowsFor("first"), rowsFor("second")],
        flatOptions: [],
        activeModelId: "second-m",
        activeSourceId: "second",
        onSelectProviderRow: vi.fn(),
        onSelectFlatModel: vi.fn(),
        onSelectedRowLayout,
        testID: "list",
      } as never),
    );
    const layout = (key: string, y: number) =>
      act(() => native.layouts.get(key)!({ nativeEvent: { layout: { y } } }));
    // 选中行的布局回调挂在分组的直接子节点上(不是内层按钮),y 相对分组。
    expect(native.layouts.has("list:selectedRow")).toBe(false);
    layout("list.selectedRow", 40);
    expect(onSelectedRowLayout).not.toHaveBeenCalled();
    layout("list.group.second", 200);
    expect(onSelectedRowLayout).toHaveBeenLastCalledWith(240);
  });

  it("adds the flat fallback container offset as well", () => {
    const onSelectedRowLayout = vi.fn();
    render(
      createElement(MobileModelPickerList, {
        providerRows: [],
        flatOptions: [
          { id: "a", label: "A", efforts: [] },
          { id: "b", label: "B", efforts: [] },
        ],
        activeModelId: "b",
        activeSourceId: null,
        onSelectProviderRow: vi.fn(),
        onSelectFlatModel: vi.fn(),
        onSelectedRowLayout,
        testID: "flat",
      } as never),
    );
    act(() => native.layouts.get("flat.selectedRow")!({ nativeEvent: { layout: { y: 60 } } }));
    expect(onSelectedRowLayout).not.toHaveBeenCalled();
    act(() => native.layouts.get("flat.group.__flat__")!({ nativeEvent: { layout: { y: 120 } } }));
    expect(onSelectedRowLayout).toHaveBeenLastCalledWith(180);
  });
});

describe("Android permission picker selection matches iOS", () => {
  const options = [
    { id: "ask", label: "Ask" },
    { id: "auto", label: "Auto" },
    { id: "bypassPermissions", label: "Full access" },
  ];

  it("tints only the selected icon; text and check stay neutral", () => {
    render(
      createElement(MobilePermissionPickerList, {
        options,
        activeMode: "auto",
        onSelect: vi.fn(),
        testID: "perm",
      } as never),
    );
    const rows = [...host.querySelectorAll('button[data-testid="perm"]')];
    expect(rows.map((row) => row.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    const icon = (row: Element) =>
      row.querySelector('[data-icon="permission"]')!.getAttribute("data-color");
    expect(icon(rows[1])).toBe("c.permAutoAccent");
    expect(icon(rows[2])).toBe("c.textSecondary");
    expect(rows[1].querySelector("span")!.getAttribute("data-color")).toBe(
      "c.textPrimary",
    );
    expect(
      rows[1].querySelector('[data-icon="Check"]')!.getAttribute("data-color"),
    ).toBe("c.textPrimary");
  });

  it("closes the Android sheet first and applies the mode only after the close finishes", () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const onSelect = vi.fn((mode: string) => order.push(`select:${mode}`));
    render(
      createElement(NativePermissionSheet, {
        visible: true,
        onClose,
        onSelect,
        options,
        activeMode: "ask",
        testID: "session.permissionSheet",
      } as never),
    );
    const rows = host.querySelectorAll(
      'button[data-testid="session.permissionSheet.option"]',
    );
    act(() => (rows[2] as HTMLButtonElement).click());
    expect(order).toEqual(["close"]);
    act(() => native.onClosed?.());
    expect(order).toEqual(["close", "select:bypassPermissions"]);
    // 背板关闭等后续 onClosed 不会重放上一次选择。
    act(() => native.onClosed?.());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("Android goal form follows the iOS form", () => {
  const base = {
    busy: false,
    error: null,
    onSetGoal: vi.fn(),
    onPauseGoal: vi.fn(),
    onResumeGoal: vi.fn(),
    onClearGoal: vi.fn(),
  };

  it("keeps limits collapsed until Advanced opens, then edits them through pull-down menus", () => {
    const onSetGoal = vi.fn();
    render(
      createElement(ContextSheetGoalView, {
        ...base,
        goal: null,
        onSetGoal,
        initialObjective: "目标",
      } as never),
    );
    expect(byId("contextSheet.goalMaxTurnsOptions")).toBeNull();
    expect(
      byId("contextSheet.goalAdvancedToggle")!.getAttribute("aria-expanded"),
    ).toBe("false");
    click("contextSheet.goalAdvancedToggle");
    expect(
      byId("contextSheet.goalAdvancedToggle")!.getAttribute("aria-expanded"),
    ).toBe("true");
    const turns = native.menus.get("contextSheet.goalMaxTurnsOptions.menu")!;
    expect(turns.actions.map((action) => action.id)).toEqual([
      "10",
      "20",
      "50",
      "100",
      "unlimited",
    ]);
    expect(turns.actions.find((action) => action.state === "on")!.id).toBe(
      "unlimited",
    );
    act(() => turns.onAction("20"));
    const budget = native.menus.get("contextSheet.goalBudgetOptions.menu")!;
    expect(budget.actions.map((action) => action.title)).toEqual([
      "500K",
      "1M",
      "2M",
      "5M",
      "interaction.contextSheet.unlimited",
    ]);
    click("contextSheet.goalStartButton");
    expect(onSetGoal).toHaveBeenCalledWith({
      objective: "目标",
      limits: { maxTurns: 20, budgetTokens: null, noProgressLimit: 3 },
    });
  });

  it("falls back to inline limit choices without a native menu", () => {
    native.menu = false;
    const onSetGoal = vi.fn();
    render(
      createElement(ContextSheetGoalView, {
        ...base,
        goal: null,
        onSetGoal,
        initial: {
          objective: "恢复",
          limits: { maxTurns: 17, budgetTokens: null, noProgressLimit: 3 },
        },
      } as never),
    );
    click("contextSheet.goalAdvancedToggle");
    click("contextSheet.goalNoProgressOptions.trigger");
    expect(
      byId("contextSheet.goalNoProgressOptions.option.3")!.getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    click("contextSheet.goalNoProgressOptions.option.unlimited");
    expect(byId("contextSheet.goalNoProgressOptions.option.3")).toBeNull();
    click("contextSheet.goalMaxTurnsOptions.trigger");
    // 历史自定义值前置保留。
    expect(
      byId("contextSheet.goalMaxTurnsOptions.option.17")!.getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    click("contextSheet.goalStartButton");
    expect(onSetGoal).toHaveBeenCalledWith({
      objective: "恢复",
      limits: { maxTurns: 17, budgetTokens: null, noProgressLimit: null },
    });
  });

  it("shows the disabled hint like iOS when creation is unavailable", async () => {
    const { ContextSheetGoalCreateForm } =
      await import("@/session/ContextSheetGoalView");
    render(
      createElement(ContextSheetGoalCreateForm, {
        busy: false,
        error: null,
        onSetGoal: vi.fn(),
        disabled: true,
        disabledHint: "not ready",
      } as never),
    );
    expect(byId("contextSheet.goalDisabledHint")!.textContent).toBe(
      "not ready",
    );
  });

  it.each([
    [
      "active",
      ["contextSheet.goalPauseButton", "contextSheet.goalClearButton"],
    ],
    [
      "paused",
      ["contextSheet.goalResumeButton", "contextSheet.goalClearButton"],
    ],
    ["completed", ["contextSheet.goalClearButton"]],
  ])("orders the %s status view like iOS", (status, actions) => {
    render(
      createElement(ContextSheetGoalView, {
        ...base,
        goal: {
          status,
          objective: "写完文档",
          turnsUsed: 3,
          tokensUsed: 1_000_000,
          maxTurns: 10,
          budgetTokens: null,
          lastReason: "waiting",
        },
      } as never),
    );
    const text = host.textContent ?? "";
    const order = [
      `status:${status}`,
      "写完文档",
      "interaction.contextSheet.goalMeta",
      "waiting",
    ].map((part) => text.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const buttons = [
      ...host.querySelectorAll('button[data-testid^="contextSheet.goal"]'),
    ].map((node) => node.getAttribute("data-testid"));
    expect(buttons).toEqual(actions);
  });
});

describe("Android legacy model sheet exposes permissions as a standalone row like iOS", () => {
  function sheetProps(overrides: AnyProps = {}) {
    return {
      visible: true,
      onClose: vi.fn(),
      providers: [],
      flatOptions: [],
      providersReady: true,
      agentKind: "codex",
      capabilities: null,
      activeModelId: "",
      selectedProviderId: null,
      selectedEffort: "",
      selectedFastMode: false,
      onSelectProviderRow: vi.fn(),
      onSelectFlatModel: vi.fn(),
      permissionOptions: [
        { id: "ask", label: "Ask" },
        { id: "auto", label: "Auto" },
      ],
      activePermissionMode: "auto",
      onSelectPermissionMode: vi.fn(),
      keyboardAvoidingBehavior: undefined,
      testID: "modelSheet",
      ...overrides,
    };
  }

  it("shows a Permissions row with the current mode and opens the permission page", () => {
    const props = sheetProps();
    render(createElement(ModelPickerSheet, props as never));
    const row = byId("modelSheet.permissionTrigger")!;
    expect(row.textContent).toContain("models.picker.permissionTitle");
    expect(row.textContent).toContain("Auto");
    expect(row.getAttribute("aria-label")).toBe(
      "models.picker.permissionModeAccessibility:Auto",
    );
    click("modelSheet.permissionTrigger");
    const options = host.querySelectorAll(
      'button[data-testid="modelSheet.permissionOption"]',
    );
    expect(options).toHaveLength(2);
    act(() => (options[0] as HTMLButtonElement).click());
    expect(props.onSelectPermissionMode).toHaveBeenCalledWith("ask");
    expect(
      host.querySelector('button[data-testid="modelSheet.permissionOption"]'),
    ).toBeNull();
  });

  it("omits the row when the host provides its own permission control", () => {
    render(
      createElement(
        ModelPickerSheet,
        sheetProps({ hidePermissionTrigger: true }) as never,
      ),
    );
    expect(byId("modelSheet.permissionTrigger")).toBeNull();
  });

  it("adds a clear action to the search field", () => {
    render(createElement(ModelPickerSheet, sheetProps() as never));
    expect(byId("modelSheet.search.clear")).toBeNull();
    act(() => {
      const input = byId("modelSheet.search") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "gpt");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((byId("modelSheet.search") as HTMLInputElement).value).toBe("gpt");
    click("modelSheet.search.clear");
    expect((byId("modelSheet.search") as HTMLInputElement).value).toBe("");
  });
});
