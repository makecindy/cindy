// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTaskSuggestions } from "@/session/RemoteTaskSuggestions";
import { isTaskSuggestionsSyncPending, useRemoteTaskSuggestionsPresentation } from "@/session/useRemoteTaskSuggestionsPresentation";
import type { RemoteTaskSuggestionsMode } from "@/session/remoteTaskSuggestionsModel";
import { i18n } from "@/i18n";
import { REMOTE_TASK_SUGGESTION_BATCHES } from "@/session/remoteTaskSuggestionsModel";

const theme = vi.hoisted(() => ({ mode: "light" }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const View = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    View,
    Text: View,
    StyleSheet: { create: (value: unknown) => value },
  };
});
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
}));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "BookOpen",
      "ChevronRight",
      "FileText",
      "FolderDown",
      "Gauge",
      "HardDrive",
      "Shuffle",
    ].map((name) => [name, () => null]),
  ),
);
vi.mock("@/components/MobilePrimitives", async () => {
  const { createElement } = await import("react");
  return {
    StatusDot: () => null,
    MainWindowRowButton: ({
      children,
      onPress,
      testID,
      disabled,
    }: {
      children: ReactNode;
      onPress(): void;
      testID: string;
      disabled?: boolean;
    }) =>
      createElement(
        "button",
        { onClick: onPress, disabled, "data-testid": testID },
        children,
      ),
    MainWindowActionButton: ({
      action,
    }: {
      action: { label: string; onPress(): void; testID: string; disabled?: boolean };
    }) =>
      createElement(
        "button",
        { onClick: action.onPress, disabled: action.disabled, "data-testid": action.testID },
        action.label,
      ),
  };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  const colors = () =>
    theme.mode === "light" ? tokens.lightColors : tokens.darkColors;
  return {
    useTheme: () => ({ colors: colors() }),
    useThemedStyles: (make: (value: typeof tokens.lightColors) => unknown) =>
      make(colors()),
  };
});
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  await i18n.changeLanguage("zh-CN");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
const click = (id: string) =>
  act(() =>
    host
      .querySelector<HTMLButtonElement>(
        `[data-testid="home.taskSuggestions.${id}"]`,
      )!
      .click(),
  );

