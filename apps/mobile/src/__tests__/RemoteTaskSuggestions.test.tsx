// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTaskSuggestions } from "@/session/RemoteTaskSuggestions";
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
    }: {
      children: ReactNode;
      onPress(): void;
      testID: string;
    }) =>
      createElement(
        "button",
        { onClick: onPress, "data-testid": testID },
        children,
      ),
    MainWindowActionButton: ({
      action,
    }: {
      action: { label: string; onPress(): void; testID: string };
    }) =>
      createElement(
        "button",
        { onClick: action.onPress, "data-testid": action.testID },
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
