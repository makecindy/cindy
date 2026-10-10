// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => ({ props: null as any }));
const driveMenu = vi.hoisted(() => ({ props: null as any }));
vi.mock("react-native", () => ({
  View: ({ children }: any) => <div>{children}</div>,
  ActivityIndicator: () => <span>loading</span>,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 20 }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children }: any) => <span>{children}</span>,
}));
vi.mock("@/theme", () => ({
  iconSize: {},
  lineHeight: {},
  spacing: {},
  typeScale: {},
  useTheme: () => ({ colors: {} }),
}));
vi.mock("lucide-react-native", () => ({
  ArrowUp: () => null,
  ChevronRight: () => null,
  Folder: () => null,
  FolderPlus: () => null,
  Laptop: () => null,
  MessageCircle: () => null,
}));
vi.mock("@/session/NewTaskSelectionRow", () => ({
  NewTaskSelectionRow: ({ title, testID, selected, disabled, onPress }: any) => (
    <button
      data-testid={testID}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPress}
    >
      {title}
    </button>
  ),
}));
vi.mock("@/platform/chrome", () => ({
  NativePullDownMenu: (p: any) => {
    driveMenu.props = p;
    return p.children;
  },
  NativeSwitch: () => null,
}));
vi.mock("@/session/SheetModal", () => ({
  SheetModal: (p: any) => {
    modal.props = p;
    return p.children;
  },
}));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: ({ children, footer }: any) => (
    <>
      {children}
      {footer}
    </>
  ),
}));
vi.mock("@/session/ContextSheet", () => ({
  ContextSheetFooterButton: ({ label, testID, disabled, onPress }: any) => (
    <button data-testid={testID} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("@/session/newSessionMessages", () => ({
  newSessionText: (s: string) => s,
}));
import { NewTaskSelectionSheet } from "@/session/NewTaskSelectionSheet.android";
import type { NewTaskSelectionSheetProps } from "@/session/NewTaskSelectionSheet";

let root: Root;
let container: HTMLDivElement;
let props: NewTaskSelectionSheetProps;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  props = {
    page: "device",
    busy: false,
    devices: [{ deviceId: "pc", name: "PC" }],
    selectedDeviceId: "pc",
    workspaces: [{ title: "Project", workingDir: "D:/project" }],
    workspaceKind: "project",
    workingDir: "D:/project",
    path: "D:/project",
    parent: "D:/",
    drives: [],
    entries: [{ name: "src", path: "D:/project/src" }],
    loading: false,
    error: null,
    showHidden: false,
    onClose: vi.fn(),
    onBack: vi.fn(),
    onDevice: vi.fn(),
    onDialogue: vi.fn(),
    onProject: vi.fn(),
    onBrowse: vi.fn(),
    onEnter: vi.fn(),
    onChoose: vi.fn(),
    onShowHidden: vi.fn(),
  };
});
afterEach(() => act(() => root.unmount()));
function render(p: Partial<NewTaskSelectionSheetProps> = {}) {
  props = { ...props, ...p };
  act(() => root.render(<NewTaskSelectionSheet {...props} />));
}
function click(id: string) {
  act(() =>
    (
      container.querySelector(
        `[data-testid="newSession.${id}"]`,
      ) as HTMLButtonElement
    ).click(),
  );
}
it("selects a device and retains the native presentation until its closing animation finishes", () => {
  render();
  click("deviceOption");
  expect(props.onDevice).toHaveBeenCalledWith("pc");
  expect(modal.props.nativePresentation).toBe(true);
  render({ page: null });
  expect(modal.props.visible).toBe(false);
  expect(modal.props.nativePresentation).toBe(true);
});
it("keeps directory Back separate from backdrop dismissal and uses remote paths", () => {
  render({ page: "directory" });
  expect(modal.props.nativePresentation).toBe(false);
  act(() => modal.props.onRequestClose());
  expect(props.onBack).toHaveBeenCalledOnce();
  expect(props.onClose).not.toHaveBeenCalled();
  act(() => modal.props.onBackdropPress());
  expect(props.onClose).toHaveBeenCalledOnce();
  click("remoteBrowseParentButton");
  click("remoteBrowseEnterEntry");
  expect(props.onEnter).toHaveBeenNthCalledWith(1, "D:/");
  expect(props.onEnter).toHaveBeenNthCalledWith(2, "D:/project/src");
  click("remoteBrowseSelectCurrent");
  expect(props.onChoose).toHaveBeenCalledWith("D:/project");
});
it("gives the native drive menu an explicit screen-reader label", () => {
  render({
    page: "directory",
    drives: [
      { name: "C:", path: "C:/", current: true },
      { name: "D:", path: "D:/", current: false },
    ],
  });
  expect(driveMenu.props.accessibilityLabel).toBe("session.new.drive, C:");
});
it.each([
  { loading: true },
  { busy: true },
  { error: "offline" },
  { path: "" },
])("does not choose an unavailable directory (%j)", (state) => {
  render({ page: "directory", ...state });
  click("remoteBrowseSelectCurrent");
  expect(props.onChoose).not.toHaveBeenCalled();
});
it("keeps workspace choices and blocks them while busy", () => {
  render({ page: "workspace" });
  click("workspaceDialogueOption");
  click("workspaceProjectOption");
  click("workspaceBrowseOption");
  expect(props.onDialogue).toHaveBeenCalledOnce();
  expect(props.onProject).toHaveBeenCalledWith("D:/project");
  expect(props.onBrowse).toHaveBeenCalledOnce();
  render({ busy: true });
  click("workspaceBrowseOption");
  expect(props.onBrowse).toHaveBeenCalledOnce();
});
