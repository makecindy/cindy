import type { VisibleSettingsTab } from '@/lib/tabLabels';
import type { ImBotIdentity } from './imBotVisibility';

export interface SettingsSearchContext extends ImBotIdentity {
  platform: string;
  supportsBetaUpdateChannel?: boolean;
}

export interface SettingsSearchEntry {
  id: string;
  tab: VisibleSettingsTab;
  targetId: string;
  /** Parent section when an optional setting is not mounted yet. */
  fallbackTargetId?: string;
  titleKey: string;
  sectionKey: string;
  descriptionKey?: string;
  /** Platform-dependent values required by translated titles and descriptions. */
  textValues?: (context?: SettingsSearchContext) => Record<string, string>;
  keywordKeys?: readonly string[];
  /** Options are rendered by the page and indexed even before that page mounts. */
  options?: readonly { value: string; labelKey: string; descriptionKey?: string }[];
  aliases?: readonly string[];
  isVisible?: (context: SettingsSearchContext) => boolean;
}

/** Preserve literal ids/option values while checking every page-owned definition. */
export function defineSettings<const T extends Record<string, SettingsSearchEntry>>(definitions: T): T {
  return definitions;
}

export interface SettingsSearchModule {
  id: string;
  order: number;
  entries: readonly SettingsSearchEntry[];
}
