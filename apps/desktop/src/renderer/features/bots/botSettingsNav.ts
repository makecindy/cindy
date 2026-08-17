/**
 * Left-nav (top-tab-row on narrow viewports) metadata for the Bot settings
 * page. Kept out of BotsHomeView so the tab-id parsing / deep-link fallback
 * logic is unit-testable without mounting the settings component tree.
 *
 * Batch B redesign (DESIGN spec §D): the previously single long-scroll
 * settings page is reorganized into seven groups. Order here is the
 * canonical nav order — "identity" (Basic info) is first and is the
 * fallback for a missing/unknown `?tab=` value.
 */
import {
  BellRing,
  Clock3,
  FolderGit2,
  MessageCircleMore,
  Settings2,
  Sparkles,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export const BOT_SETTINGS_TAB_IDS = [
  'identity',
  'channels',
  'capabilities',
  'automation',
  'notifications',
  'projects',
  'advanced',
] as const;

export type BotSettingsTabId = (typeof BOT_SETTINGS_TAB_IDS)[number];

/** Basic info is the first group and the landing tab for `?settings=1` alone. */
export const DEFAULT_BOT_SETTINGS_TAB: BotSettingsTabId = 'identity';

export function isBotSettingsTab(value: string | null | undefined): value is BotSettingsTabId {
  return typeof value === 'string' && (BOT_SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/** Missing or unrecognized `tab` query values fall back to Basic info — never a blank panel. */
export function parseBotSettingsTab(value: string | null | undefined): BotSettingsTabId {
  return isBotSettingsTab(value) ? value : DEFAULT_BOT_SETTINGS_TAB;
}

export interface BotSettingsTabMeta {
  id: BotSettingsTabId;
  labelKey: string;
  icon: LucideIcon;
}

export const BOT_SETTINGS_TABS: BotSettingsTabMeta[] = [
  { id: 'identity', labelKey: 'bots.settingsNav.identity', icon: UserRound },
  { id: 'channels', labelKey: 'bots.settingsNav.channels', icon: MessageCircleMore },
  { id: 'capabilities', labelKey: 'bots.settingsNav.capabilities', icon: Sparkles },
  { id: 'automation', labelKey: 'bots.settingsNav.automation', icon: Clock3 },
  { id: 'notifications', labelKey: 'bots.settingsNav.notifications', icon: BellRing },
  { id: 'projects', labelKey: 'bots.settingsNav.projects', icon: FolderGit2 },
  { id: 'advanced', labelKey: 'bots.settingsNav.advanced', icon: Settings2 },
];
