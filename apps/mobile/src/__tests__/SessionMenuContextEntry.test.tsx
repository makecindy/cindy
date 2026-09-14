// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  SessionMenuSheet,
  type SessionMenuSheetProps,
} from "@/session/SessionMenuSheet";
import { i18n } from "@/i18n";

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
      "GitBranch",
      "Link2",
      "Pencil",
      "Pin",
      "PinOff",
      "RefreshCw",
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
vi.mock("@/components/MobilePrimitives", () => ({
  MainWindowActionGroup: () => null,
}));
vi.mock("@/session/SheetModal", () => ({
  SheetModal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/session/messageActions", () => ({ writeClipboardText: vi.fn() }));

it("reopening the primary menu after info does not initialize an engine, but entering info does", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage("zh-CN");
  const reader = {
    getContextUsage: vi.fn(async () => ({
      totalTokens: 20,
      rawMaxTokens: 100,
    })),
    getCodexRateLimits: vi.fn(),
    getAccountUsage: vi.fn(),
    getSessionEstimatedValue: vi.fn(async () => ({})),
  };
  const props = {
    usageReader: reader,
    onContextError: vi.fn(),
    onRefreshAccountUsage: vi.fn(),
    session: {
      id: "a",
      model: "custom",
      providerId: "custom",
      agentKind: "pi",
      title: "Task",
      contextTokens: 20,
      contextWindow: 0,
    },
    initialView: "info",
    visible: true,
    busy: false,
  } as unknown as SessionMenuSheetProps;
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SessionMenuSheet {...props} />));
    expect(reader.getContextUsage).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(<SessionMenuSheet {...props} visible={false} />),
    );
    await act(async () =>
      root.render(<SessionMenuSheet {...props} initialView="menu" />),
    );
    expect(reader.getContextUsage).toHaveBeenCalledOnce();
    // Both surfaces stay mounted. The primary card is the first summary entry.
    const summary = host.querySelector('[data-testid="session.menuUsageRow"]');
    expect(summary).not.toBeNull();
    await act(async () => (summary as HTMLElement).click());
    expect(reader.getContextUsage).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
