import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileTypeTile } from "@/components/FileTypeTile";
import { darkColors, lightColors } from "@/theme/tokens";

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock("react-native", () => ({ View: "div" }));
vi.mock("@/components/AppText", () => ({ Text: "span" }));
vi.mock("@/components/FileTypeIcon", () => ({ FileTypeIcon: () => null }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({
      colors: theme.dark ? tokens.darkColors : tokens.lightColors,
    }),
  };
});

describe("file tile format label", () => {
  it.each([false, true])("uses high-contrast text in dark=%s", (dark) => {
    theme.dark = dark;
    const colors = dark ? darkColors : lightColors;
    const html = renderToStaticMarkup(<FileTypeTile name="report.pdf" />);
    expect(html).toContain(`color:${colors.textPrimary}`);
    expect(html).toContain("font-size:11px");
    expect(html).toContain(">PDF</span>");
  });
});
