/**
 * Full access 确认弹窗的多语文案。
 *
 * 正本在 i18n locale JSON(`interaction.permission.fullAccessConfirm.*`),与权限选择器
 * `interaction.permission.mode.bypass` 同名(zh「完全访问」/ ja「フルアクセス」/ ko「전체 접근」),
 * 因此根门禁 check-i18n-glossary.mjs 可直接扫到。本模块只把五语 JSON 投影成按语言取值的
 * 对象,保留原导出形态:确认弹窗在 Alert 调用时按「手动语言优先、否则系统语言」取值,
 * 不依赖 i18next 当前语言;且本模块不 import react-native,测试可直接 import。
 *
 * 影子 catalog 门禁 src/__tests__/shadowCatalogGlossary.test.ts 仍覆盖这份投影。
 */
import { BRAND_NAME } from "@cindy/maker-shared/branding";

import enInteraction from "@/i18n/locales/en/interaction.json";
import jaInteraction from "@/i18n/locales/ja/interaction.json";
import koInteraction from "@/i18n/locales/ko/interaction.json";
import zhCNInteraction from "@/i18n/locales/zh-CN/interaction.json";
import zhTWInteraction from "@/i18n/locales/zh-TW/interaction.json";

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
  "en" | "ja" | "ko" | "zh-CN" | "zh-TW",
  FullAccessConfirmationCopy
> = {
  en: project(enInteraction),
  ja: project(jaInteraction),
  ko: project(koInteraction),
  "zh-CN": project(zhCNInteraction),
  "zh-TW": project(zhTWInteraction),
};
