import type { VisibleSettingsTab } from '@/lib/tabLabels';
import type { ImBotIdentity } from './imBotVisibility';

export interface SettingsSearchContext extends ImBotIdentity {
  platform: string;
  /** Stored language choice, including system; matches LanguageSection mounting. */
  locale?: string;
  supportsBetaUpdateChannel?: boolean;
  /** Loaded service selectors only; never index user endpoints, models, or credentials. */
  voiceInput?: { serviceMode: 'cindy' | 'byok'; asrProvider: string };
  voiceRefinementEnabled?: boolean;
  /** Capability and profile presence only; never include voiceprint data. */
  speakerFilter?: { supported: boolean; enrolled: boolean };
  agentIsland?: {
    supported: boolean; enabled: boolean; soundEnabled?: boolean; liveActivitySupported?: boolean; liveActivity?: boolean;
  };
  /** Selector visibility only; never expose the user's custom media URL to search. */
  wallpaperMotionAvailable?: boolean;
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
  /** Use the description actually shown for this context; undefined keeps the default. */
  descriptionKeyForContext?: (context: SettingsSearchContext) => string | undefined;
  /** Platform-dependent values required by translated titles and descriptions. */
  textValues?: (context?: SettingsSearchContext) => Record<string, string>;
  keywordKeys?: readonly string[];
  /** Options are rendered by the page and indexed even before that page mounts. */
  options?: readonly {
    value: string;
    labelKey: string;
    descriptionKey?: string;
    /** Exclude options hidden by the page's account or platform context. */
    isVisible?: (context: SettingsSearchContext) => boolean;
  }[];
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
