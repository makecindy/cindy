// Cross-platform wire validation: do not rely on Intl.Segmenter, absent in Hermes.
import { expect, it } from "vitest";
import {
  validProjectIcon,
  projectDirectoryName,
  defaultProjectLetters,
  defaultProjectColor,
  PROJECT_EMOJIS,
  isProjectImageDraft,
} from "../projectIcons";
it.each([
  ...PROJECT_EMOJIS,
  "👩🏽‍💻",
  "👨‍👩‍👧‍👦",
  "🇳🇿",
  "1️⃣",
  "text:中A",
  "text:42",
  "text:CY:blue",
  "text:中A:white",
  "text:C:default",
  "symbol:Rocket",
  "symbol:Rocket:blue",
  "symbol:Rocket:yellow",
  "symbol:Rocket:gray",
  "symbol:Rocket:coral",
  "symbol:Rocket:indigo",
  "symbol:Rocket:white",
  "symbol:Code:default",
  `cindy-media://blobs/${"a".repeat(64)}.png`,
])("accepts supported icon %s", (icon) => {
  expect(validProjectIcon(icon)).toBe(true);
});
it.each([
  "",
  "hello",
  "a🚀",
  "🚀🚀",
  "🇳",
  "text:ABC",
  "text:<",
  "text:ABC:blue",
  "text:C:#fff",
  "text:C:blue:extra",
  "text:C:",
  "text::blue",
  "symbol:Missing",
  "symbol:Rocket:#fff",
  "symbol:Rocket:blue:extra",
  "symbol:Rocket:",
  "symbol:Missing:blue",
  "file:///private",
  "https://example.com/avatar.png",
  "data:image/png;base64,AAAA",
])("rejects non-icon content %s", (icon) => {
  expect(validProjectIcon(icon)).toBe(false);
});
it("keeps binary drafts transient and bounded", () => {
  expect(isProjectImageDraft("data:image/png;base64,AAAA")).toBe(true);
  expect(isProjectImageDraft("data:image/svg+xml;base64,AAAA")).toBe(false);
  expect(
    isProjectImageDraft(`data:image/png;base64,${"A".repeat(300000)}`),
  ).toBe(false);
});

// A generated picker default must fit the existing two-character wire contract on both clients.
it.each([
  ["Cindy", "C"],
  ["cindy-demo", "CD"],
  ["MyProject", "MP"],
  ["My Really Cool Project", "MP"],
  ["项目设置", "项目"],
  ["🚀 orbit-garden", "OG"],
  ["Étoile", "É"],
  ["ß", "SS"],
  ["123", "1"],
  ["  🎨 —  ", "P"],
])("derives editable initials for %s", (name, expected) => {
  const letters = defaultProjectLetters(name);
  expect(letters).toBe(expected);
  expect(validProjectIcon(`text:${letters}`)).toBe(true);
});

// User-requested automatic identity color: normalization must not change a project's color.
// Existing tests cover initials/wire validation only; unit minimum: "Cindy" vs full-width/case/space.
it("keeps automatic project colors stable across normalized names", () => {
  expect(defaultProjectColor("  ＣＩＮＤＹ  ")).toBe(
    defaultProjectColor("cindy"),
  );
  expect(defaultProjectColor("Cindy")).not.toBe("default");
  expect(defaultProjectColor("Cindy")).not.toBe("white");
  expect(defaultProjectColor("a")).not.toBe(defaultProjectColor("b"));
});

// CodeQL #503: replace the suffix regexp while preserving cross-platform labels.
// Unit: existing icon/wire cases never called directory-name extraction.
it.each([
  ["/repo/project///", "project"],
  ["C:\\repo\\project\\", "project"],
  ["//server/share/project/", "project"],
  ["project", "project"],
  ["/", "/"],
  ["", ""],
  [`project${"/".repeat(4096)}`, "project"],
])(
  "extracts a directory label without suffix-regexp backtracking: %s",
  (directory, expected) => {
    expect(projectDirectoryName(directory)).toBe(expected);
  },
);
