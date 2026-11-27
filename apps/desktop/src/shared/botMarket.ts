import type { CompanionImportResult } from '@cindy/maker-shared/companion-import';
import { modernLocaleOf, resolveSystemLocale } from './locale';

/** Same whitelist as the offline package compiler. */
export const BOT_CAPABILITY_ICONS = ['code', 'check', 'folder', 'file', 'target', 'list', 'layout', 'search', 'history',
  'chart', 'alert', 'layers', 'link', 'video'] as const;
export type BotCapabilityIcon = typeof BOT_CAPABILITY_ICONS[number];

export interface BotPackageIdentity { packageId: string; packageVersion: string; packageHash: string }
/** Package-authored opening: greeting material and the Skill run right after it. */
export interface BotPackageOpening {
  welcome: string; capabilities: string[]; onboardingSkill?: string;
  /** Starter choices parsed from the package's getting-started Skill; shown with the opening line. */
  starterOptions?: string[];
}
/** The line the companion actually opens with: the package welcome without its closing question,
 *  because the setup turn that follows asks the real question. */
export function botOpeningGreeting(welcome: string): string {
  const text = welcome.trim();
  return /^(.*[。.!！])\s*[^。.!！]*[?？]$/s.exec(text)?.[1] ?? text;
}
export interface BotMarketSkill { name: string; description: string }
export interface BotMarketReference { title: string; summary: string }
export interface BotMarketTool { id: string; purpose: string }
/** `cron` is the package's example expression; its timezone is deliberately dropped. */
export interface BotMarketRoutine { name: string; summary: string; cron?: string }
export type BotMarketLocale = 'en' | 'ja' | 'ko' | 'zh-TW' | 'es' | 'fr' | 'de' | 'pt-PT' | 'pt-BR';
/** Old packages remain valid; new authored translations are optional. */
export type BotMarketTranslations<T> = Record<'en' | 'ja' | 'ko' | 'zh-TW', T> & Partial<Record<BotMarketLocale, T>>;
/** The language-dependent fields of a catalog entry: the entry holds them in Simplified Chinese, `locales` in the others. */
export interface BotMarketCopy {
  name: string; description: string; welcome: string;
  /** Short authored pitch for the detail-page bubble (`presentation.bubbleZh` / `i18n.<lang>.bubble`). */
  bubble: string;
  capabilities: Array<{ icon: BotCapabilityIcon; label: string }>;
  skills: BotMarketSkill[];
  knowledge: BotMarketReference[];
  /** What the companion remembers about the user once the opening is confirmed. */
  remembers: string[];
  routines: BotMarketRoutine[]; tools: BotMarketTool[];
  /** Import entry id → name shown to the user, so a partial save can name what failed. */
  itemNames: Record<string, string>;
}
export interface BotMarketEntry extends BotPackageIdentity, BotMarketCopy {
  avatar: string; requiredInputs: string[];
  /** Authored copy per UI language; the base fields hold Simplified Chinese. */
  locales: BotMarketTranslations<BotMarketCopy>;
  installation?: CompanionImportResult;
}
/** UI language → package copy language: Traditional Chinese → zh-TW, other Chinese → zh-CN, unknown → en. */
export function botMarketLocale(language: string | undefined | null): 'zh-CN' | BotMarketLocale {
  return modernLocaleOf(resolveSystemLocale(language)) as 'zh-CN' | BotMarketLocale;
}
/** The entry as the given UI language should see it. */
export function localizedBotMarketEntry(entry: BotMarketEntry, language: string | undefined | null): BotMarketEntry {
  const locale = botMarketLocale(language);
  if (locale === 'zh-CN') return entry;
  return { ...entry, ...(entry.locales[locale] ?? entry.locales.en) };
}
export interface BotMarketApi {
  list(): Promise<BotMarketEntry[]>;
  invite(input: BotPackageIdentity & { locale?: string }): Promise<CompanionImportResult>;
  status(requestId: string): Promise<CompanionImportResult | undefined>;
}
