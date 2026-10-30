import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { FileTypeTile } from "@/components/FileTypeTile";
import { darkColors, iconSize, iconStroke, lightColors } from "@/theme/tokens";

const theme = vi.hoisted(() => ({ dark: false }));
const glyphProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("react-native", () => ({ View: "div" }));
vi.mock("@/components/AppText", () => ({ Text: "span" }));
vi.mock("lucide-react-native", () => {
  const Glyph = (props: Record<string, unknown>) => {
    glyphProps.push(props);
    return null;
  };
  return {
    Database: Glyph,
    File: Glyph,
    FileArchive: Glyph,
    FileAudio: Glyph,
    FileChartColumn: Glyph,
    FileCode: Glyph,
    FileImage: Glyph,
    FileSpreadsheet: Glyph,
    FileText: Glyph,
    FileVideo: Glyph,
  };
});
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({
      colors: theme.dark ? tokens.darkColors : tokens.lightColors,
    }),
  };
});

function renderGlyph(node: Parameters<typeof renderToStaticMarkup>[0]) {
  glyphProps.length = 0;
  const html = renderToStaticMarkup(node);
  expect(glyphProps).toHaveLength(1);
  return { html, glyph: glyphProps[0]! };
}

describe("file tile format label", () => {
  it.each([false, true])("uses high-contrast text in dark=%s", (dark) => {
    theme.dark = dark;
    const colors = dark ? darkColors : lightColors;
    const { html } = renderGlyph(<FileTypeTile name="report.pdf" />);
    expect(html).toContain(`color:${colors.textPrimary}`);
    expect(html).toContain("font-size:11px");
    expect(html).toContain(">PDF</span>");
  });
});

describe("file tile glyph stroke", () => {
  it.each([false, true])(
    "keeps the large glyph on the folder's thin absolute stroke in dark=%s",
    (dark) => {
      theme.dark = dark;
      const colors = dark ? darkColors : lightColors;
      const { glyph } = renderGlyph(
        <FileTypeTile name="apply-personal-v5.command" />,
      );
      expect(glyph).toMatchObject({
        size: iconSize.glyph,
        color: colors.borderStrong,
        strokeWidth: iconStroke.thin,
        absoluteStrokeWidth: true,
      });
    },
  );
});

describe("compact file type icon", () => {
  it("defaults to the regular stroke without absolute scaling", () => {
    theme.dark = false;
    const { glyph } = renderGlyph(<FileTypeIcon name="notes.md" />);
    expect(glyph.strokeWidth).toBe(iconStroke.regular);
    expect(glyph.absoluteStrokeWidth).toBeUndefined();
  });

  it("honors a caller-provided stroke", () => {
    theme.dark = false;
    const { glyph } = renderGlyph(
      <FileTypeIcon
        name="notes.md"
        strokeWidth={iconStroke.thin}
        absoluteStrokeWidth
      />,
    );
    expect(glyph).toMatchObject({
      strokeWidth: iconStroke.thin,
      absoluteStrokeWidth: true,
    });
  });
});
