import type { VisibleSettingsTab } from '@/lib/tabLabels';
import type { ImBotIdentity } from './imBotVisibility';

export interface SettingsSearchContext extends ImBotIdentity {
  platform: string;
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
  keywordKeys?: readonly string[];
  aliases?: readonly string[];
  isVisible?: (context: SettingsSearchContext) => boolean;
}

export interface SettingsSearchModule {
  id: string;
  order: number;
  entries: readonly SettingsSearchEntry[];
}
