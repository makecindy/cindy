// @vitest-environment jsdom
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => ({ props: null as any }));
const surface = vi.hoisted(() => ({ props: null as any, mounts: 0 }));
const driveMenu = vi.hoisted(() => ({ props: null as any }));
vi.mock("react-native", () => ({
  View: ({ children }: any) => <div>{children}</div>,
  ActivityIndicator: () => <span>loading</span>,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
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
  useThemedStyles: (make: (colors: object) => unknown) => make({}),
}));
vi.mock("lucide-react-native", () => ({
  CircleAlert: () => null,
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
  SheetSurface: (p: any) => {
    surface.props = p;
    useEffect(() => { surface.mounts++; }, []);
    return <>{p.children}{p.footer}</>;
  },
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

// #7237 / unit: the real selection sheet must disambiguate two ID-as-name
// computers, a missing input in the single-device tests, and keep routing IDs.
it("distinguishes unnamed device choices without changing their selection targets", () => {
  render({ devices: [
    { deviceId: "host-b", name: "host-b" },
    { deviceId: "host-a", name: "host-a" },
  ] });
  const rows = [...container.querySelectorAll('[data-testid="newSession.deviceOption"]')] as HTMLButtonElement[];
  expect(rows.map(row => row.textContent)).toEqual(["another computer (2)", "another computer (1)"]);
  act(() => rows[0].click());
  expect(props.onDevice).toHaveBeenCalledExactlyOnceWith("host-b");
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

it("selects an equivalent remote Windows path and sends the original workspace path", () => {
  render({ page: "workspace", workingDir: "d:\\PROJECT\\" });
  const row = container.querySelector('[data-testid="newSession.workspaceProjectOption"]')!;
  expect(row.getAttribute("aria-pressed")).toBe("true");
  click("workspaceProjectOption");
  expect(props.onProject).toHaveBeenCalledExactlyOnceWith("D:/project");
  render({ workspaceKind: "dialogue" });
  expect(row.getAttribute("aria-pressed")).toBe("false");
  render({ workspaceKind: "project", workingDir: "D:/different" });
  expect(row.getAttribute("aria-pressed")).toBe("false");
});

it.each([
  ["/repo", "/repo/.cindy-worktrees/branch"],
  ["D:/repo", "d:\\repo\\.cindy-worktrees\\branch"],
])("does not mark %s selected when the draft uses a worktree", (base, worktree) => {
  render({ page: "workspace", workingDir: worktree, workspaces: [{ title: "repo", workingDir: base }] });
  const row = container.querySelector('[data-testid="newSession.workspaceProjectOption"]')!;
  expect(row.getAttribute("aria-pressed")).toBe("false");
  expect(props.workingDir).toBe(worktree);
  click("workspaceProjectOption");
  expect(props.onProject).toHaveBeenCalledExactlyOnceWith(base);
  render({ workingDir: base });
  expect(row.getAttribute("aria-pressed")).toBe("true");
});

// PR #9826 / unit: a failed move is visible but does not invalidate a loaded folder.
it("keeps a loaded folder selectable while displaying a move error", () => {
  render({ page: "directory", actionError: "Move failed" });
  expect(container.textContent).toContain("Move failed");
  click("remoteBrowseSelectCurrent");
  expect(props.onChoose).toHaveBeenCalledExactlyOnceWith("D:/project");
});

// PR #9826 / unit: project moving may mark the existing membership unavailable.
it("shows the current project but does not dispatch its disabled selection", () => {
  render({ page: "workspace", workspaces: [{ title: "Project", workingDir: "D:/project", disabled: true }] });
  const row = container.querySelector('[data-testid="newSession.workspaceProjectOption"]') as HTMLButtonElement;
  expect(row.getAttribute("aria-pressed")).toBe("true");
  expect(row.disabled).toBe(true);
  click("workspaceProjectOption");
  expect(props.onProject).not.toHaveBeenCalled();
});

// PR #9826: returning from a pending browse must not gate the new-task workspace page.
it.each([false, true])("separates directory reads from workspace loading (%s)", workspaceLoading => {
  render({ page: "workspace", loading: true, workspaceLoading });
  click("workspaceDialogueOption"); click("workspaceProjectOption"); click("workspaceBrowseOption");
  expect(props.onDialogue).toHaveBeenCalledTimes(workspaceLoading ? 0 : 1);
  expect(props.onProject).toHaveBeenCalledTimes(workspaceLoading ? 0 : 1);
  expect(props.onBrowse).toHaveBeenCalledTimes(workspaceLoading ? 0 : 1);
});

// A blocked drag has already collapsed SheetSurface before it calls onClose.
it("restores the surface after a busy drag-dismiss and retains the failure retry", () => {
  render({ page: "directory", busy: true });
  const mounts = surface.mounts;
  act(() => { modal.props.onBackdropPress(); modal.props.onRequestClose(); surface.props.onClose(); });
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onBack).not.toHaveBeenCalled();
  expect(surface.mounts).toBe(mounts + 1);
  render({ busy: false, actionError: "Move failed" });
  expect(container.textContent).toContain("Move failed");
  click("remoteBrowseSelectCurrent");
  expect(props.onChoose).toHaveBeenCalledExactlyOnceWith("D:/project");
  act(() => surface.props.onClose());
  expect(props.onClose).toHaveBeenCalledOnce();
});
