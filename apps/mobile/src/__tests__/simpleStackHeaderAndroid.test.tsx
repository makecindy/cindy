import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  os: "android" as "android" | "ios",
  screenHeader: [] as Record<string, unknown>[],
  stackOptions: [] as Record<string, unknown>[],
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return captured.os;
    },
  },
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: "div",
}));
vi.mock("expo-router", () => {
  const Toolbar = Object.assign(() => null, { Button: () => null });
  return {
    Stack: {
      Screen: ({ options }: { options: Record<string, unknown> }) => {
        captured.stackOptions.push(options);
        return null;
      },
      Toolbar,
    },
  };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/QuietSyncIndicator", () => ({ QuietSyncIndicator: () => null }));
vi.mock("@/components/AppText", () => ({ Text: "span" }));
vi.mock("@/components/MobilePrimitives", () => ({
  MainWindowActionButton: () => null,
  ScreenBackButton: () => null,
  ScreenHeader: (props: Record<string, unknown>) => {
    captured.screenHeader.push(props);
    return null;
  },
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (make: (colors: unknown) => unknown) => make(tokens.lightColors),
  };
});

import { SimpleStackHeader } from "@/platform/chrome/SimpleStackHeader";

describe("SimpleStackHeader follows the iOS single-line title on Android", () => {
  beforeEach(() => {
    captured.screenHeader = [];
    captured.stackOptions = [];
  });

  it("drops eyebrow and subtitle from the Android ScreenHeader", () => {
    captured.os = "android";
    const onBack = vi.fn();
    renderToStaticMarkup(
      createElement(SimpleStackHeader, {
        backTestID: "deviceDetail.backButton",
        eyebrow: "Remote Device",
        onBack,
        subtitle: "3 active",
        syncing: true,
        title: "My Mac",
        titleTestID: "deviceDetail.title",
      }),
    );
    expect(captured.stackOptions).toHaveLength(0);
    expect(captured.screenHeader).toHaveLength(1);
    const props = captured.screenHeader[0];
    expect(props).toMatchObject({
      backTestID: "deviceDetail.backButton",
      onBack,
      syncing: true,
      title: "My Mac",
      titleTestID: "deviceDetail.title",
    });
    expect(props.eyebrow).toBeUndefined();
    expect(props.subtitle).toBeUndefined();
  });

  it("keeps iOS on the system navigation bar", () => {
    captured.os = "ios";
    renderToStaticMarkup(
      createElement(SimpleStackHeader, { subtitle: "ignored", title: "Settings" }),
    );
    expect(captured.screenHeader).toHaveLength(0);
    expect(captured.stackOptions[0]).toMatchObject({ headerShown: true });
  });
});
