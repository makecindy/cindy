/**
 * macOS menu bar quota panel: settings and the view model main sends to the native helper.
 *
 * Main owns every product decision and sentence (it reads usage, applies the user's
 * order/visibility and localizes). The Swift helper only renders, animates and formats the
 * few values that change while the panel stays open (relative "updated" time, a running
 * task's clock, chart scrub readouts).
 */

export const MENUBAR_STATUS_TEXT_MODES = ['icon', 'lowest', 'today', 'task'] as const;
export type MenubarStatusTextMode = (typeof MENUBAR_STATUS_TEXT_MODES)[number];

export const MENUBAR_USAGE_SCOPES = ['local', 'all'] as const;
export type MenubarUsageScope = (typeof MENUBAR_USAGE_SCOPES)[number];

/** Effective menu bar settings. Persisted as overrides only; absent keys use the defaults. */
export interface MenubarSettings {
  enabled: boolean;
  /** Source ids in the user's order. Unknown ids are kept so a reconnect restores the slot. */
  order: string[];
  /** Source ids the user turned off. Pay-as-you-go connections start hidden. */
  hidden: string[];
  /** Source ids the user turned back on after being hidden by default. */
  shown: string[];
  statusText: MenubarStatusTextMode;
  lowAlert: boolean;
  privacy: boolean;
  scope: MenubarUsageScope;
}

export const DEFAULT_MENUBAR_SETTINGS: MenubarSettings = {
  enabled: true,
  order: [],
  hidden: [],
  shown: [],
  statusText: 'icon',
  lowAlert: true,
  privacy: false,
  scope: 'all',
};

export type MenubarSettingsPatch = Partial<MenubarSettings>;

/** Semantic colors. The helper maps them to dynamic NSColors for Light and Dark. */
export type MenubarColor =
  | 'ink'
  | 'ink2'
  | 'ink3'
  | 'fill'
  | 'warn'
  | 'error'
  | 'claude'
  | 'claude2'
  | 'claude3'
  | 'codex'
  | 'pi';

export type MenubarLevel = 'normal' | 'warn' | 'error';

export type MenubarSourceKind = 'subscription' | 'balance' | 'payg';

export interface MenubarSourceCell {
  id: string;
  kind: MenubarSourceKind;
  /** Complete monochrome SVG, rendered as a template image. */
  logoSvg: string;
  /** Account or brand label under the tube (already masked in privacy mode). */
  name: string;
  /** Number above the tube; null shows `valueLabel` instead (credits, pay-as-you-go). */
  value: string | null;
  valueUnit: string | null;
  valueLabel: string | null;
  level: MenubarLevel;
  /** Liquid height 0...1; null draws the dashed empty tube for pay-as-you-go. */
  fill: number | null;
  /** Diagonal hatch: the window is used up but extra credits keep the account working. */
  reserve: boolean;
  /** Outline the tube: the source with the most room left. */
  emphasized: boolean;
  /** A running task on this computer is drawing on this source; its liquid ripples. */
  active: boolean;
  when: string;
  whenLevel: MenubarLevel;
  accessibilityLabel: string;
}

export interface MenubarRing {
  /** 0...1 remaining. */
  fraction: number;
  color: MenubarColor;
}

export interface MenubarFact {
  label: string;
  value: string;
  sub: string;
}

export type MenubarDetailAction =
  | { kind: 'new-task'; providerId: string }
  | { kind: 'open-billing' }
  | { kind: 'open-settings' }
  | { kind: 'open-app' }
  | { kind: 'none' };

export interface MenubarDetail {
  id: string;
  logoSvg: string;
  title: string;
  plan: string;
  rings: MenubarRing[];
  bigValue: string;
  bigUnit: string | null;
  bigColor: MenubarColor | null;
  /** Smaller numerals for multi-ring and balance details. */
  bigCompact: boolean;
  bigCaption: string;
  legend: { label: string; color: MenubarColor }[];
  sayPrimary: string;
  saySecondary: string | null;
  facts: MenubarFact[];
  actionLabel: string;
  action: MenubarDetailAction;
}

export interface MenubarTask {
  sessionId: string;
  title: string;
  harness: 'claude-code' | 'codex' | 'pi' | 'zcode';
  logoSvg: string;
  /** Estimated value today, in the ledger currency. */
  value: number;
  tokens: number;
  running: boolean;
  /** Present while running; the helper ticks the clock. */
  startedAtMs: number | null;
  /** Shown instead of the clock when not running ("5 分钟前"). */
  idleStatus: string;
  /** "GPT-6 Astra · 299M · 上下文 85%"; the helper prefixes the status. */
  meta: string;
}

