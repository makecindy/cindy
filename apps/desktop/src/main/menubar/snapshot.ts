/**
 * Builds the menu bar view model from normalized usage inputs.
 *
 * Pure: no Electron, no I/O, no clock. `collect.ts` gathers the inputs and `service.ts`
 * sends the result to the native helper. Every product sentence is decided here so the
 * Swift side never reasons about accounts, only renders.
 *
 * Wording rules: Cindy does not switch accounts on its own and has no default Codex
 * account, so nothing here may claim it does. Suggestions describe the data ("has the most
 * left", "resets Wednesday") and actions are explicit ("start a task with X").
 */

import {
  type MenubarColor,
  type MenubarDetail,
  type MenubarDetailAction,
  type MenubarFact,
  type MenubarGate,
  type MenubarLevel,
  type MenubarManageRow,
  type MenubarModelUsage,
  type MenubarSettings,
  type MenubarSourceCell,
  type MenubarStatusTextMode,
  type MenubarStrings,
  type MenubarTask,
  type MenubarUsage,
  type MenubarUsageScope,
  type MenubarUsageScopeData,
  type MenubarView,
} from '../../shared/menubarQuota.js';

export type MenubarHarness = 'claude-code' | 'codex' | 'pi' | 'zcode';
export type MenubarFamily = 'claude' | 'codex' | 'grok';

export interface MenubarWindowInput {
  kind: 'session' | 'week' | 'scoped';
  /** Model name for scoped windows ("Fable"). */
  label?: string | null;
  /** 0...100 used. */
  usedPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number;
}

export interface MenubarSubscriptionInput {
  kind: 'subscription';
  id: string;
  providerId: string;
  family: MenubarFamily;
  logoSvg: string;
  /** Brand shown as the detail title: Claude, Codex, Grok. */
  brand: string;
  /** Account email when the provider exposes one (Codex accounts). */
  account: string | null;
  plan: string | null;
  /** Empty while the first read is still pending. */
  windows: MenubarWindowInput[];
  /** Codex extra credits; null when the account reports none. */
  credits: number | null;
  creditsUnlimited: boolean;
  /** xAI prepaid balance in USD. */
  prepaidUsd: number | null;
  updatedAtMs: number | null;
  /** Identity keys used only to recognize one account read on two computers; never shown. */
  accountKeys?: readonly string[];
  /** A running task on this computer uses this account. */
  consuming?: boolean;
  /** Set when the account is signed in on another of the user's computers. */
  device?: MenubarRemoteDevice | null;
  /** Codex rate-limit resets the user can redeem. */
  resetCredits?: MenubarResetCredits | null;
}

export interface MenubarRemoteDevice {
  id: string;
  name: string;
}

export interface MenubarResetCredits {
  count: number;
  /** Soonest expiry among the available resets; null when none expires. */
  earliestExpiryMs: number | null;
}

export interface MenubarBalanceInput {
  kind: 'balance';
  id: string;
  logoSvg: string;
  /** Remaining balance in the billing currency. */
  available: number;
  /** What a full tube means: the sum of pool totals, or the largest balance seen. */
  fullAmount: number | null;
  /** Average daily decrease over the sampled days; null until there is enough history. */
  burnPerDay: number | null;
  observedAtMs: number | null;
  /** Billing currency, which can differ from the usage ledger currency. */
  currency: 'USD' | 'CNY';
  /** Set for a period quota (organization or gateway key) rather than a wallet. */
  quota: MenubarQuotaPeriod | null;
  /** What is left in each wallet pool; null when the server did not report them. */
  pools?: MenubarWalletPools | null;
  /** The promotional grant with money left that expires first. */
  promoExpiry?: { amount: number; expiresAtMs: number } | null;
  /** A running task on this computer is billed to the Cindy balance. */
  consuming?: boolean;
}

export interface MenubarWalletPools {
  plan: number;
  purchased: number;
  promotional: number;
}

/** A gateway budget that refills each period, unlike a wallet that only grows by top-ups. */
export interface MenubarQuotaPeriod {
  resetsAtMs: number | null;
  /** Spent today (UTC day) across every client; null when the gateway did not say. */
  todaySpend: number | null;
  /** Undefined preserves the legacy gateway's daily display. */
  dailyLimitEnabled?: boolean;
}

export interface MenubarPaygInput {
  kind: 'payg';
  id: string;
  providerId: string;
  logoSvg: string;
  name: string;
  /** api = billed per use; subscription = a plan Cindy cannot read the remaining amount of. */
  billing: 'api' | 'subscription';
  /** A running task on this computer uses this provider. */
  consuming?: boolean;
}

export type MenubarSourceInput = MenubarSubscriptionInput | MenubarBalanceInput | MenubarPaygInput;

export interface MenubarTaskInput {
  sessionId: string;
  title: string;
  harness: MenubarHarness;
  model: string;
  tokensToday: number;
  valueToday: number;
  contextPercent: number | null;
  running: boolean;
  startedAtMs: number | null;
  lastActiveAtMs: number;
  /** Provider the session sends to (null = the implicit default route); only used to mark
   * the source it is drawing on, together with the raw model and agent kind below. */
  providerId?: string | null;
  routeModel?: string | null;
  routeAgentKind?: string | null;
}

export interface MenubarUsageDeviceInput {
  name: string;
  isSelf: boolean;
  syncedAtMs: number | null;
}

export interface MenubarUsageScopeInput {
  daily: MenubarUsageScopeData['daily'];
  models: MenubarUsageScopeData['models'];
  devices: MenubarUsageDeviceInput[];
}

export interface MenubarUsageInput {
  days: string[];
  scopes: Record<MenubarUsageScope, MenubarUsageScopeInput>;
}

/** Looks up `menubar.<key>` and fills `{{name}}`; a numeric `count` picks `_one` / `_other`. */
export type MenubarTranslate = (key: string, vars?: Record<string, string | number>) => string;

