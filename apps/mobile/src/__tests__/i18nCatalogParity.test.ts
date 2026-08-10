/**
 * i18next catalog 平价门:5 个 locale 的组装后 catalog(locales/<locale>/index.ts)
 * key 结构必须完全一致,叶子非空,{{占位符}} 集合逐 key 一致。
 * 与根 scripts/check-i18n.mjs(desktop 专用)对应的 mobile 侧强制门,
 * 随 pnpm test:unit 阻断。直接从组装模块取数,新增区域文件自动纳入校验。
 */

import { describe, expect, it } from "vitest";

import enCommon from "@/i18n/locales/en";
import zhCNCommon from "@/i18n/locales/zh-CN";
import jaCommon from "@/i18n/locales/ja";
import koCommon from "@/i18n/locales/ko";
import zhTWCommon from "@/i18n/locales/zh-TW";

const CATALOGS: Record<string, unknown> = {
  en: enCommon,
  "zh-CN": zhCNCommon,
  ja: jaCommon,
  ko: koCommon,
  "zh-TW": zhTWCommon,
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
  const locales = Object.keys(CATALOGS);
  const flat = new Map(locales.map((locale) => [locale, flatCatalog(locale)]));
  const enKeys = [...flat.get("en")!.keys()].sort();

  it.each(locales)("%s 与 en 的 key 全集一致", (locale) => {
    expect([...flat.get(locale)!.keys()].sort()).toEqual(enKeys);
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
        placeholdersOf(en.get(key)!),
      );
    }
  });
});
