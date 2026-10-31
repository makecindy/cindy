/**
 * i18next catalog 平价门:全部 locale 的组装后 catalog(locales/<locale>/index.ts)
 * key 结构必须完全一致,叶子非空,{{占位符}} 集合逐 key 一致。
 * 与根 scripts/check-i18n.mjs(desktop 专用)对应的 mobile 侧强制门,
 * 随 pnpm test:unit 阻断。直接从组装模块取数,新增区域文件自动纳入校验。
 */

import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";

import esCommon from "@/i18n/locales/es";
import frCommon from "@/i18n/locales/fr";
import deCommon from "@/i18n/locales/de";
import ptPTCommon from "@/i18n/locales/pt-PT";
import ptBRCommon from "@/i18n/locales/pt-BR";
import enCommon from "@/i18n/locales/en";
import zhCNCommon from "@/i18n/locales/zh-CN";
import jaCommon from "@/i18n/locales/ja";
import koCommon from "@/i18n/locales/ko";
import zhTWCommon from "@/i18n/locales/zh-TW";
import lzhHantCommon from "@/i18n/locales/zh-Hant-x-lzh";
import lzhHansCommon from "@/i18n/locales/zh-Hans-x-lzh";
import { SUPPORTED_LOCALES } from "@/i18n/locale";

const CATALOGS: Record<string, unknown> = {
  en: enCommon,
  es: esCommon,
  fr: frCommon,
  de: deCommon,
  "pt-PT": ptPTCommon,
  "pt-BR": ptBRCommon,
  "zh-CN": zhCNCommon,
  ja: jaCommon,
  ko: koCommon,
  "zh-TW": zhTWCommon,
  "zh-Hant-x-lzh": lzhHantCommon,
  "zh-Hans-x-lzh": lzhHansCommon,
};

/** 展平嵌套 catalog 为 dot-path → 叶子字符串。遇到非 string 叶子直接失败。 */
function flatten(
  node: unknown,
  prefix: string,
  out: Map<string, string>,
): void {
  expect(node, `${prefix || "<root>"} 必须是对象或字符串`).toBeTruthy();
  if (typeof node === "string") {
    out.set(prefix, node);
    return;
  }
  expect(typeof node, `${prefix || "<root>"} 类型异常`).toBe("object");
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

function flatCatalog(locale: string): Map<string, string> {
  const out = new Map<string, string>();
  flatten(CATALOGS[locale], "", out);
  return out;
}

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

describe("mobile i18n catalog parity", () => {
  it("checks every supported locale", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  const locales = Object.keys(CATALOGS);
  const flat = new Map(locales.map((locale) => [locale, flatCatalog(locale)]));
  const enKeys = [...flat.get("en")!.keys()].sort();

  it.each(locales)(
    "%s resolves browser action labels at their UI paths",
    async (locale) => {
      const instance = createInstance();
      await instance.init({
        lng: locale,
        fallbackLng: false,
        resources: { [locale]: { translation: CATALOGS[locale] as object } },
      });
      for (const action of [
        "browserBack",
        "browserForward",
        "browserMore",
        "browserShowSource",
        "browserShowPage",
        "browserAddToTask",
        "browserFileInfo",
      ]) {
        const key = `files.preview.${action}`;
        expect(instance.exists(key), `${locale}:${key}`).toBe(true);
        expect(instance.t(key)).not.toBe(key);
      }
    },
  );

  // #8142: CLDR requires language-specific plural categories (e.g. fr/es/pt many).
  // Compare the same semantic keys and require every category, rather than rejecting valid forms.
  const pluralSuffix = /_(zero|one|two|few|many|other)$/;
  const families = new Set(enKeys.filter((key) => key.endsWith("_one") && flat.get("en")!.has(key.replace(/_one$/, "_other"))).map((key) => key.replace(/_one$/, "")));
  const canonicalKey = (key: string) => families.has(key.replace(pluralSuffix, "")) ? key.replace(pluralSuffix, "") : key;
  it.each(locales)("%s 与 en 的 key 全集及本语言复数类别一致", (locale) => {
    const keys = flat.get(locale)!;
    expect([...new Set([...keys.keys()].map(canonicalKey))].sort()).toEqual([...new Set(enKeys.map(canonicalKey))].sort());
    for (const family of families) {
      for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        expect(keys.has(`${family}_${category}`), `${locale}:${family}_${category}`).toBe(true);
      }
    }
  });

  it.each(locales)("%s 所有叶子非空且不是待翻译占位", (locale) => {
    for (const [key, value] of flat.get(locale)!) {
      expect(value.trim(), `${locale}:${key} 不能为空`).not.toBe("");
      expect(value, `${locale}:${key} 不能残留 TODO 占位`).not.toMatch(
        /TODO|待翻译|待校对/,
      );
    }
  });

  it.each(locales)("%s 的 {{占位符}} 集合与 en 逐 key 一致", (locale) => {
    const en = flat.get("en")!;
    for (const [key, value] of flat.get(locale)!) {
      expect(placeholdersOf(value), `${locale}:${key} 占位符不一致`).toEqual(
        placeholdersOf(en.get(key) ?? en.get(`${canonicalKey(key)}_other`)!),
      );
    }
  });
});
