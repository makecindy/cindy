// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUsageSummary } from "@/session/SessionUsageSummary";
import { i18n } from "@/i18n";
import type { RemoteSession } from "@/session/types";
import type { useSessionMenuUsage } from "@/session/useSessionMenuUsage";

const theme = vi.hoisted(() => ({ mode: "light" }));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const view =
    (tag: string) =>
    ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) =>
      createElement(
        tag,
        { onClick: onPress, "aria-label": accessibilityLabel },
        children,
      );
  return {
    View: view("div"),
    Pressable: view("button"),
    Text: view("span"),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  };
});
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
}));
vi.mock("lucide-react-native", () => ({ ChevronRight: () => null }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  const colors = () =>
    theme.mode === "light" ? tokens.lightColors : tokens.darkColors;
  return {
    iconSize: tokens.iconSize,
    iconStroke: tokens.iconStroke,
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
afterEach(() => {
  act(() => root.unmount());
});
const session = {
  model: "gpt-5",
  agentKind: "codex",
  providerId: "openai",
  totalCostUsd: 0,
  contextTokens: 45,
  contextWindow: 100,
} as RemoteSession;
const usage: ReturnType<typeof useSessionMenuUsage> = {
  account: {
    source: "chatgpt",
    plan: "pro",
    updatedAt: Date.now(),
    amounts: [],
    windows: [
      {
        id: "primary",
        minutes: 300,
        remainingPercent: 72,
        resetsAt: Date.now() / 1000 + 3600,
      },
    ],
  },
  estimate: {
    amount: 12.3,
    currency: "USD",
    approximate: true,
    kind: "value-estimate",
  },
  loading: false,
  accountFailed: false,
  estimateFailed: false,
  refresh: () => {},
};
describe("task menu usage summary", () => {
  it.each(["light", "dark"])(
    "shows quota, value and context in the first-level entry with %s tokens",
    (mode) => {
      theme.mode = mode;
      const onPress = vi.fn();
      act(() =>
        root.render(
          <SessionUsageSummary
            session={session}
            usage={usage}
            contextUsage={null}
            onPress={onPress}
          />,
        ),
      );
      expect(host.textContent).toContain("剩余 72%");
      expect(host.textContent).toContain("本任务价值");
      expect(host.textContent).toContain("≈ $12.30");
      expect(host.textContent).toContain("45%");
      act(() => host.querySelector("button")!.click());
      expect(onPress).toHaveBeenCalledOnce();
    },
  );
  it("labels legacy quota as account-only without attributing its plan to the task", () => {
    act(() =>
      root.render(
        <SessionUsageSummary
          session={session}
          usage={{
            ...usage,
            estimate: null,
            account: { ...usage.account!, accountOnly: true },
          }}
          contextUsage={null}
        />,
      ),
    );
    expect(host.textContent).toContain("gpt-5 · openai");
    expect(host.textContent).toContain(
      "ChatGPT 账号配额，未确认本任务使用此套餐",
    );
    expect(host.textContent).toContain("本任务用量");
    expect(host.textContent).not.toContain("本任务价值");
  });
  it("shows a mixed task breakdown without presenting estimated value as a charge", () => {
    act(() =>
      root.render(
        <SessionUsageSummary
          session={{ ...session, totalCostUsd: 2 }}
          usage={usage}
          contextUsage={null}
          detail
        />,
      ),
    );
    expect(host.textContent).toContain("实际费用$2.00");
    expect(host.textContent).toContain("估算价值≈ $12.30");
    expect(host.textContent).toContain("不代表实际扣款");
  });
  it("prefers live context counters over a previous detail query", () => {
    act(() =>
      root.render(
        <SessionUsageSummary
          session={session}
          usage={usage}
          contextUsage={{ totalTokens: 90, rawMaxTokens: 100 }}
        />,
      ),
    );
    expect(host.textContent).toContain("45%");
    expect(host.textContent).not.toContain("90%");
  });
  it.each([0, -1, NaN, Infinity, undefined])(
    "falls back from an uninitialized window (%s), then accepts live counters including zero",
    (contextWindow) => {
      const render = (task: RemoteSession, contextUsage: unknown) =>
        act(() =>
          root.render(
            <SessionUsageSummary
              session={task}
              usage={usage}
              contextUsage={contextUsage}
            />,
          ),
        );
      const task = { ...session, contextWindow };
      render(task, null);
      expect(host.textContent).toContain("暂未获取");
      render(task, { totalTokens: 90, rawMaxTokens: 0, maxTokens: 100 });
      expect(host.textContent).toContain("45%");
      for (const field of [
        "rawMaxTokens",
        "maxContextTokens",
        "contextWindow",
      ]) {
        render(task, { totalTokens: 90, [field]: 100 });
        expect(host.textContent).toContain("45%");
      }
      render(
        { ...task, contextTokens: 0, contextWindow: 200 },
        { totalTokens: 90, rawMaxTokens: 100 },
      );
      expect(host.textContent).toContain("上下文0%");
      expect(host.textContent).not.toContain("90%");
    },
  );
  it("keeps the overall exhausted weekly limit visible beside the model-specific limit", () => {
    const account = {
      ...usage.account!,
      source: "claude" as const,
      windows: [
        { id: "weekly", minutes: 10080, remainingPercent: 0, resetsAt: null },
        {
          id: "model-weekly",
          modelLabel: "Opus",
          minutes: 10080,
          remainingPercent: 80,
          resetsAt: null,
        },
      ],
    };
    act(() =>
      root.render(
        <SessionUsageSummary
          session={session}
          usage={{ ...usage, account }}
          contextUsage={null}
        />,
      ),
    );
    expect(host.textContent).toContain("剩余 0%");
    expect(host.textContent).toContain("剩余 80%");
  });
  it("keeps last-known quota visible with its observation time when offline", () => {
    act(() =>
      root.render(
        <SessionUsageSummary
          session={session}
          usage={{ ...usage, accountFailed: true }}
          contextUsage={null}
        />,
      ),
    );
    expect(host.textContent).toContain("剩余 72%");
    expect(host.textContent).toContain("上次更新");
  });
  it("hides quota for custom API routes and does not display missing data as zero", () => {
    const unavailable = {
      ...usage,
      account: { ...usage.account!, source: "api" as const, windows: [] },
      estimate: null,
      estimateFailed: true,
    };
    act(() =>
      root.render(
        <SessionUsageSummary
          session={session}
          usage={unavailable}
          contextUsage={null}
        />,
      ),
    );
    expect(host.textContent).not.toContain("账号配额");
    expect(host.textContent).not.toContain("$0.00");
    expect(host.textContent).toContain("暂未获取");
  });
});
