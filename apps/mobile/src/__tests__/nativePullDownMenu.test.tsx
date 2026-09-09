import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it, vi } from "vitest";
import { NativePullDownMenu } from "@/platform/chrome/NativePullDownMenu";
import { palettes } from "@/theme/tokens";

const native = vi.hoisted(() => ({
  mode: "light" as "light" | "dark",
  actions: [] as MenuAction[],
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {},
  UIManager: { getViewManagerConfig: () => ({}) },
}));
vi.mock("@/theme", async () => {
  const { palettes } = await import("@/theme/tokens");
  return { useTheme: () => ({ colors: palettes[native.mode] }) };
});
vi.mock("@react-native-menu/menu", () => ({
  MenuView: ({ actions }: { actions: MenuAction[] }) => {
    native.actions = actions;
    return null;
  },
}));

describe("native menu symbol colors", () => {
  it.each(["light", "dark"] as const)(
    "supplies visible colors to Fabric in %s mode",
    (mode) => {
      native.mode = mode;
      renderToStaticMarkup(
        createElement(NativePullDownMenu, {
          actions: [
            { id: "copy", title: "Copy", image: "link" },
            {
              id: "delete",
              title: "Delete",
              image: "trash",
              destructive: true,
              disabled: true,
            },
            {
              id: "more",
              title: "More",
              subactions: [
                {
                  id: "rewind",
                  title: "Rewind",
                  image: "arrow.uturn.backward",
                },
              ],
            },
          ],
          children: null,
          onAction: vi.fn(),
        }),
      );
      expect(native.actions[0]).toMatchObject({
        image: "link",
        imageColor: palettes[mode].textPrimary,
      });
      expect(native.actions[1]).toMatchObject({
        image: "trash",
        imageColor: palettes[mode].destructive,
        attributes: { destructive: true, disabled: true },
      });
      expect(native.actions[2].subactions?.[0]).toMatchObject({
        image: "arrow.uturn.backward",
        imageColor: palettes[mode].textPrimary,
      });
    },
  );
});
