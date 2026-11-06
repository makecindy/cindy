import { describe, expect, it } from "vitest";
import { parsePluginReadme, pluginReadmeImageSources } from "@/plugins/pluginReadme";
import { buildSelectableMarkdownHtml } from "@/session/selectableMarkdownHtml";

// Plugin detailed introduction: only package images the Host returned may render on the phone;
// external, escaping or unreturned images stay text placeholders (no network loads).
describe("plugin detailed introduction", () => {
  it("renders only Host-provided package images", () => {
    const content = parsePluginReadme({
      path: "docs/README.md",
      markdown: [
        "![shot](shot.png)",
        "![remote](https://example.com/track.png)",
        "![escape](../../outside.png)",
        "![missing](missing.png)",
        "![ref][ref-shot]",
        "[ref-shot]: ref.png",
      ].join("\n\n"),
      images: {
        "docs/shot.png": "data:image/png;base64,AAAA",
        "docs/ref.png": "data:image/png;base64,BBBB",
        "docs/missing.png": "https://example.com/not-a-data-url.png",
      },
    })!;
    const sources = pluginReadmeImageSources(content);
    // Reference-style images are rewritten inline so lookup and rendering see the same text.
    expect([...sources.keys()]).toEqual(["shot.png", "ref.png"]);
    const html = buildSelectableMarkdownHtml(content.markdown, { imageSources: sources });
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain('<img src="data:image/png;base64,BBBB"');
    expect(html).not.toMatch(/<img[^>]+example\.com/);
  });

  it("treats a missing introduction as empty and malformed replies as failures", () => {
    expect(parsePluginReadme(null)).toBeNull();
    for (const value of [undefined, {}, { path: "README.md", markdown: "x", images: [] }])
      expect(() => parsePluginReadme(value)).toThrow();
  });
});
