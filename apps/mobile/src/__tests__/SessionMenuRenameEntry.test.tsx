// @vitest-environment jsdom
vi.mock('@/session/TaskTags', () => ({ TaskTagsPanel: () => null }));
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  SessionMenuSheet,
  type SessionMenuSheetProps,
} from "@/session/SessionMenuSheet";
import { i18n } from "@/i18n";
import { sharedTaskHostPeer } from '@cindy/device-link';

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const view = ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    createElement("div", { onClick: onPress, "data-testid": testID }, children);
  return {
    Platform: { OS: 'android' },
    View: view,
    Pressable: view,
    Text: view,
    TextInput: view,
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    Animated: {
      Value: class {
        setValue() {}
      },
      View: view,
      timing: () => ({ start: (done?: () => void) => done?.() }),
    },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    Easing: { bezier: () => (t: number) => t },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => Promise.resolve(false),
      addEventListener: () => ({ remove() {} }),
    },
    useWindowDimensions: () => ({ height: 800, width: 400 }),
  };
});
vi.mock("@/components/AppText", async () => {
  const rn = await import("react-native");
  return { Text: rn.Text, TextInput: rn.TextInput };
});
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "Archive",
      "ArchiveRestore",
      "ChevronRight",
      "Copy",
      "Folder",
      "GitBranch",
      "Link2",
      "LogOut",
      "Monitor",
      "Pencil",
      "Pin",
      "PinOff",
      "RefreshCw",
      "Search",
      "Sparkles",
      "Trash2",
    ].map((name) => [name, () => null]),
  ),
);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    monoFont: "monospace",
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: typeof tokens.lightColors) => unknown) =>
      make(tokens.lightColors),
  };
});
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  type Action = { onPress(): void; testID: string };
  return {
    MainWindowActionButton: () => null,
    MainWindowActionGroup: ({ primaryActions, cancelAction }: { primaryActions: Action[]; cancelAction?: Action }) =>
      createElement("div", null, [...primaryActions, ...(cancelAction ? [cancelAction] : [])].map((action) =>
        createElement("button", { key: action.testID, "data-testid": action.testID, onClick: action.onPress }))),
  };
});
vi.mock("@/session/SheetModal", () => ({
  SheetModal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => <>{children}{footer}</>,
}));
vi.mock("@/session/messageActions", () => ({ writeClipboardText: vi.fn(), formatModelShortLabel: (id: string) => id }));

function baseProps(overrides: Partial<SessionMenuSheetProps> = {}) {
  const reader = {
    getContextUsage: vi.fn(async () => ({ totalTokens: 20, rawMaxTokens: 100 })),
    getCodexRateLimits: vi.fn(),
    getAccountUsage: vi.fn(),
    getSessionEstimatedValue: vi.fn(async () => ({})),
  };
  return {
    usageReader: reader,
    onContextError: vi.fn(),
    onRefreshAccountUsage: vi.fn(),
    onOpenSearch: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    session: { id: "a", model: "custom", providerId: "custom", agentKind: "pi", title: "Task" },
    initialView: "rename",
    visible: true,
    busy: false,
    ...overrides,
  } as unknown as SessionMenuSheetProps;
}

async function renderSheet(props: SessionMenuSheetProps) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage("zh-CN");
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<SessionMenuSheet {...props} />));
  const click = async (testID: string) => {
    const node = host.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
    if (!node) throw new Error(`missing ${testID}`);
    await act(async () => node.click());
  };
  return { host, root, click };
}

it("opening at rename goes straight to the editor and cancel closes the sheet", async () => {
  const props = baseProps();
  const { host, root, click } = await renderSheet(props);
  try {
    expect(host.querySelector('[data-testid="session.renameBlock"]')).not.toBeNull();
    await click("session.renameCancelButton");
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(props.onRename).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("confirming a direct rename closes the sheet", async () => {
  const props = baseProps();
  const { root, click } = await renderSheet(props);
  try {
    await click("session.renameButton");
    expect(props.onClose).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it("renaming from the menu returns to the menu instead of closing", async () => {
  const props = baseProps({ initialView: "menu" });
  const { host, root, click } = await renderSheet(props);
  try {
    expect(host.querySelector('[data-testid="session.renameBlock"]')).toBeNull();
    await click("session.renameAction");
    expect(host.querySelector('[data-testid="session.renameBlock"]')).not.toBeNull();
    await click("session.renameCancelButton");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="session.renameBlock"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["host-managed", { messageOnly: true }],
  ["worker", { session: { id: "a", title: "Task", orcaRole: "worker" } }],
  ["shared guest", { session: { id: "a", title: "Task", deviceLinkDeviceId: sharedTaskHostPeer("shared", "desktop") } }],
  ["busy", { busy: true }],
] as const)("a %s task does not open the rename editor", async (_name, overrides) => {
  const props = baseProps(overrides as Partial<SessionMenuSheetProps>);
  const { host, root } = await renderSheet(props);
  try {
    expect(host.querySelector('[data-testid="session.renameBlock"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
