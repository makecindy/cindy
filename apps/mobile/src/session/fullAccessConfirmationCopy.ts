/**
 * Full access 确认弹窗的多语文案。
 *
 * 正本在 i18n locale JSON(`interaction.permission.fullAccessConfirm.*`),与权限选择器
 * `interaction.permission.mode.bypass` 同名(zh「完全访问」/ ja「フルアクセス」/ ko「전체 접근」),
 * 因此根门禁 check-i18n-glossary.mjs 可直接扫到。本模块只把各语言 JSON 投影成按语言取值的
 * 对象,保留原导出形态:确认弹窗在 Alert 调用时按「手动语言优先、否则系统语言」取值,
 * 不依赖 i18next 当前语言；本模块不加载 react-native，测试可直接读取。
 *
 * 影子 catalog 门禁 src/__tests__/shadowCatalogGlossary.test.ts 仍覆盖这份投影。
 */
import esInteraction from "@/i18n/locales/es/interaction.json";
import frInteraction from "@/i18n/locales/fr/interaction.json";
import deInteraction from "@/i18n/locales/de/interaction.json";
import ptPTInteraction from "@/i18n/locales/pt-PT/interaction.json";
import ptBRInteraction from "@/i18n/locales/pt-BR/interaction.json";
import type { SupportedLocale } from "@/i18n/locale";
import { BRAND_NAME } from "@cindy/maker-shared/branding";

import enInteraction from "@/i18n/locales/en/interaction.json";
import jaInteraction from "@/i18n/locales/ja/interaction.json";
import koInteraction from "@/i18n/locales/ko/interaction.json";
import zhCNInteraction from "@/i18n/locales/zh-CN/interaction.json";
import zhTWInteraction from "@/i18n/locales/zh-TW/interaction.json";
import lzhInteraction from "@/i18n/locales/zh-Hant-x-lzh/interaction.json";
import lzhHansInteraction from "@/i18n/locales/zh-Hans-x-lzh/interaction.json";

export type FullAccessConfirmationCopy = Readonly<{
  title: string;
  description: string;
  confirm: string;
  cancel: string;
}>;

type FullAccessConfirmationSource = { permission: { fullAccessConfirm: FullAccessConfirmationCopy } };

/** locale JSON 里的 {{appName}} 由 i18next defaultVariables 注入;这里不经 i18next,手动替换。 */
function project(source: FullAccessConfirmationSource): FullAccessConfirmationCopy {
  const copy = source.permission.fullAccessConfirm;
  const fill = (value: string) => value.replace(/\{\{appName\}\}/g, BRAND_NAME);
  return {
    title: fill(copy.title),
    description: fill(copy.description),
    confirm: fill(copy.confirm),
    cancel: fill(copy.cancel),
  };
}

export const FULL_ACCESS_CONFIRMATION_COPY: Record<
  SupportedLocale,
  FullAccessConfirmationCopy
> = {
  "es": project(esInteraction),
  "fr": project(frInteraction),
  "de": project(deInteraction),
  "pt-PT": project(ptPTInteraction),
  "pt-BR": project(ptBRInteraction),
  en: project(enInteraction),
  ja: project(jaInteraction),
  ko: project(koInteraction),
  "zh-CN": project(zhCNInteraction),
  "zh-TW": project(zhTWInteraction),
  "zh-Hant-x-lzh": project(lzhInteraction),
  "zh-Hans-x-lzh": project(lzhHansInteraction),
};