export interface MenubarBuildInput {
  nowMs: number;
  locale: string;
  moneySymbol: string;
  settings: MenubarSettings;
  sources: MenubarSourceInput[];
  tasks: MenubarTaskInput[];
  usage: MenubarUsageInput;
  updatedAtMs: number | null;
  harnessLogos: Record<MenubarHarness, string>;
  /** Raw templates the helper fills itself (relative times, clocks, page chrome). */
  uiStrings: MenubarStrings;
  t: MenubarTranslate;
  /** Shows the gate instead of data; callers pass empty sources, tasks and usage with it. */
  gate?: MenubarGate;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WARN_REMAINING = 15;
const SOON_MS = 12 * HOUR_MS;
const RESTORE_GROUP_MS = 6 * HOUR_MS;
const RESTORE_HORIZON_MS = 7 * DAY_MS;
const MIN_PACE_ELAPSED = 0.03;
/** Up to this many visible cells have room for the full "resets in …" phrase. */
const ROOMY_CELL_LIMIT = 4;
/** Settings' soft daily limit for a period quota: period total / 30 × 4.5 (a display hint, not a cap). */
const DAILY_SOFT_LIMIT_FACTOR = 4.5;
const FAMILY_ORDER: Record<MenubarFamily, number> = { claude: 0, codex: 1, grok: 2 };
const FAMILY_COLORS: Record<MenubarFamily, MenubarColor[]> = {
  claude: ['claude', 'claude2', 'claude3'],
  codex: ['codex'],
  grok: ['fill'],
};
const HARNESS_ORDER: MenubarHarness[] = ['claude-code', 'codex', 'pi'];

interface WindowState {
  window: MenubarWindowInput;
  remaining: number;
  leftMs: number;
  elapsed: number;
  expected: number;
  /** Positive = ahead of an even pace (spending fast), negative = in reserve. */
  pace: number | null;
  /** Time until empty at the current pace, when that comes before the reset. */
  etaMs: number | null;
}

interface SubscriptionState {
  windows: WindowState[];
  /** The tightest window that limits the whole account (scoped windows excluded). */
  limit: WindowState | null;
  remaining: number | null;
}

function windowState(window: MenubarWindowInput, nowMs: number): WindowState {
  const span = Math.max(1, window.windowMinutes) * 60_000;
  const leftMs = window.resetsAtMs === null ? span : Math.max(0, window.resetsAtMs - nowMs);
  const elapsed = Math.min(1, Math.max(0, 1 - leftMs / span));
  const used = clamp(window.usedPercent, 0, 100);
  const remaining = 100 - used;
  const state: WindowState = {
    window,
    remaining,
    leftMs,
    elapsed,
    expected: elapsed * 100,
    pace: null,
    etaMs: null,
  };
  if (elapsed >= MIN_PACE_ELAPSED && remaining > 0) {
    state.pace = used - state.expected;
    if (used > 0) {
      const etaMs = remaining / (used / (elapsed * span));
      if (etaMs < leftMs) state.etaMs = etaMs;
    }
  }
  return state;
}

function subscriptionState(source: MenubarSubscriptionInput, nowMs: number): SubscriptionState {
  const windows = source.windows.map((window) => windowState(window, nowMs));
  const limits = windows.filter((state) => state.window.kind !== 'scoped');
  const limit = limits.reduce<WindowState | null>(
    (tightest, state) => (!tightest || state.remaining < tightest.remaining ? state : tightest),
    null,
  );
  return { windows, limit, remaining: limit ? limit.remaining : null };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function levelOf(remaining: number): MenubarLevel {
  if (remaining <= 0) return 'error';
  if (remaining <= WARN_REMAINING) return 'warn';
  return 'normal';
}

function levelColor(level: MenubarLevel): MenubarColor | null {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  return null;
}

/** Ordered, visible sources. Pay-as-you-go connections start hidden until the user shows them. */
export function orderSources<T extends { id: string; kind: string }>(
  sources: readonly T[],
  settings: MenubarSettings,
): { ordered: T[]; isHidden: (source: T) => boolean } {
  const rank = new Map(settings.order.map((id, index) => [id, index]));
  const naturalRank = (source: T): number => (source.kind === 'balance' ? 0 : source.kind === 'subscription' ? 1 : 2);
  const ordered = sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const ra = rank.get(a.source.id);
      const rb = rank.get(b.source.id);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return naturalRank(a.source) - naturalRank(b.source) || a.index - b.index;
    })
    .map(({ source }) => source);
  const hidden = new Set(settings.hidden);
  const shown = new Set(settings.shown);
  const isHidden = (source: T): boolean =>
    hidden.has(source.id) || (source.kind === 'payg' && !shown.has(source.id));
  return { ordered, isHidden };
}

class Builder {
  private readonly states = new Map<string, SubscriptionState>();
  private readonly timeFormat: Intl.DateTimeFormat;
  private readonly weekdayFormat: Intl.DateTimeFormat;
  private readonly dateFormat: Intl.DateTimeFormat;
  private readonly visible: MenubarSourceInput[];
  private readonly ordered: MenubarSourceInput[];
  private readonly isHidden: (source: MenubarSourceInput) => boolean;

  constructor(private readonly input: MenubarBuildInput) {
    this.timeFormat = new Intl.DateTimeFormat(input.locale, { hour: '2-digit', minute: '2-digit' });
    this.weekdayFormat = new Intl.DateTimeFormat(input.locale, { weekday: 'short' });
    this.dateFormat = new Intl.DateTimeFormat(input.locale, { month: 'short', day: 'numeric' });
    const { ordered, isHidden } = orderSources(input.sources, input.settings);
    this.ordered = ordered;
    this.isHidden = isHidden;
    const visible = ordered.filter((source) => !isHidden(source));
    // Never render an empty menu: if every source is hidden, show them all.
    this.visible = visible.length > 0 ? visible : ordered;
    for (const source of input.sources) {
      if (source.kind === 'subscription') this.states.set(source.id, subscriptionState(source, input.nowMs));
    }
  }

  private get t(): MenubarTranslate {
    return this.input.t;
  }