export interface MenubarModelUsage {
  name: string;
  harness: 'claude-code' | 'codex' | 'pi' | 'zcode';
  money: number;
  tokens: number;
}

/** Live task/companion projection, independent of today's local usage ranking. */
export interface MenubarActivity {
  sessionId: string;
  title: string;
  logoSvg: string;
  companion: boolean;
  attention: boolean;
  phase: 'running' | 'needs-interaction' | 'completed' | 'error';
  preview: string;
  status: string;
  startedAtMs: number | null;
  lastActivityAtMs: number;
}

export interface MenubarUsageScopeData {
  /** One entry per day, oldest first, aligned with `MenubarUsage.days`. */
  daily: {
    /** Subscription-equivalent value by harness: claude-code, codex, pi. */
    money: [number, number, number];
    /** Actually paid (API) part of `money`, summed across harnesses. */
    paid: number;
    tokens: [number, number, number];
  }[];
  /** Model totals for the last 7, 30 and 90 days. */
  models: { '7': MenubarModelUsage[]; '30': MenubarModelUsage[]; '90': MenubarModelUsage[] };
  /** Footnote describing which devices the scope covers. */
  note: string;
}

export interface MenubarUsage {
  /** ISO dates (YYYY-MM-DD), oldest first, ending today. */
  days: string[];
  scopes: Record<MenubarUsageScope, MenubarUsageScopeData>;
}

export interface MenubarManageRow {
  id: string;
  logoSvg: string;
  title: string;
  subtitle: string;
  value: string;
  hidden: boolean;
}

export interface MenubarStrings {
  [key: string]: string;
}

export interface MenubarView {
  /** BCP 47 locale for dates and numbers. */
  locale: string;
  /** Symbol of the usage ledger currency: "$" on Global, "¥" in mainland China. */
  moneySymbol: string;
  strings: MenubarStrings;
  /** Text after the menu bar icon for each mode; the active one is `settings.statusText`. */
  statusTextByMode: Record<MenubarStatusTextMode, string | null>;
  /** Same attention count as Agent Island, shown before the optional usage text. */
  attentionCount?: number;
  activities?: MenubarActivity[];
  /** Same active-controller predicate as the in-app connection indicator. */
  remotelyControlled?: boolean;
  /** Live display names from the same controller set as the in-app indicator. */
  remoteControllerNames?: string[];
  updatedAtMs: number | null;
  headlinePrimary: string;
  headlineSecondary: string | null;
  /** The second line is about sources running low or resetting, so it carries the warning mark. */
  headlineAlert: boolean;
  sources: MenubarSourceCell[];
  details: Record<string, MenubarDetail>;
  taskSummary: string;
  tasks: MenubarTask[];
  usage: MenubarUsage;
  manage: MenubarManageRow[];
  settings: MenubarSettings;
  /**
   * Set while nothing may be read yet: "sign-in" until the user signs in or skips sign-in.
   * The panel then shows only the prompt and the icon carries no text.
   */
  gate?: MenubarGate;
}

export type MenubarGate = 'sign-in';

/** Messages the helper sends to main. */
export type MenubarHelperMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'panel'; open: boolean }
  | { type: 'refresh' }
  | { type: 'open-app' }
  | { type: 'open-session'; sessionId: string }
  | { type: 'detail-action'; sourceId: string }
  | { type: 'open-provider-settings' }
  | { type: 'open-remote-control-settings' }
  | { type: 'settings'; patch: MenubarSettingsPatch };

/** Settings → Window behavior toggle; only the local app renderer may call these. */
export const MENUBAR_GET_STATE_CHANNEL = 'menubar:get-state';
export const MENUBAR_SET_ENABLED_CHANNEL = 'menubar:set-enabled';

export interface MenubarState {
  /** macOS 14 or later; the helper relies on SwiftUI APIs introduced in Sonoma. */
  available: boolean;
  enabled: boolean;
}

/** Darwin 23 is macOS 14 Sonoma. */
export function isMenubarSupportedPlatform(platform: string, osRelease: string): boolean {
  if (platform !== 'darwin') return false;
  const major = Number.parseInt(osRelease.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= 23;
}