describe("remote task recommendations", () => {
  const select = vi.fn();
  const create = vi.fn();
  function Presentation(props: { scope: string; candidateMode: RemoteTaskSuggestionsMode; syncing: boolean }) {
    const { mode, pending } = useRemoteTaskSuggestionsPresentation(props);
    return mode ? <RemoteTaskSuggestions mode={mode} onSelect={select} onNewSession={create} />
      : <div>{pending ? 'loading' : 'fallback'}</div>;
  }
  const renderPresentation = (syncing: boolean, candidateMode: RemoteTaskSuggestionsMode = 'empty', scope = 'account:computer') =>
    act(() => root.render(<Presentation scope={scope} syncing={syncing} candidateMode={candidateMode} />));

  it.each(['light', 'dark'])('waits for first sync and keeps recommendations through a refresh in %s', (mode) => {
    theme.mode = mode;
    select.mockClear();
    create.mockClear();
    renderPresentation(true);
    expect(host.textContent).toBe('loading');
    renderPresentation(false);
    expect(host.textContent).toContain('电脑已连接');
    click('shuffle');
    renderPresentation(true);
    expect(host.textContent).toContain('电脑已连接');
    expect(host.textContent).toContain('看看下载文件夹里有什么');
    click('downloads');
    click('newTask');
    expect(select).toHaveBeenCalledWith('downloads');
    expect(create).toHaveBeenCalledOnce();
    renderPresentation(false);
    click('downloads');
    expect(select).toHaveBeenCalledWith('downloads');
  });

  it('waits before a newly selected cached device is acquired and through queued hydration', () => {
    renderPresentation(false);
    const owned = new Set<string>();
    const renderDevice = (state: 'idle' | 'syncing') => renderPresentation(
      isTaskSuggestionsSyncPending(['other'], owned, { other: state }), 'empty', 'account:other',
    );
    renderDevice('idle'); // Selection render, before the passive acquisition effect.
    expect(host.textContent).toBe('loading');
    renderDevice('syncing'); // Queued behind another peer, owner not acquired yet.
    expect(host.textContent).toBe('loading');
    owned.add('other');
    renderDevice('syncing');
    expect(host.textContent).toBe('loading');
    renderDevice('idle');
    expect(host.textContent).toContain('电脑已连接');
  });

  it('waits for every peer in all-tasks scope, including peers queued beyond the batch limit', () => {
    const owned = new Set(['primary']);
    const renderPeers = (secondary?: 'syncing' | 'idle') => renderPresentation(
      isTaskSuggestionsSyncPending(['primary', 'secondary'], owned,
        { primary: 'idle', ...(secondary ? { secondary } : {}) }),
      'empty', 'account:all',
    );
    renderPeers(); // Primary done; secondary hydration has not started.
    expect(host.textContent).toBe('loading');
    owned.add('secondary');
    renderPeers('syncing');
    expect(host.textContent).toBe('loading');
    renderPeers('idle');
    expect(host.textContent).toContain('电脑已连接');
    click('shuffle');
    renderPeers('syncing');
    expect(host.textContent).toContain('看看下载文件夹里有什么');
    expect(isTaskSuggestionsSyncPending(['primary'], owned, { secondary: 'syncing' })).toBe(false);
    expect(isTaskSuggestionsSyncPending(['secondary'], owned, { secondary: 'failed' })).toBe(false);
  });

  it('does not carry ready presentation into another account or device', () => {
    renderPresentation(false);
    renderPresentation(true, 'empty', 'account:other-computer');
    expect(host.textContent).toBe('loading');
    renderPresentation(false, 'empty', 'account:other-computer');
    renderPresentation(true, 'empty', 'other-account:other-computer');
    expect(host.textContent).toBe('loading');
  });

  it('releases retained recommendations on unavailable, error, filtered-empty or nonempty outcomes', () => {
    renderPresentation(false);
    renderPresentation(true);
    expect(host.textContent).toContain('电脑已连接');
    // These outcomes all produce no candidate; they must keep their own page branch.
    renderPresentation(true, null);
    expect(host.textContent).toBe('fallback');
    renderPresentation(true);
    expect(host.textContent).toBe('loading');
  });

  it('retains an existing footer but does not replace a task list with loading', () => {
    renderPresentation(true, 'footer');
    expect(host.textContent).toBe('fallback');
    renderPresentation(false, 'footer');
    renderPresentation(true, 'footer');
    expect(host.textContent).toContain('接下来，让电脑帮你');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="home.taskSuggestions.findFile"]')?.disabled).toBe(false);
  });
  it.each(["light", "dark"])(
    "offers editable task selection and another batch with %s tokens",
    (mode) => {
      theme.mode = mode;
      const select = vi.fn();
      const create = vi.fn();
      act(() =>
        root.render(
          <RemoteTaskSuggestions
            mode="empty"
            onNewSession={create}
            onSelect={select}
          />,
        ),
      );
      expect(host.textContent).toContain("电脑已连接");
      click("findFile");
      expect(select).toHaveBeenCalledWith("findFile");
      expect(create).not.toHaveBeenCalled();
      click("shuffle");
      expect(host.textContent).not.toContain("找一份电脑上的文件");
      click("downloads");
      expect(select).toHaveBeenLastCalledWith("downloads");
      click("newTask");
      expect(create).toHaveBeenCalledOnce();
    },
  );
  it("keeps the footer compact without a duplicate welcome or primary button", () => {
    act(() =>
      root.render(
        <RemoteTaskSuggestions
          mode="footer"
          onNewSession={vi.fn()}
          onSelect={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain("接下来，让电脑帮你");
    expect(host.textContent).not.toContain("电脑已连接");
    expect(
      host.querySelector('[data-testid="home.taskSuggestions.newTask"]'),
    ).toBeNull();
  });
  it.each(["zh-CN", "zh-TW", "en", "ja", "ko"])(
    "has real labels and editable prompts in %s",
    async (language) => {
      await i18n.changeLanguage(language);
      for (const id of REMOTE_TASK_SUGGESTION_BATCHES.flat()) {
        for (const field of ["label", "hint", "prompt"]) {
          const key = `devices.list.taskSuggestions.items.${id}.${field}`;
          expect(i18n.exists(key, { lng: language, fallbackLng: false })).toBe(
            true,
          );
          expect(i18n.t(key, { lng: language })).not.toBe(key);
        }
      }
    },
  );
});