  private state(source: MenubarSubscriptionInput): SubscriptionState {
    return this.states.get(source.id) ?? subscriptionState(source, this.input.nowMs);
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  private money(value: number, symbol = this.input.moneySymbol): string {
    if (value >= 10_000) return `${symbol}${(value / 1000).toFixed(1)}k`;
    if (value >= 100) return `${symbol}${Math.round(value).toLocaleString('en-US')}`;
    return `${symbol}${value.toFixed(2)}`;
  }

  private balanceMoney(value: number, currency: 'USD' | 'CNY'): string {
    return this.money(value, currency === 'CNY' ? '¥' : '$');
  }

  /** Full amount to the cent, for the detail facts where the tube's rounding would hide spend. */
  private exactMoney(value: number, currency: 'USD' | 'CNY'): string {
    const amount = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${currency === 'CNY' ? '¥' : '$'}${amount}`;
  }

  private tokens(value: number): string {
    const millions = value / 1e6;
    if (millions >= 1000) return `${(millions / 1000).toFixed(1)}B`;
    if (millions >= 1) return `${Math.round(millions)}M`;
    return `${Math.round(millions * 1000)}K`;
  }

  private grouped(value: number): string {
    return Math.round(value).toLocaleString('en-US');
  }

  private compact(value: number): string {
    return new Intl.NumberFormat(this.input.locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  private dayOffset(ms: number): number {
    const day = new Date(ms);
    const now = new Date(this.input.nowMs);
    const startOfDay = (date: Date): number =>
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    return Math.round((startOfDay(day) - startOfDay(now)) / DAY_MS);
  }

  /** "今天 14:00" / "明天 14:00" / "周三 14:00" / "10月14日 14:00". */
  private at(ms: number): string {
    const time = this.timeFormat.format(ms);
    const offset = this.dayOffset(ms);
    if (offset === 0) return this.t('time.today', { time });
    if (offset === 1) return this.t('time.tomorrow', { time });
    if (offset > 1 && offset < 7) return this.t('time.weekday', { day: this.weekdayFormat.format(ms), time });
    return this.t('time.date', { date: this.dateFormat.format(ms), time });
  }

  /** "6天7时" / "4时46分" / "12分": the same two units, compact enough for under a tube. */
  private shortDuration(ms: number): string {
    const minutes = Math.max(1, Math.floor(ms / 60_000));
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    if (d) return h ? this.t('durationShort.daysHours', { d, h }) : this.t('durationShort.days', { d });
    if (h) return m ? this.t('durationShort.hoursMinutes', { h, m }) : this.t('durationShort.hours', { h });
    return this.t('durationShort.minutes', { m });
  }

  /** "3 天 4 小时" / "2 小时 5 分" / "12 分钟". */
  private duration(ms: number): string {
    const seconds = Math.max(0, ms / 1000);
    const d = Math.floor(seconds / 86_400);
    const h = Math.floor((seconds % 86_400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return h ? this.t('duration.daysHours', { d, h }) : this.t('duration.days', { count: d, d });
    if (h) return m ? this.t('duration.hoursMinutes', { h, m }) : this.t('duration.hours', { count: h, h });
    return this.t('duration.minutes', { count: Math.max(1, m), m: Math.max(1, m) });
  }

  private ago(ms: number): string {
    const minutes = Math.max(1, Math.round((this.input.nowMs - ms) / 60_000));
    if (minutes < 60) return this.t('time.minutesAgo', { count: minutes, n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return this.t('time.hoursAgo', { count: hours, n: hours });
    const days = Math.floor(hours / 24);
    return this.t('time.daysAgo', { count: days, n: days });
  }

  private windowLabel(window: MenubarWindowInput): string {
    if (window.kind === 'session') return this.t('window.session', { hours: Math.round(window.windowMinutes / 60) });
    if (window.kind === 'scoped') return this.t('window.scoped', { model: window.label ?? '' });
    return this.t('window.week');
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  private handle(source: MenubarSubscriptionInput): string | null {
    if (!source.account) return null;
    const [local] = source.account.split('@');
    if (!local) return null;
    if (!this.input.settings.privacy) return local;
    return `${local[0]}•••${local.length > 1 ? local[local.length - 1] : ''}`;
  }

  private email(source: MenubarSubscriptionInput): string {
    if (!source.account) return '';
    if (!this.input.settings.privacy) return source.account;
    const domain = source.account.split('@')[1];
    return domain ? `${this.handle(source)}@${domain}` : this.handle(source) ?? '';
  }

  /** Short name under a tube and in sentences: the other computer, else the account handle, else the brand. */
  private who(source: MenubarSourceInput): string {
    if (source.kind === 'subscription') return source.device?.name ?? this.handle(source) ?? source.brand;
    if (source.kind === 'balance') return this.t('balance.short');
    return source.name;
  }

  private sourceTitle(source: MenubarSourceInput): string {
    if (source.kind === 'subscription') return source.device?.name ?? this.handle(source) ?? source.brand;
    if (source.kind === 'balance') return this.t(source.quota ? 'balance.quotaName' : 'balance.name');
    return source.name;
  }

  // ── Judgment ──────────────────────────────────────────────────────────────

  private visibleSubscriptions(): MenubarSubscriptionInput[] {
    return this.visible.filter((source): source is MenubarSubscriptionInput => source.kind === 'subscription');
  }

  private remaining(source: MenubarSubscriptionInput): number | null {
    return this.state(source).remaining;
  }

  /** The subscription with the most room left, else a balance with money on it. */
  private recommended(): MenubarSourceInput | null {
    const subscriptions = this.visibleSubscriptions()
      .filter((source) => (this.remaining(source) ?? 0) > 0)
      .sort(
        (a, b) =>
          (this.remaining(b) ?? 0) - (this.remaining(a) ?? 0)
          || FAMILY_ORDER[a.family] - FAMILY_ORDER[b.family],
      );
    if (subscriptions[0]) return subscriptions[0];
    return this.visible.find((source) => source.kind === 'balance' && source.available > 0) ?? null;
  }

  /** The subscription closest to empty that still has room. */
  private tightest(): MenubarSubscriptionInput | null {
    return (
      this.visibleSubscriptions()
        .filter((source) => (this.remaining(source) ?? 0) > 0)
        .sort((a, b) => (this.remaining(a) ?? 0) - (this.remaining(b) ?? 0))[0] ?? null
    );
  }

  /**
   * When nearly-empty sources get their limiting window back, within a week, grouped when the
   * same family resets within 6 hours. Sources with plenty left are not worth a headline.
   */
  private restores(): { atMs: number; sources: MenubarSubscriptionInput[] }[] {
    const events: { atMs: number; source: MenubarSubscriptionInput }[] = [];
    for (const source of this.visibleSubscriptions()) {
      const { limit, remaining } = this.state(source);
      const atMs = limit?.window.resetsAtMs ?? null;
      if (remaining === null || remaining > WARN_REMAINING || atMs === null) continue;
      if (atMs - this.input.nowMs > RESTORE_HORIZON_MS) continue;
      events.push({ atMs, source });
    }
    events.sort((a, b) => a.atMs - b.atMs);
    const groups: { atMs: number; sources: MenubarSubscriptionInput[] }[] = [];
    for (const event of events) {
      const last = groups[groups.length - 1];
      if (last && event.atMs - last.atMs < RESTORE_GROUP_MS && last.sources[0]?.family === event.source.family) {
        if (!last.sources.includes(event.source)) last.sources.push(event.source);
      } else {
        groups.push({ atMs: event.atMs, sources: [event.source] });
      }
    }
    return groups;
  }

  private headline(): { primary: string; secondary: string | null; alert: boolean } {
    const recommended = this.recommended();
    const groups = this.restores();
    const soon = this.visibleSubscriptions()
      .map((source) => ({ source, eta: this.state(source).limit?.etaMs ?? null }))
      .filter((entry): entry is { source: MenubarSubscriptionInput; eta: number } => entry.eta !== null && entry.eta < SOON_MS)
      .sort((a, b) => a.eta - b.eta)[0];
    const big = groups.find((group) => group.sources.length > 1) ?? groups[0];
    const parts: string[] = [];
    if (big) {
      const first = big.sources[0]!;
      const name = big.sources.length > 1 ? first.brand : this.who(first);
      parts.push(this.t('headline.restore', { name, duration: this.duration(big.atMs - this.input.nowMs) }));
    }
    // A source already named for its reset does not also need "running low".
    if (soon && !big?.sources.includes(soon.source)) parts.push(this.t('headline.soon', { name: this.who(soon.source) }));
    const sentence = (items: string[]): string | null =>
      items.length ? this.t('headline.sentence', { text: items.join(this.t('headline.joiner')) }) : null;
    if (!recommended) {
      // "Used up" is only true when something was actually measured empty.
      const measured =
        this.visible.some((source) => source.kind === 'balance')
        || this.visibleSubscriptions().some((source) => this.remaining(source) !== null);
      if (!measured) {
        const unread = this.visibleSubscriptions().length > 0;
        return unread
          ? { primary: this.t('headline.unread'), secondary: null, alert: false }
          : { primary: this.t('headline.empty'), secondary: this.t('headline.emptyHint'), alert: false };
      }
      return {
        primary: this.t('headline.none'),
        secondary: sentence(parts.length ? [parts[0]!] : [this.t('headline.waitReset')]),
        alert: true,
      };
    }
    if (recommended.kind === 'balance') {
      const primary = this.t(recommended.quota ? 'headline.quota' : 'headline.balance');
      return {
        primary,
        secondary: sentence([this.t('headline.subscriptionsUsed'), ...parts]),
        alert: true,
      };
    }
    return {
      primary: this.t('headline.recommend', { name: this.who(recommended) }),
      secondary: sentence(parts),
      alert: parts.length > 0,
    };
  }

  // ── Cells ─────────────────────────────────────────────────────────────────

  private cells(): MenubarSourceCell[] {
    const recommended = this.recommended();
    const roomy = this.visible.length <= ROOMY_CELL_LIMIT;
    return this.visible.map((source) => this.cell(source, source === recommended, roomy));
  }

  /** A quota counts down to its reset like a subscription; a wallet says how long it lasts. */
  private balanceWhen(source: MenubarBalanceInput, days: number | null, roomy: boolean): string {
    const resetsAtMs = source.quota?.resetsAtMs ?? null;
    if (resetsAtMs !== null) {
      const duration = this.shortDuration(resetsAtMs - this.input.nowMs);
      return roomy ? this.t('cell.resetsIn', { duration }) : duration;
    }
    return days === null ? '' : this.t(roomy ? 'cell.lastsDays' : 'cell.lastsDaysShort', { n: days });
  }

  private cell(source: MenubarSourceInput, emphasized: boolean, roomy: boolean): MenubarSourceCell {
    const base = { id: source.id, kind: source.kind, logoSvg: source.logoSvg, emphasized, active: source.consuming === true };
    if (source.kind === 'payg') {
      const label = this.t(source.billing === 'api' ? 'cell.payg' : 'cell.plan');
      return {
        ...base,
        emphasized: false,
        name: source.name,
        value: null,
        valueUnit: null,
        valueLabel: label,
        level: 'normal',
        fill: null,
        reserve: false,
        when: this.t(source.billing === 'api' ? 'cell.noBalance' : 'cell.unknown'),
        whenLevel: 'normal',
        accessibilityLabel: this.t(source.billing === 'api' ? 'a11y.payg' : 'a11y.plan', { name: source.name }),
      };
    }
    if (source.kind === 'balance') {
      const days = source.burnPerDay && source.burnPerDay > 0 ? Math.floor(source.available / source.burnPerDay) : null;
      const fill = source.fullAmount && source.fullAmount > 0 ? clamp(source.available / source.fullAmount, 0, 1) : source.available > 0 ? 1 : 0;
      const amount = this.balanceMoney(source.available, source.currency);
      return {
        ...base,
        name: this.t('balance.short'),
        value: amount,
        valueUnit: null,
        valueLabel: null,
        level: source.available > 0 ? 'normal' : 'error',
        fill,
        reserve: false,
        when: this.balanceWhen(source, days, roomy),
        whenLevel: 'normal',
        accessibilityLabel: source.quota
          ? this.t('a11y.quota', { amount })
          : days === null
            ? this.t('a11y.balance', { amount })
            : this.t('a11y.balanceDays', { amount, n: days }),
      };
    }
    const state = this.state(source);
    const name = this.who(source);
    if (!state.limit || state.remaining === null) {
      return {
        ...base,
        emphasized: false,
        name,
        value: null,
        valueUnit: null,
        valueLabel: '—',
        level: 'normal',
        fill: null,
        reserve: false,
        when: this.t('cell.noData'),
        whenLevel: 'normal',
        accessibilityLabel: this.t('a11y.noData', { name: `${source.brand} ${name}`.trim() }),
      };
    }
    const remaining = state.remaining;
    const level = levelOf(remaining);
    const reserve = remaining <= 0 && (source.creditsUnlimited || (source.credits ?? 0) > 0);
    const limit = state.limit;
    // Read together with the percentage above: "90% · resets in 6d 7h", for the window shown.
    let when = '';
    if (limit.window.resetsAtMs !== null) {
      const duration = this.shortDuration(limit.window.resetsAtMs - this.input.nowMs);
      when = roomy ? this.t('cell.resetsIn', { duration }) : duration;
    }
    const whenLevel: MenubarLevel = level;
    return {
      ...base,
      name,
      value: reserve ? null : String(Math.round(remaining)),
      valueUnit: reserve ? null : '%',
      valueLabel: reserve ? this.t('cell.credits') : null,
      level,
      fill: clamp(remaining / 100, 0, 1),
      reserve,
      when,
      whenLevel,
      accessibilityLabel: reserve
        ? this.t('a11y.reserve', { name: `${source.brand} ${name}` })
        : this.t('a11y.remaining', { name: source.brand === name ? name : `${source.brand} ${name}`, n: Math.round(remaining) }),
    };
  }

  // ── Details ───────────────────────────────────────────────────────────────

  private details(): Record<string, MenubarDetail> {
    const details: Record<string, MenubarDetail> = {};
    for (const source of this.ordered) details[source.id] = this.detail(source);
    return details;
  }

  private detail(source: MenubarSourceInput): MenubarDetail {
    if (source.kind === 'balance') return this.balanceDetail(source);
    if (source.kind === 'payg') return this.paygDetail(source);
    return this.subscriptionDetail(source);
  }

  private balanceDetail(source: MenubarBalanceInput): MenubarDetail {
    const fraction = source.fullAmount && source.fullAmount > 0 ? clamp(source.available / source.fullAmount, 0, 1) : source.available > 0 ? 1 : 0;
    const burn = source.burnPerDay && source.burnPerDay > 0 ? source.burnPerDay : null;
    const days = burn ? source.available / burn : null;
    const quota = source.quota;
    const resetsAtMs = quota?.resetsAtMs ?? null;
    const updated = source.observedAtMs ? this.t('fact.updatedAgo', { ago: this.ago(source.observedAtMs) }) : '';
    const dailyUse: MenubarFact = {
      label: this.t('fact.dailyUse'),
      value: burn ? this.t('fact.about', { value: this.balanceMoney(burn, source.currency) }) : this.t('fact.estimating'),
      sub: burn ? this.t('fact.last7Days') : this.t('fact.estimatingSub'),
    };
    const runsOutAtMs = days !== null ? this.input.nowMs + days * DAY_MS : null;
    const runsOut: MenubarFact = {
      label: this.t('fact.runsOut'),
      value: runsOutAtMs !== null ? this.t('fact.aroundDate', { date: this.dateFormat.format(runsOutAtMs) }) : '—',
      sub: runsOutAtMs !== null ? this.t('fact.atThisPace') : this.t('fact.estimatingSub'),
    };
    const facts: MenubarFact[] = [];
    if (quota) {
      facts.push(
        { label: this.t('fact.quotaLeft'), value: this.exactMoney(source.available, source.currency), sub: updated },
        {
          label: this.t('fact.quotaTotal'),
          value: source.fullAmount !== null ? this.exactMoney(source.fullAmount, source.currency) : '—',
          sub: resetsAtMs !== null
            ? this.t('fact.timeLeft', { duration: this.duration(resetsAtMs - this.input.nowMs) })
            : this.t('fact.cindyModels'),
        },
      );
      if (quota.dailyLimitEnabled !== false && quota.todaySpend !== null) {
        const suggested = source.fullAmount ? (source.fullAmount / 30) * DAILY_SOFT_LIMIT_FACTOR : null;
        facts.push({
          label: this.t('fact.todaySpent'),
          value: this.exactMoney(quota.todaySpend, source.currency),
          sub: suggested ? this.t('fact.dailySuggested', { value: this.balanceMoney(suggested, source.currency) }) : '',
        });
      }
      facts.push(dailyUse);
      // A quota that refills before it would run out has no run-out date worth showing.
      if (runsOutAtMs !== null && (resetsAtMs === null || runsOutAtMs < resetsAtMs)) facts.push(runsOut);
    } else {
      facts.push({ label: this.t('fact.balance'), value: this.exactMoney(source.available, source.currency), sub: updated }, dailyUse, runsOut);
      const pools = source.pools ?? null;
      const promo = source.promoExpiry ?? null;
      const poolFacts: MenubarFact[] = [];
      if (pools && pools.plan > 0) {
        poolFacts.push({ label: this.t('fact.poolPlan'), value: this.exactMoney(pools.plan, source.currency), sub: this.t('fact.poolPlanSub') });
      }
      if (pools && pools.purchased > 0) {
        poolFacts.push({ label: this.t('fact.poolPurchased'), value: this.exactMoney(pools.purchased, source.currency), sub: this.t('fact.poolPurchasedSub') });
      }
      if ((pools && pools.promotional > 0) || promo) {
        poolFacts.push({
          label: this.t('fact.poolPromo'),
          value: pools ? this.exactMoney(pools.promotional, source.currency) : '—',
          // Name the amount only when just part of the gifts runs out first.
          sub: !promo
            ? this.t('fact.poolPromoSub')
            : pools && promo.amount < pools.promotional - 0.005
              ? this.t('fact.promoExpires', {
                  value: this.balanceMoney(promo.amount, source.currency),
                  date: this.dateFormat.format(promo.expiresAtMs),
                })
              : this.t('fact.promoExpiresAll', { date: this.dateFormat.format(promo.expiresAtMs) }),
        });
      }
      facts.push(...poolFacts);
      // The grid has two columns; the general note fills an odd row or stands in for the pools.
      if (facts.length % 2 === 1) facts.push({ label: this.t('fact.usedFor'), value: this.t('fact.cindyModels'), sub: this.t('fact.chargedPerUse') });
    }
    const lasts = days !== null
      ? this.t('say.balanceLasts', { count: Math.floor(days), n: Math.floor(days) })
      : this.t('say.balanceEstimating');
    return {
      id: source.id,
      logoSvg: source.logoSvg,
      title: this.t(quota ? 'balance.quotaName' : 'balance.name'),
      plan: '',
      rings: [{ fraction, color: 'ink' }],
      bigValue: this.balanceMoney(source.available, source.currency),
      bigUnit: null,
      bigColor: source.available > 0 ? null : 'error',
      bigCompact: true,
      bigCaption: this.t(quota ? 'detail.quotaCaption' : 'detail.balanceCaption'),
      legend: [],
      sayPrimary: !quota
        ? this.t('say.balance')
        : resetsAtMs !== null
          ? this.t('say.quotaResets', { at: this.at(resetsAtMs) })
          : this.t('say.quota'),
      saySecondary: lasts,
      facts,
      // An organization quota is not topped up from here; its connection lives in Settings.
      actionLabel: this.t(quota ? 'action.manage' : 'action.topUp'),
      action: { kind: quota ? 'open-settings' : 'open-billing' },
    };
  }

  private paygDetail(source: MenubarPaygInput): MenubarDetail {
    const api = source.billing === 'api';
    const hidden = this.isHidden(source);
    return {
      id: source.id,
      logoSvg: source.logoSvg,
      title: source.name,
      plan: api ? this.t('detail.apiKey') : this.t('detail.subscription'),
      rings: [{ fraction: 0, color: 'ink3' }],
      bigValue: '—',
      bigUnit: null,
      bigColor: null,
      bigCompact: false,
      bigCaption: this.t(api ? 'detail.noBalance' : 'detail.unknownRemaining'),
      legend: [],
      sayPrimary: this.t(api ? 'say.payg' : 'say.plan', { name: source.name }),
      saySecondary: this.t(api ? 'say.paygSub' : 'say.planSub'),
      facts: [
        { label: this.t('fact.billing'), value: this.t(api ? 'fact.perUse' : 'fact.subscription'), sub: this.t('fact.connected') },
        { label: this.t('fact.balance'), value: '—', sub: this.t(api ? 'fact.notProvided' : 'fact.notReadable') },
        { label: this.t('fact.inMenu'), value: this.t(hidden ? 'fact.hidden' : 'fact.shown'), sub: this.t('fact.editHint') },
        { label: this.t('fact.usage'), value: this.t('fact.counted'), sub: this.t('fact.countedSub') },
      ],
      actionLabel: this.t('action.manage'),
      action: { kind: 'open-settings' },
    };
  }

  private subscriptionDetail(source: MenubarSubscriptionInput): MenubarDetail {
    const state = this.state(source);
    const limit = state.limit;
    const handle = this.handle(source);
    const resets = source.resetCredits?.count ?? 0;
    // An account on another computer runs there; this computer cannot start a task on it directly.
    let actionLabel = source.device
      ? this.t('action.openApp')
      : this.t('action.newTask', { name: handle ?? source.brand });
    let action: MenubarDetailAction = source.device
      ? { kind: 'open-app' }
      : { kind: 'new-task', providerId: source.providerId };
    if (!limit || state.remaining === null) {
      return {
        id: source.id,
        logoSvg: source.logoSvg,
        title: source.brand,
        plan: source.plan ?? '',
        rings: [{ fraction: 0, color: 'ink3' }],
        bigValue: '—',
        bigUnit: null,
        bigColor: null,
        bigCompact: false,
        bigCaption: this.t('detail.noData'),
        legend: [],
        sayPrimary: this.t('say.noData'),
        saySecondary: this.t('say.noDataSub'),
        facts: this.accountFacts(source),
        actionLabel,
        action,
      };
    }
    const remaining = state.remaining;
    const level = levelOf(remaining);
    const colors = FAMILY_COLORS[source.family];
    const multi = state.windows.length > 1;
    const ringColor = levelColor(level) ?? colors[0]!;
    const rings = multi
      ? state.windows.map((window, index) => ({
          fraction: clamp(window.remaining / 100, 0, 1),
          color: colors[index % colors.length]!,
        }))
      : [{ fraction: clamp(remaining / 100, 0, 1), color: ringColor }];
    const limits = state.windows.filter((window) => window.window.kind !== 'scoped');
    const refreshList = limits
      .filter((window) => window.window.resetsAtMs !== null)
      .map((window) => this.t('say.windowRefresh', { window: this.windowLabel(window.window), at: this.at(window.window.resetsAtMs!) }))
      .join(this.t('headline.joiner'));
    const resetAt = limit.window.resetsAtMs !== null ? this.at(limit.window.resetsAtMs) : null;
    const credits = source.credits ?? 0;
    const creditsLabel = source.creditsUnlimited ? this.t('fact.unlimited') : this.grouped(credits);
    let sayPrimary: string;
    let saySecondary: string | null = null;
    if (remaining <= 0) {
      sayPrimary = this.t('say.usedUp', { window: this.windowLabel(limit.window) });
      if (source.creditsUnlimited || credits > 0) {
        saySecondary = resetAt
          ? this.t('say.usedUpWithCredits', { at: resetAt, credits: creditsLabel })
          : this.t('say.creditsOnly', { credits: creditsLabel });
      } else if (resets > 0 && !source.device) {
        saySecondary = this.t('say.usedUpWithResets', { count: resets, n: resets });
        // Resets are spent from Settings, next to the account.
        actionLabel = this.t('action.useReset');
        action = { kind: 'open-settings' };
      } else if (resetAt) {
        saySecondary = this.t('say.resetsAt', { at: resetAt });
      }
    } else if (limit.etaMs !== null) {
      sayPrimary = this.t('say.emptyIn', { duration: this.duration(limit.etaMs) });
      saySecondary = this.t('say.beforeReset', { duration: this.duration(limit.leftMs - limit.etaMs) });
    } else if (remaining >= 99.5) {
      sayPrimary = this.t('say.full');
      saySecondary = refreshList ? this.t('headline.sentence', { text: refreshList }) : null;
    } else if (limit.pace !== null && limit.pace < -3) {
      sayPrimary = this.t('say.relaxed');
      saySecondary = refreshList ? this.t('headline.sentence', { text: refreshList }) : null;
    } else {
      sayPrimary = this.t('say.onPace');
      saySecondary = refreshList ? this.t('headline.sentence', { text: refreshList }) : null;
    }
    const facts: MenubarFact[] = [];
    for (const window of limits) {
      if (window.window.resetsAtMs === null) continue;
      facts.push({
        label: window.remaining <= 0 ? this.t('fact.resetsFull') : this.t('fact.windowResets', { window: this.windowLabel(window.window) }),
        value: this.at(window.window.resetsAtMs),
        sub: this.t('fact.timeLeft', { duration: this.duration(window.leftMs) }),
      });
    }
    for (const window of state.windows.filter((entry) => entry.window.kind === 'scoped')) {
      facts.push({
        label: this.windowLabel(window.window),
        value: this.t('fact.remainingPercent', { n: Math.round(window.remaining) }),
        sub: this.t('fact.perModel'),
      });
    }
    if (limit.pace !== null) {
      facts.push({
        label: this.t('fact.pace'),
        value:
          Math.abs(limit.pace) < 3
            ? this.t('fact.paceNormal')
            : limit.pace > 0
              ? this.t('fact.paceAhead', { n: Math.round(limit.pace) })
              : this.t('fact.paceReserve', { n: Math.round(-limit.pace) }),
        sub: this.t('fact.paceSub', { n: Math.round(100 - limit.expected) }),
      });
    } else if (remaining <= 0) {
      facts.push({ label: this.t('fact.pace'), value: this.t('fact.paceUsedUp'), sub: this.t('fact.paceWaiting') });
    }
    if (source.family === 'codex') {
      facts.push({
        label: this.t('fact.extraCredits'),
        value: source.creditsUnlimited ? this.t('fact.unlimited') : this.grouped(credits),
        sub: source.creditsUnlimited || credits > 0 ? this.t('fact.creditsUsedAfter') : this.t('fact.noCredits'),
      });
    }
    if (resets > 0) {
      const expiry = source.resetCredits?.earliestExpiryMs ?? null;
      facts.push({
        label: this.t('fact.resetCredits'),
        value: this.t('fact.resetCount', { count: resets, n: resets }),
        sub: expiry !== null
          ? this.t('fact.resetExpires', { date: this.dateFormat.format(expiry) })
          : this.t('fact.resetAtLimit'),
      });
    }
    if (source.prepaidUsd !== null) {
      facts.push({ label: this.t('fact.prepaid'), value: `$${source.prepaidUsd.toFixed(2)}`, sub: this.t('fact.xaiAccount') });
    }
    facts.push(...this.accountFacts(source));
    return {
      id: source.id,
      logoSvg: source.logoSvg,
      title: source.brand,
      plan: source.plan ?? '',
      rings,
      bigValue: String(Math.round(remaining)),
      bigUnit: '%',
      bigColor: levelColor(level),
      bigCompact: multi,
      bigCaption: this.t('detail.windowLeft', { window: this.windowLabel(limit.window) }),
      legend: multi
        ? state.windows.map((window, index) => ({
            label: `${this.windowLabel(window.window)} ${Math.round(window.remaining)}%`,
            color: colors[index % colors.length]!,
          }))
        : [],
      sayPrimary,
      saySecondary,
      facts,
      actionLabel,
      action,
    };
  }

  private accountFacts(source: MenubarSubscriptionInput): MenubarFact[] {
    const updated = source.updatedAtMs ? this.t('fact.updatedAgo', { ago: this.ago(source.updatedAtMs) }) : '';
    const facts: MenubarFact[] = [];
    if (source.device) facts.push({ label: this.t('fact.device'), value: source.device.name, sub: this.t('fact.deviceSub') });
    if (source.account) facts.push({ label: this.t('fact.account'), value: this.email(source), sub: updated });
    else if (source.device) facts[0] = { ...facts[0]!, sub: updated || this.t('fact.deviceSub') };
    return facts;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  private tasks(): { summary: string; tasks: MenubarTask[] } {
    const sorted = [...this.input.tasks].sort((a, b) => b.valueToday - a.valueToday || b.tokensToday - a.tokensToday);
    const running = sorted.filter((task) => task.running).length;
    const count = sorted.length;
    const base = this.t('tasks.today', { count, n: count });
    const summary = running ? this.t('tasks.withRunning', { base, count: running, n: running }) : base;
    return {
      summary: count ? summary : '',
      tasks: sorted.map((task) => {
        const metaParts = [task.model, this.tokens(task.tokensToday)];
        if (task.contextPercent !== null) metaParts.push(this.t('tasks.context', { n: Math.round(task.contextPercent) }));
        return {
          sessionId: task.sessionId,
          title: this.input.settings.privacy ? this.t('tasks.private', { harness: this.harnessName(task.harness) }) : task.title,
          harness: task.harness,
          logoSvg: this.input.harnessLogos[task.harness],
          value: task.valueToday,
          tokens: task.tokensToday,
          running: task.running,
          startedAtMs: task.running ? task.startedAtMs ?? task.lastActiveAtMs : null,
          idleStatus: this.ago(task.lastActiveAtMs),
          meta: metaParts.filter(Boolean).join(' · '),
        };
      }),
    };
  }

  private harnessName(harness: MenubarHarness): string {
    return this.t(`harness.${harness}`);
  }

  // ── Usage ─────────────────────────────────────────────────────────────────

  private usage(): MenubarUsage {
    const scopes = {} as Record<MenubarUsageScope, MenubarUsageScopeData>;
    for (const scope of ['local', 'all'] as const) {
      const data = this.input.usage.scopes[scope];
      scopes[scope] = { daily: data.daily, models: data.models, note: this.usageNote(scope, data.devices) };
    }
    return { days: this.input.usage.days, scopes };
  }

  private usageNote(scope: MenubarUsageScope, devices: MenubarUsageDeviceInput[]): string {
    const lines = [this.t('usage.estimateNote')];
    if (scope === 'all' && devices.length > 1) {
      const list = devices
        .map((device) =>
          device.isSelf
            ? this.t('usage.deviceSelf', { name: device.name })
            : device.syncedAtMs
              ? this.t('usage.deviceSynced', { name: device.name, date: this.dateFormat.format(device.syncedAtMs) })
              : this.t('usage.deviceNotSynced', { name: device.name }),
        )
        .join(this.t('usage.deviceJoiner'));
      lines.push(this.t('usage.allDevices', { list }));
    }
    return lines.join('\n');
  }

  // ── Manage & status ───────────────────────────────────────────────────────

  private manage(): MenubarManageRow[] {
    return this.ordered.map((source) => ({
      id: source.id,
      logoSvg: source.logoSvg,
      title: this.sourceTitle(source),
      subtitle: this.manageSubtitle(source),
      value: this.manageValue(source),
      hidden: this.isHidden(source),
    }));
  }

  private manageSubtitle(source: MenubarSourceInput): string {
    if (source.kind === 'balance') return this.t(source.quota ? 'manage.quota' : 'manage.balance');
    if (source.kind === 'payg') return this.t(source.billing === 'api' ? 'manage.payg' : 'manage.plan');
    const plan = source.plan ? ` · ${source.plan}` : '';
    const windows = source.windows
      .filter((window) => window.kind !== 'scoped')
      .map((window) => this.windowLabel(window))
      .join(' + ');
    const subtitle = source.family === 'codex'
      ? `Codex${plan}`
      : this.t('manage.subscription', { plan: source.plan ?? source.brand, windows: windows || '—' });
    return source.device ? this.t('manage.onDevice', { name: source.device.name, subtitle }) : subtitle;
  }

  private manageValue(source: MenubarSourceInput): string {
    if (source.kind === 'balance') return this.balanceMoney(source.available, source.currency);
    if (source.kind === 'payg') return '—';
    const remaining = this.remaining(source);
    if (remaining === null) return '—';
    if (remaining <= 0 && (source.creditsUnlimited || (source.credits ?? 0) > 0)) return this.t('cell.credits');
    return `${Math.round(remaining)}%`;
  }

  private statusTexts(): Record<MenubarStatusTextMode, string | null> {
    const tightest = this.tightest();
    const hasSubscriptions = this.visibleSubscriptions().some((source) => this.remaining(source) !== null);
    const scope = this.input.usage.scopes[this.input.settings.scope];
    const today = scope.daily[scope.daily.length - 1];
    const running = this.input.tasks.filter((task) => task.running);
    return {
      icon: null,
      lowest: tightest ? `${Math.round(this.remaining(tightest) ?? 0)}%` : hasSubscriptions ? '0%' : null,
      today: today ? this.money(today.money.reduce((sum, value) => sum + value, 0)) : null,
      task: running.length ? this.money(running.reduce((sum, task) => sum + task.valueToday, 0)) : null,
    };
  }

  build(): MenubarView {
    const headline = this.headline();
    const tasks = this.tasks();
    return {
      locale: this.input.locale,
      moneySymbol: this.input.moneySymbol,
      strings: this.input.uiStrings,
      statusTextByMode: this.input.gate ? { icon: null, lowest: null, today: null, task: null } : this.statusTexts(),
      updatedAtMs: this.input.updatedAtMs,
      headlinePrimary: headline.primary,
      headlineSecondary: headline.secondary,
      headlineAlert: headline.alert,
      sources: this.cells(),
      details: this.details(),
      taskSummary: tasks.summary,
      tasks: tasks.tasks,
      usage: this.usage(),
      manage: this.manage(),
      settings: this.input.settings,
      ...(this.input.gate ? { gate: this.input.gate } : {}),
    };
  }

  /** Every visible source that can still be used is near empty (or already used up). */
  lowOnEverything(): boolean {
    const counted = this.visible.filter((source) => source.kind !== 'payg');
    if (counted.length === 0) return false;
    let known = 0;
    for (const source of counted) {
      if (source.kind === 'balance') {
        known += 1;
        const days = source.burnPerDay && source.burnPerDay > 0 ? source.available / source.burnPerDay : null;
        if (source.available > 0 && (days === null || days > 1)) return false;
        continue;
      }
      if (source.kind !== 'subscription') continue;
      const remaining = this.remaining(source);
      if (remaining === null) continue;
      known += 1;
      if (remaining > WARN_REMAINING) return false;
    }
    return known > 0;
  }
}

export function buildMenubarView(input: MenubarBuildInput): MenubarView {
  return new Builder(input).build();
}

/** Whether to raise the "running low everywhere" notification for this snapshot. */
export function isLowOnEverything(input: MenubarBuildInput): boolean {
  return new Builder(input).lowOnEverything();
}

/**
 * Merges per-harness model rows into the menu's top models list: the leaders by money and by
 * tokens, so the panel can rank either metric without losing a model that leads only one.
 */
export function topModels(rows: readonly MenubarModelUsage[], limit = 8): MenubarModelUsage[] {
  const merged = new Map<string, MenubarModelUsage>();
  for (const row of rows) {
    const key = `${row.harness}:${row.name}`;
    const existing = merged.get(key);
    if (existing) {
      existing.money += row.money;
      existing.tokens += row.tokens;
    } else {
      merged.set(key, { ...row });
    }
  }
  const used = [...merged.values()].filter((row) => row.money > 0 || row.tokens > 0);
  const byMoney = [...used].sort((a, b) => b.money - a.money || b.tokens - a.tokens).slice(0, limit);
  const byTokens = [...used].sort((a, b) => b.tokens - a.tokens || b.money - a.money).slice(0, limit);
  return [...byMoney, ...byTokens.filter((row) => !byMoney.includes(row))];
}

export { HARNESS_ORDER as MENUBAR_HARNESS_ORDER };
