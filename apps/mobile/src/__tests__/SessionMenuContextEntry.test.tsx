// @vitest-environment jsdom
vi.mock('@/session/SessionProjectMoveSheet', () => ({
  sessionAllowsProjectMove: () => false,
  useSessionProjectMoveSheet: () => ({ open: vi.fn(), parentClosed: vi.fn(), sheet: null }),
}));
vi.mock('@/session/TaskTags', () => ({ TaskTagsPanel: () => null }));
vi.mock('@/session/SessionPrLinks', () => ({ SessionPrLinks: () => null }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 0 }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null) } }));
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  SessionMenuSheet,
  type SessionMenuSheetProps,
} from "@/session/SessionMenuSheet";
import { i18n } from "@/i18n";
import { sharedTaskHostPeer } from '@cindy/device-link';
import { SessionMenuPrLinks } from '@/session/SessionMenuPrLinks';
import type { HomeSessionPrInfo } from '@/session/homeSessionPrStore';
import { __testing as prStoreTesting } from '@/session/homeSessionPrStore';

const prFixture = vi.hoisted(() => ({ value: null as HomeSessionPrInfo | null, openURL: vi.fn(async (_url: string) => {}) }));
vi.mock('@/device-link/DeviceLinkContext', () => {
  const link = {
    status: 'online', connectionEpoch: 0, getPresenceAvailability: () => true,
    invoke: vi.fn(async (_device: string, channel: string) => {
      const rows = prFixture.value ? [prFixture.value, ...(prFixture.value.additional ?? [])] : [];
      return channel.endsWith(':list') ? rows.map(row => row.ref) : rows.flatMap(row => row.status ? [row.status] : []);
    }),
  };
  return { useDeviceLink: () => link };
});
vi.mock('@/session/remoteSessionStore', () => {
  const visibility = { isActive: () => true, onResume: () => () => {} };
  return { useRemoteSessionStoreVisibility: () => visibility, useRemoteSessionUsage: () => ({}) };
});

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
    Linking: { openURL: prFixture.openURL },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
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
      "GitMerge",
      "GitPullRequest",
      "GitPullRequestClosed",
      "GitPullRequestDraft",
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
vi.mock("@/components/MobilePrimitives", () => ({
  MainWindowActionGroup: () => null,
}));
vi.mock("@/session/SheetModal", () => ({
  SheetModal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/session/SheetSurface", () => ({
  SheetSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/session/messageActions", () => ({ writeClipboardText: vi.fn(), formatModelShortLabel: (id: string) => id }));

// Unit: the new primary-menu entry must open the linked PR/MR even if its status
// lookup fails. Existing context/rename tests never exercised linked destinations.
// Minimal input: one GitHub PR plus a self-hosted GitLab MR with unknown status.
it('opens linked PRs and MRs from the primary menu with status labels and handles open failures', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage('en');
  prStoreTesting.reset();
  const ref = { id: 'pr', sessionId: 'a', owner: 'team', repo: 'app', prNumber: 12, firstSeenAt: 1, lastSeenAt: 1, url: '' };
  prFixture.value = {
    ref,
    status: { ...ref, ok: true, status: 'merged', title: 'A change', htmlUrl: '', branch: 'fix', unresolvedCount: 0 },
    additional: [{ ref: { ...ref, id: 'mr', provider: 'gitlab', host: 'git.example.com', owner: 'team/subgroup', prNumber: 9 }, status: null }],
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="a" visible />));
    const pr = host.querySelector<HTMLElement>('[data-testid="session.menuPr.pr"]')!;
    const mr = host.querySelector<HTMLElement>('[data-testid="session.menuPr.mr"]')!;
    expect(pr.textContent).toContain('team/app #12');
    expect(pr.textContent).toContain('Merged');
    expect(mr.textContent).toContain('team/subgroup/app !9');
    expect(mr.textContent).toContain('Status not loaded yet');
    await act(async () => pr.click());
    expect(prFixture.openURL).toHaveBeenLastCalledWith('https://github.com/team/app/pull/12');
    prFixture.openURL.mockRejectedValueOnce(new Error('No browser'));
    await act(async () => mr.click());
    expect(prFixture.openURL).toHaveBeenLastCalledWith('https://git.example.com/team/subgroup/app/-/merge_requests/9');
    expect(host.textContent).toContain(i18n.t('devices.glance.openFailed'));
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="a" visible={false} />));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    prFixture.value = null;
    prStoreTesting.reset();
  }
});

// Unit: #10106 originally reused a fresh cache after details-page edits. Render
// the real menu and PR hook, change the remote association reply while hidden,
// then reopen inside the cache TTL; the old link must be replaced immediately.
it('shows edited associations when returning from details to the primary menu', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage('en');
  prStoreTesting.reset();
  const ref = { id: 'old', sessionId: 's', owner: 'team', repo: 'app', prNumber: 7, firstSeenAt: 1, lastSeenAt: 1, url: '' };
  prFixture.value = { ref, status: null };
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="s" visible />));
    expect(host.textContent).toContain('team/app #7');
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="s" visible={false} />));
    prFixture.value = { ref: { ...ref, id: 'new', prNumber: 8, pinned: true }, status: null };
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="s" visible />));
    expect(host.textContent).toContain('team/app #8');
    expect(host.textContent).not.toContain('team/app #7');
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="s" visible={false} />));
    prFixture.value = null;
    await act(async () => root.render(<SessionMenuPrLinks deviceId="d" sessionId="s" visible />));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    prFixture.value = null;
    prStoreTesting.reset();
  }
});

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
    onOpenSearch: vi.fn(),
    onOpenSharing: vi.fn(),
    onLeaveSharing: vi.fn(),
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
    const search = host.querySelector('[data-testid="session.detailsSearch"]');
    expect(search).not.toBeNull();
    await act(async () => (search as HTMLElement).click());
    expect(props.onOpenSearch).toHaveBeenCalledOnce();
    const sharing = host.querySelector('[data-testid="session.sharingButton"]');
    expect(sharing?.textContent).toBe('共享任务');
    await act(async () => root.render(<SessionMenuSheet {...props} initialView="menu" session={{ ...props.session, deviceLinkDeviceId: sharedTaskHostPeer('shared', 'desktop') }} />));
    expect(host.querySelector('[data-testid="session.sharingButton"]')).toBeNull();
    const leave = host.querySelector('[data-testid="session.leaveSharingButton"]');
    expect(leave?.textContent).toBe('退出共享任务');
    await act(async () => (leave as HTMLElement).click());
    expect(props.onLeaveSharing).toHaveBeenCalledOnce();
    expect(props.onOpenSharing).not.toHaveBeenCalled();
    await act(async () => root.render(<SessionMenuSheet {...props} initialView="menu" />));
    const summary = host.querySelector('[data-testid="session.menuUsageRow"]');
    expect(summary).not.toBeNull();
    await act(async () => (summary as HTMLElement).click());
    expect(reader.getContextUsage).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<SessionMenuSheet {...props} messageOnly initialView="menu" />));
    expect(host.querySelector('[data-testid="session.detailsSearch"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session.menuUsageRow"]')).toBeNull();
    expect(host.querySelector('[data-testid="session.infoLayer"]')).toBeNull();
    expect(reader.getContextUsage).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});
