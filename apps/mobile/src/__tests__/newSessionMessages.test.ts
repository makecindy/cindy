import { describe, expect, it, vi } from "vitest";

const mockLanguageTag = { current: "en-US" };
vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: mockLanguageTag.current }],
}));

import {
  newSessionMessages,
  newSessionText,
  resolveNewSessionLocale,
  type NewSessionLocale,
} from "@/session/newSessionMessages";

const LOCALES: NewSessionLocale[] = ["zh-CN", "zh-TW", "en", "ja", "ko"];

describe("newSessionMessages", () => {
  it("keeps the 5 locale catalogs key-aligned and non-empty", () => {
    const baseKeys = Object.keys(newSessionMessages["zh-CN"]).sort();
    expect(Object.keys(newSessionMessages).sort()).toEqual([...LOCALES].sort());

    for (const locale of LOCALES) {
      const catalog = newSessionMessages[locale];
      expect(Object.keys(catalog).sort(), `locale=${locale}`).toEqual(baseKeys);
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `locale=${locale} key=${key}`).not.toBe("");
      }
    }
  });

  it("maps supported system languages and falls back to English", () => {
    expect(resolveNewSessionLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveNewSessionLocale("ja-JP")).toBe("ja");
    expect(resolveNewSessionLocale("ko-KR")).toBe("ko");
    expect(resolveNewSessionLocale("fr-FR")).toBe("en");
  });

  it("renders the current system language through the catalog", () => {
    mockLanguageTag.current = "ja-JP";
    expect(newSessionText("showHiddenDirectories")).toBe("隠しフォルダを表示");

    mockLanguageTag.current = "en-US";
    expect(newSessionText("emptyDirectory")).toBe("No folders to show.");
  });
});
