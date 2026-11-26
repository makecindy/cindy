import { describe, expect, it } from 'vitest';

import { DEFAULT_MENUBAR_SETTINGS, type MenubarSettings } from '../../../shared/menubarQuota';
import type { SupportedLocale } from '../../../shared/locale';
import { mainStringKeysUnder, rawMainString } from '../../i18n.desktop';
import { familyLogo, MENUBAR_CINDY_LOGO, MENUBAR_HARNESS_LOGOS } from '../logos';
import {
  buildMenubarView,
  isLowOnEverything,
  type MenubarBuildInput,
  type MenubarSourceInput,
  type MenubarSubscriptionInput,
} from '../snapshot';
import { buildMenubarUiStrings, createMenubarTranslate, fillTemplate } from '../strings';
import { buildAgentIslandQuota } from '../../agent-island/quota';
import { buildUsageWidgetSnapshot } from '../../quota-overview/widgetSnapshot';

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function codex(id: string, usedPercent: number, extra: Partial<MenubarSubscriptionInput> = {}): MenubarSubscriptionInput {
  return {
    kind: 'subscription',
    id,
    providerId: `codex-${id}`,
    family: 'codex',
    logoSvg: familyLogo('codex'),
    brand: 'Codex',
    account: `${id}@example.com`,
    plan: 'Pro',
    windows: [{ kind: 'week', usedPercent, resetsAtMs: NOW + 3 * DAY, windowMinutes: 10_080 }],
    credits: null,
    creditsUnlimited: false,
    prepaidUsd: null,
    updatedAtMs: NOW - 60_000,
    ...extra,
  };
}

function input(sources: MenubarSourceInput[], options: { locale?: SupportedLocale; settings?: Partial<MenubarSettings> } = {}): MenubarBuildInput {
  const locale = options.locale ?? 'en';
  const raw = (key: string) => rawMainString(key, locale);
  const days = Array.from({ length: 90 }, (_, i) => new Date(NOW - (89 - i) * DAY).toISOString().slice(0, 10));
  const daily = days.map(() => ({ money: [1, 1, 0] as [number, number, number], paid: 0, tokens: [10, 10, 0] as [number, number, number] }));
  const scope = { daily, models: { '7': [], '30': [], '90': [] }, devices: [{ name: 'Mac', isSelf: true, syncedAtMs: null }] };
  return {
    nowMs: NOW,
    locale,
    moneySymbol: '$',
    settings: { ...DEFAULT_MENUBAR_SETTINGS, ...options.settings },
    sources,
    tasks: [],
    usage: { days, scopes: { local: scope, all: scope } },
    updatedAtMs: NOW - 60_000,
    harnessLogos: MENUBAR_HARNESS_LOGOS,
    uiStrings: buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, locale),
    t: createMenubarTranslate(locale, raw),
  };
}

describe('buildMenubarView', () => {
  // Unit: selecting all devices must preserve the currency of local task rates, including the status item.
  it('keeps a two-dollar local task in USD while the all-device overview displays CNY', () => {
    const data = input([], { settings: { scope: 'all' } });
    data.moneySymbol = '¥';
    data.usage.scopes.local = { ...data.usage.scopes.local, currency: 'USD' };
    data.usage.scopes.all = { ...data.usage.scopes.all, currency: 'CNY' };
    data.tasks = [{ sessionId: 'one', title: 'Task', harness: 'codex', model: 'gpt', tokensToday: 10,
      valueToday: 2, contextPercent: null, running: true, startedAtMs: NOW, lastActiveAtMs: NOW }];
    const view = buildMenubarView(data);
    expect(view).toMatchObject({ moneySymbol: '¥', taskMoneySymbol: '$', tasks: [{ value: 2 }] });
    expect(view.statusTextByMode).toMatchObject({ task: '$2.00', today: '¥2.00' });
  });

  // #10110, unit: two accounts on one peer must have distinct labels in both panel and
  // widget. Provider-only fixtures could not catch identical device labels or a task
  // action falsely promising to pick the displayed pool account.
  it('names pooled peer accounts individually and keeps new-task actions at provider scope', () => {
    const peer = { id: 'peer', name: 'Same computer' };
    const sources = [codex('alpha', 80, { pooled: true, device: peer }), codex('beta', 20, { pooled: true, device: peer }),
      codex('local', 40, { pooled: true, providerId: 'openai' })];
    const view = buildMenubarView(input(sources, { settings: { privacy: false } }));
    expect(view.sources.map(source => source.name)).toEqual(expect.arrayContaining(['alpha', 'beta', 'local']));
    expect(view.details.local.action).toEqual({ kind: 'new-task', providerId: 'openai' });
    expect(view.details.local.actionLabel).not.toContain('local');
    expect(buildUsageWidgetSnapshot(view, NOW, key => rawMainString(key, 'en'))?.sources.map(source => source.name))
      .toEqual(expect.arrayContaining(['alpha', 'beta', 'local']));
    const privateView = buildMenubarView(input(sources, { settings: { privacy: true } }));
    expect(JSON.stringify(privateView)).not.toContain('alpha@example.com');
    expect(privateView.sources.find(source => source.id === 'alpha')?.name).toBe('a•••a');
  });

  // #10204 review / #10110, unit: different handles were covered above, but two
  // workspaces with the same email produced an ambiguous recommendation and widget.
  // Exercise the real panel/widget projections, including privacy and missing plans.
  it.each([false, true])('distinguishes pooled workspaces by plan in every short label (privacy=%s)', privacy => {
    const sources = [codex('personal', 80, { pooled: true, account: 'same@example.com', plan: 'Plus' }),
      codex('work', 20, { pooled: true, account: 'same@example.com', plan: 'Team' })];
    const view = buildMenubarView(input(sources, { settings: { privacy } }));
    const handle = privacy ? 's•••e' : 'same';
    const names = [`Plus · ${handle}`, `Team · ${handle}`];
    expect(view.sources.map(source => source.name)).toEqual(names);
    expect(view.headlinePrimary).toBe(`${names[1]} has the most left.`);
    expect(view.manage.map(source => source.title)).toEqual(names);
    expect(buildUsageWidgetSnapshot(view, NOW, key => rawMainString(key, 'en'))?.sources.map(source => source.name)).toEqual(names);
    if (privacy) expect(JSON.stringify(view)).not.toContain('same@example.com');
  });

  it.each(['Team', null])('keeps same-name pool labels distinct and stable when plans match (%s)', plan => {
    const sources = [codex('pool-a', 80, { pooled: true, account: 'same@example.com', plan }),
      codex('pool-b', 20, { pooled: true, account: 'same@example.com', plan })];
    const namesById = (view: ReturnType<typeof buildMenubarView>) => Object.fromEntries(view.sources.map(source => [source.id, source.name]));
    const view = buildMenubarView(input(sources));
    const prefix = plan ? `${plan} ` : '';
    expect(namesById(view)).toEqual({ 'pool-a': `${prefix}1 · same`, 'pool-b': `${prefix}2 · same` });
    const reordered = buildMenubarView(input([...sources].reverse(), { settings: { order: ['pool-b', 'pool-a'] } }));
    expect(namesById(reordered)).toEqual(namesById(view));
    expect(reordered.headlinePrimary).toBe(`${prefix}2 · same has the most left.`);
  });

  it('recommends the source with the most room and outlines its tube', () => {
    const view = buildMenubarView(input([codex('alpha', 80), codex('beta', 20)]));
    expect(view.headlinePrimary).toBe('beta has the most left.');
    const beta = view.sources.find((s) => s.id === 'beta');
    expect(beta).toMatchObject({ value: '80', valueUnit: '%', level: 'normal', fill: 0.8, emphasized: true });
    expect(view.sources.find((s) => s.id === 'alpha')?.emphasized).toBe(false);
  });

  // Shared rule (quota-level): 30% or less left is yellow, 10% or less is red.
  it('turns yellow at 30% left and red at 10% left', () => {
    const view = buildMenubarView(input([codex('plenty', 69), codex('low', 70), codex('empty', 90)]));
    expect(view.sources.map((cell) => [cell.id, cell.value, cell.level])).toEqual([
      ['plenty', '31', 'normal'], ['low', '30', 'warn'], ['empty', '10', 'error'],
    ]);
  });

  it('hatches a used-up window that still has extra credits', () => {
    const view = buildMenubarView(input([codex('alpha', 100, { credits: 61_838 }), codex('beta', 10)]));
    const alpha = view.sources.find((s) => s.id === 'alpha');
    expect(alpha).toMatchObject({ value: '61.8K', valueUnit: 'credits', reserve: true, fill: 0, level: 'error' });
    expect(alpha?.accessibilityLabel).toContain('61,838');
    // PR #8622: the new value/unit shape must stay readable through the real island projection.
    // Unit tier; old hand-built island fixtures missed the minimal 61_838-credit regression.
    expect(buildAgentIslandQuota(view).find((item) => item.id === 'alpha')?.text).toBe('61.8K credits');
    expect(view.details.alpha.action).toEqual({ kind: 'new-task', providerId: 'codex-alpha' });
  });

  // Regression: exhausted subscriptions must expose the usable balance, never a
  // rounded zero or a percentage. The same values feed the mobile widget snapshot.
  it.each([
    { credits: 128, creditsUnlimited: false, value: '128' },
    { credits: 0.04, creditsUnlimited: false, value: '0.04' },
    { credits: null, creditsUnlimited: true, value: '∞' },
  ])('shows remaining credits in the panel and widget: $value', ({ value, ...credits }) => {
    const view = buildMenubarView(input([codex('alpha', 100, credits)]));
    expect(view.sources[0]).toMatchObject({ value, valueUnit: 'credits', fill: 0, reserve: true });
    const widget = buildUsageWidgetSnapshot(view, NOW, () => null);
    expect(widget?.sources[0]).toMatchObject({ value, unit: 'credits', fill: 0, reserve: true });
  });

  // PR #8622: buildMenubarView must expose fractional Credits to screen readers.
  // Existing unit coverage only checked an integer label; 0.0004 was read as zero.
  it.each([0.0004, 128.1234])('preserves fractional credit precision in accessibility labels: %s', (credits) => {
    const view = buildMenubarView(input([codex('alpha', 100, { credits })]));
    expect(view.sources[0].accessibilityLabel).toContain(`${credits} credits`);
  });

  it('follows the saved order and hides pay-as-you-go connections until shown', () => {
    const payg: MenubarSourceInput = { kind: 'payg', id: 'glm', providerId: 'glm', logoSvg: '', name: 'GLM', billing: 'api' };
    const sources = [codex('alpha', 10), codex('beta', 10), payg];
    const ordered = buildMenubarView(input(sources, { settings: { order: ['beta', 'alpha'] } }));
    expect(ordered.sources.map((s) => s.id)).toEqual(['beta', 'alpha']);
    expect(ordered.manage.find((row) => row.id === 'glm')?.hidden).toBe(true);
    const shown = buildMenubarView(input(sources, { settings: { shown: ['glm'] } }));
    expect(shown.sources.map((s) => s.id)).toContain('glm');
  });

  it('masks account names in privacy mode', () => {
    const view = buildMenubarView(input([codex('alpha', 10)], { settings: { privacy: true } }));
    expect(view.sources[0].name).not.toContain('alpha');
  });

  it('sends the balance detail to top-up instead of a new task', () => {
    const balance: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 12, fullAmount: 20,
      burnPerDay: 3, observedAtMs: NOW, currency: 'USD', quota: null,
    };
    const view = buildMenubarView(input([balance]));
    expect(view.details.cindy.action).toEqual({ kind: 'open-billing' });
    expect(view.sources[0].fill).toBeCloseTo(0.6);
  });

  // Unit: the public view builder must keep monthly quota while hiding disabled
  // daily limits; undefined is the pre-switch gateway contract.
  it.each([true, false, undefined])('shows quota details for dailyLimitEnabled=%s', (dailyLimitEnabled) => {
    const quota: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 19_996.38, fullAmount: 20_000,
      burnPerDay: null, observedAtMs: NOW, currency: 'USD', quota: { resetsAtMs: NOW + 20 * DAY + 3 * HOUR, todaySpend: 3.62, dailyLimitEnabled },
    };
    const view = buildMenubarView(input([quota], { locale: 'zh-CN' }));
    expect(view.sources[0]).toMatchObject({ when: '20天3时' });
    expect(view.sources[0].fill).toBeCloseTo(0.9998);
    expect(view.headlinePrimary).toBe('Cindy 本期配额还能用。');
    expect(view.details.cindy).toMatchObject({ title: 'Cindy 本期配额', action: { kind: 'open-settings' } });
    const dailyFact = view.details.cindy.facts.find(fact => fact.label === '今日已用');
    if (dailyLimitEnabled === false) expect(dailyFact).toBeUndefined();
    else expect(dailyFact).toEqual({ label: '今日已用', value: '$3.62', sub: '每日建议 $3,000 以内' });
  });

  it('splits a wallet into its pools and names the gift that expires first', () => {
    const wallet: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 17, fullAmount: 20,
      burnPerDay: 1, observedAtMs: NOW, currency: 'USD', quota: null,
      pools: { plan: 0, purchased: 12, promotional: 5 },
      promoExpiry: { amount: 5, expiresAtMs: NOW + 9 * DAY },
    };
    const facts = buildMenubarView(input([wallet])).details.cindy.facts;
    expect(facts.map((fact) => fact.label)).toEqual(['Balance', 'Daily spend', 'Runs out', 'Top-up balance', 'Promo balance', 'Used for']);
    expect(facts.find((fact) => fact.label === 'Promo balance')).toMatchObject({ value: '$5.00' });
    expect(facts.find((fact) => fact.label === 'Promo balance')?.sub).toMatch(/^Expires /);
  });

  it('offers a Codex reset when the window is used up and resets are left', () => {
    const view = buildMenubarView(input([codex('alpha', 100, { resetCredits: { count: 2, earliestExpiryMs: NOW + 5 * DAY } })]));
    const detail = view.details.alpha;
    expect(detail.saySecondary).toBe('2 resets are available; using one refills right away.');
    expect(detail.action).toEqual({ kind: 'open-settings' });
    expect(detail.facts).toContainEqual(expect.objectContaining({ label: 'Usage limit resets', value: '2 resets' }));
  });

  it('names an account on another computer by that computer and does not start a task on it', () => {
    const remote = codex('alpha', 30, {
      id: 'remote:dev-2:anthropic', account: null, device: { id: 'dev-2', name: 'Studio' },
    });
    const view = buildMenubarView(input([remote]));
    expect(view.sources[0].name).toBe('Studio');
    expect(view.manage[0].subtitle).toBe('Studio · Codex · Pro');
    expect(view.details[remote.id].action).toEqual({ kind: 'open-app' });
    expect(view.details[remote.id].facts).toContainEqual(expect.objectContaining({ label: 'Computer', value: 'Studio' }));
  });

  it('names a signed-in account on another computer by that computer, not the handle', () => {
    const remote = codex('alpha', 30, { id: 'remote:dev-2:openai', device: { id: 'dev-2', name: 'Studio' } });
    const view = buildMenubarView(input([remote]));
    expect(view.sources[0].name).toBe('Studio');
  });

  // Owner rule 2026-10-31: the reset time colors only when a long window will reset with quota
  // unused at the current pace — a day or less yellow, six hours or less red; numbers keep ink.
  it('colors the reset time when a long window will reset with quota unused', () => {
    const week = (id: string, used: number, leftMs: number, extra: Partial<MenubarSubscriptionInput> = {}) =>
      codex(id, used, { windows: [{ kind: 'week', usedPercent: used, resetsAtMs: NOW + leftMs, windowMinutes: 10_080 }], ...extra });
    const view = buildMenubarView(input([
      week('soon', 20, 5 * HOUR),
      week('tomorrow', 20, 20 * HOUR),
      week('later', 20, 2 * DAY),
      week('pace', 90, 20 * HOUR),
      week('low', 75, 5 * HOUR),
      codex('session', 20, { windows: [{ kind: 'session', usedPercent: 20, resetsAtMs: NOW + HOUR, windowMinutes: 300 }] }),
    ]));
    const levels = Object.fromEntries(view.sources.map((cell) => [cell.id, [cell.whenLevel, cell.unusedAtReset ?? false]]));
    expect(levels).toEqual({
      soon: ['error', true],
      tomorrow: ['warn', true],
      later: ['normal', true],
      // 90% used over ~6 days runs out before the reset: nothing goes to waste.
      pace: ['normal', false],
      // A yellow liquid still resets with a quarter unused at this pace: use it now.
      low: ['error', true],
      session: ['normal', false],
    });
    // The Cindy period quota is a budget: plenty left hours before its reset is not a reminder.
    const quota: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 38_000, fullAmount: 40_000, burnPerDay: 16,
      observedAtMs: NOW, currency: 'USD', quota: { resetsAtMs: NOW + 5 * HOUR, todaySpend: null },
    };
    expect(buildMenubarView(input([quota])).sources[0]).toMatchObject({ whenLevel: 'normal' });
    expect(buildMenubarView(input([quota])).sources[0].unusedAtReset).toBeUndefined();
  });

  it('shows an offline computer’s last reading with its age and never recommends it', () => {
    const offline = codex('alpha', 10, {
      id: 'remote:dev-2:openai', device: { id: 'dev-2', name: 'Studio' }, lastSeenAtMs: NOW - 3 * HOUR,
    });
    const view = buildMenubarView(input([offline, codex('beta', 70)]));
    expect(view.sources.find((s) => s.id === offline.id)).toMatchObject({
      value: '90', when: '3 hr ago', stale: true, resetsAtMs: null, emphasized: false,
    });
    expect(view.sources.find((s) => s.id === 'beta')?.emphasized).toBe(true);
  });

  it('does not call a positive offline reading "used up" when it is the only one', () => {
    const offline = codex('alpha', 10, {
      id: 'remote:dev-2:openai', device: { id: 'dev-2', name: 'Studio' }, lastSeenAtMs: NOW - 3 * HOUR,
    });
    const view = buildMenubarView(input([offline]));
    expect(view.headlinePrimary).toBe('Quota not read yet.');
    expect(view.headlineAlert).toBe(false);
    expect(view.statusTextByMode.lowest).toBeNull();
  });

  it('says nothing was read instead of "used up" when no level is known', () => {
    const unread = buildMenubarView(input([codex('alpha', 0, { windows: [] })]));
    expect(unread.headlinePrimary).toBe('Quota not read yet.');
    expect(unread.sources[0].fill).toBeNull();
    const empty = buildMenubarView(input([]));
    expect(empty.headlinePrimary).toBe('Nothing with a quota yet.');
    const usedUp = buildMenubarView(input([codex('alpha', 100)]));
    expect(usedUp.headlinePrimary).toBe('Everything is used up.');
  });

  it('carries the sign-in gate with no status text', () => {
    const view = buildMenubarView({ ...input([]), gate: 'sign-in' });
    expect(view.gate).toBe('sign-in');
    expect(Object.values(view.statusTextByMode).every((text) => text === null)).toBe(true);
    expect(view.strings.gateTitle).toBeTruthy();
    expect(buildMenubarView(input([codex('alpha', 10)])).gate).toBeUndefined();
  });

  it('counts down to the reset of the window each cell shows', () => {
    const claude = codex('alpha', 0, {
      windows: [
        { kind: 'session', usedPercent: 0, resetsAtMs: NOW + 4 * HOUR + 46 * 60_000, windowMinutes: 300 },
        { kind: 'week', usedPercent: 10, resetsAtMs: NOW + 6 * DAY + 7 * HOUR + 30 * 60_000, windowMinutes: 10_080 },
      ],
    });
    const view = buildMenubarView(input([claude], { locale: 'zh-CN' }));
    expect(view.sources[0]).toMatchObject({ value: '90', when: '6天7时', whenLevel: 'normal' });
    // Plenty left: the headline does not narrate a reset.
    expect(view.headlineSecondary).toBeNull();
  });

  it('shows every account by its weekly window, even when the 5-hour one is tighter or not started', () => {
    const idle = codex('alpha', 0, {
      windows: [
        { kind: 'session', usedPercent: 0, resetsAtMs: null, windowMinutes: 300 },
        { kind: 'week', usedPercent: 0, resetsAtMs: NOW + 4 * DAY + 22 * HOUR, windowMinutes: 10_080 },
      ],
    });
    const burst = codex('beta', 0, {
      windows: [
        { kind: 'session', usedPercent: 95, resetsAtMs: NOW + 2 * HOUR, windowMinutes: 300 },
        { kind: 'week', usedPercent: 40, resetsAtMs: NOW + 3 * DAY, windowMinutes: 10_080 },
      ],
    });
    const view = buildMenubarView(input([idle, burst], { locale: 'zh-CN' }));
    expect(view.sources.find((cell) => cell.id === 'alpha')).toMatchObject({ value: '100', when: '4天22时' });
    expect(view.sources.find((cell) => cell.id === 'beta')).toMatchObject({ value: '60', when: '3天', whenLevel: 'normal' });
  });

  it('keeps the detail page on the window that limits the account when the tube shows the weekly one', () => {
    const blocked = codex('alpha', 0, {
      resetCredits: { count: 1, earliestExpiryMs: NOW + 5 * DAY },
      windows: [
        { kind: 'session', usedPercent: 100, resetsAtMs: NOW + 2 * HOUR, windowMinutes: 300 },
        { kind: 'week', usedPercent: 40, resetsAtMs: NOW + 3 * DAY, windowMinutes: 10_080 },
      ],
    });
    const view = buildMenubarView(input([blocked]));
    expect(view.sources[0]).toMatchObject({ value: '60' });
    expect(view.details.alpha).toMatchObject({ bigValue: '0', action: { kind: 'open-settings' } });
  });

  it('names when a nearly empty source resets', () => {
    const low = codex('alpha', 92, {
      windows: [{ kind: 'session', usedPercent: 92, resetsAtMs: NOW + 3 * HOUR + 5 * 60_000, windowMinutes: 300 }],
    });
    const view = buildMenubarView(input([low, codex('beta', 20)]));
    expect(view.sources.find((cell) => cell.id === 'alpha')).toMatchObject({ when: '3h 5m', whenLevel: 'normal', level: 'error' });
    expect(view.headlineSecondary).toBe('alpha resets in 3h 5m.');
    expect(view.headlineAlert).toBe(true);
  });

  it('ripples only the tubes of sources a running task draws on', () => {
    const view = buildMenubarView(input([codex('alpha', 50, { consuming: true }), codex('beta', 20)]));
    expect(view.sources.map((cell) => [cell.id, cell.active])).toEqual([
      ['alpha', true],
      ['beta', false],
    ]);
    // Nothing is low, so the headline carries no warning mark.
    expect(view.headlineAlert).toBe(false);
  });

  it('localizes the headline', () => {
    const view = buildMenubarView(input([codex('alpha', 80), codex('beta', 20)], { locale: 'zh-CN' }));
    expect(view.headlinePrimary).toBe('beta 余量最足。');
  });
});

describe('isLowOnEverything', () => {
  it('is true only when every readable source is nearly empty', () => {
    expect(isLowOnEverything(input([codex('alpha', 95), codex('beta', 99)]))).toBe(true);
    expect(isLowOnEverything(input([codex('alpha', 95), codex('beta', 50)]))).toBe(false);
  });

  it('ignores sources it cannot read and stays quiet with nothing known', () => {
    const unread = codex('alpha', 0, { windows: [] });
    expect(isLowOnEverything(input([unread]))).toBe(false);
  });
});

describe('menubar strings', () => {
  it('fills known placeholders and leaves unknown ones visible', () => {
    expect(fillTemplate('{{a}} and {{b}}', { a: 1 })).toBe('1 and {{b}}');
  });

  it('picks plural variants by count', () => {
    const table: Record<string, string> = { 'menubar.x_one': 'one item', 'menubar.x_other': '{{count}} items' };
    const t = createMenubarTranslate('en', (key) => table[key] ?? null);
    expect(t('x', { count: 1 })).toBe('one item');
    expect(t('x', { count: 3 })).toBe('3 items');
    expect(t('missing')).toBe('menubar.missing');
  });

  it('sends plural families to the helper with both forms', () => {
    const table: Record<string, string> = { 'menubar.ui.n_one': 'a', 'menubar.ui.n_other': 'b', 'menubar.ui.plain': 'p' };
    const strings = buildMenubarUiStrings(['n_one', 'n_other', 'plain'], (key) => table[key] ?? null, 'en');
    expect(strings).toEqual({ n: 'b', n_one: 'a', n_other: 'b', plain: 'p' });
  });

  it('never takes a fallback-locale singular for locales without one', () => {
    const raw = (key: string) => rawMainString(key, 'zh-CN');
    const strings = buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, 'zh-CN');
    expect(strings.updatedMinutes_one).toBe(strings.updatedMinutes_other);
    expect(strings.updatedMinutes_one).not.toMatch(/Updated/);
  });
});

// Unit: new monthly Kimi limits must remain monthly in the actual native-panel VM.
it('projects Kimi monthly windows as remaining percentages with their real period label', () => {
  const view = buildMenubarView(input([codex('kimi', 0, {
    family: 'kimi', brand: 'Kimi Code', account: null, plan: null,
    windows: [{ kind: 'period', label: 'limit_month_code', usedPercent: 35, resetsAtMs: null, windowMinutes: 0 }],
  })]));
  expect(view.sources[0]).toMatchObject({ value: '65', valueUnit: '%', fill: 0.65 });
  expect(JSON.stringify(view.details.kimi)).toContain('Monthly Coding');
});

it('projects OpenCode Go rolling and monthly windows under its own provider', () => {
  const view = buildMenubarView(input([codex('opencode', 0, {
    family: 'opencode-go', logoSvg: familyLogo('opencode-go'), brand: 'OpenCode Go', account: null, plan: null,
    windows: [
      { kind: 'session', usedPercent: 30, resetsAtMs: NOW + 2 * 60 * 60_000, windowMinutes: 300 },
      { kind: 'period', label: 'monthly', usedPercent: 10, resetsAtMs: NOW + 20 * DAY, windowMinutes: 0 },
    ],
  })]));
  expect(view.sources[0]).toMatchObject({ id: 'opencode', name: 'OpenCode Go', value: '70', valueUnit: '%' });
  expect(JSON.stringify(view.details.opencode)).toContain('Monthly Total');
});

// iPhone widgets show the panel's tubes only: rows without a level stay out, and the reset
// time travels with each tube so the widget can keep the countdown current between refreshes.
describe('buildUsageWidgetSnapshot', () => {
  it('keeps measured sources in panel order with their logo and reset time', () => {
    const payg: MenubarSourceInput = { kind: 'payg', id: 'glm', providerId: 'glm', logoSvg: '', name: 'GLM', billing: 'api' };
    const view = buildMenubarView(input([codex('alpha', 30), payg, codex('beta', 95)]));
    const snapshot = buildUsageWidgetSnapshot(view, NOW, (key) => rawMainString(key, 'en'));
    expect(snapshot?.sources.map((s) => [s.id, s.logo, s.value, s.level, s.resetsAtMs])).toEqual([
      ['alpha', 'codex', '70', 'normal', NOW + 3 * DAY],
      ['beta', 'codex', '5', 'error', NOW + 3 * DAY],
    ]);
    expect(snapshot?.usage.days).toHaveLength(30);
    expect(snapshot?.usage.days.at(-1)).toBe(view.usage.days.at(-1));
    expect(snapshot?.strings['durationShort.daysHours']).toContain('{{d}}');
  });

  it('carries a period quota reset so the widget counts it down like the subscriptions', () => {
    const quota: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 20, fullAmount: 40, burnPerDay: null,
      observedAtMs: NOW, currency: 'USD', quota: { resetsAtMs: NOW + DAY, todaySpend: null },
    };
    const view = (source: MenubarSourceInput) => buildMenubarView(input([source]));
    const snapshot = buildUsageWidgetSnapshot(view(quota), NOW, () => null);
    expect(snapshot?.sources[0]).toMatchObject({ logo: 'cindy', resetsAtMs: NOW + DAY });
    // A lone source is drawn as the panel's detail ring.
    expect(snapshot?.sources[0].detail).toMatchObject({ bigValue: view(quota).details.cindy.bigValue, rings: [{ fraction: 0.5 }] });
  });

  it('has nothing to show behind the sign-in gate', () => {
    const view = buildMenubarView({ ...input([]), gate: 'sign-in' });
    expect(buildUsageWidgetSnapshot(view, NOW, () => null)).toBeNull();
  });
});

// Shared quota details are read-only and must not offer a local task on the host's provider id.
it('shows the account-wide sharing notice and no local subscription management actions', () => {
  const source = codex('share:one', 54, {
    family: 'shared', account: null, brand: 'Claude', plan: 'Shared',
    shared: { label: 'Claude', note: 'Account-wide allowance' },
  });
  const view = buildMenubarView(input([source]));
  expect(view.sources[0]).toMatchObject({ value: '46', name: 'Claude' });
  expect(view.details[source.id]).toMatchObject({ plan: 'Shared', saySecondary: 'Account-wide allowance', action: { kind: 'open-app' } });
  expect(view.details[source.id].facts.some(fact => /credits|resets left/i.test(fact.label))).toBe(false);
});

// Equal provider labels must remain distinguishable by the names already present in the
// received-share directory; anonymous quota account identity stays undisclosed.
it('distinguishes shares of the same provider by their sharers', () => {
  const sources = ['dash', 'Chris'].map(name => codex(`share:${name}`, 18, {
    family: 'shared', account: null, brand: 'Anthropic', plan: 'Shared',
    shared: { label: name, ownerName: name, note: 'Account-wide allowance' },
  }));
  const view = buildMenubarView(input(sources));
  expect(view.sources.map(source => source.name)).toEqual(['dash', 'Chris']);
  expect(view.details['share:dash'].title).toBe('dash · Anthropic');
  expect(view.details['share:Chris'].title).toBe('Chris · Anthropic');
  expect(view.details['share:dash'].facts).toContainEqual(expect.objectContaining({ label: 'Shared by dash' }));
});

// Unit regression: new share identity bypassed the existing privacy setting in native
// cells/headlines/manage/detail facts. Exercise both detail branches and legacy label-only input.
it.each(['ready', 'no-windows', 'label-only'])('hides sharer identity across the native view in privacy mode (%s)', kind => {
  const source = codex('share:one', 18, {
    family: 'shared', account: null, brand: 'Anthropic', plan: 'Shared',
    shared: { label: 'Private sharer', ownerName: kind === 'label-only' ? undefined : 'Private sharer', note: 'Account-wide allowance' },
    ...(kind === 'no-windows' ? { windows: [] } : {}),
  });
  const visible = buildMenubarView(input([source]));
  expect(visible.sources[0].name).toBe('Private sharer');
  const hidden = buildMenubarView(input([source], { settings: { privacy: true } }));
  expect(hidden.sources[0].name).toBe('Anthropic');
  expect(hidden.manage.find(row => row.id === source.id)?.title).toBe('Anthropic');
  expect(hidden.details[source.id].title).toBe('Anthropic');
  expect(hidden.details[source.id].facts).toContainEqual(expect.objectContaining({ label: 'Anthropic' }));
  expect(hidden.sources[0].value).toBe(visible.sources[0].value);
  expect(JSON.stringify(hidden)).not.toContain('Private sharer');
  // Projection must not overwrite the received name or lose it when privacy is turned off.
  expect(buildMenubarView(input([source]))).toEqual(visible);
});

// Unit: plugin engines may report custom percentage windows, currency balances, or both;
// all forms must project cleanly into the menu bar panel, management rows, low-quota check,
// and the shared mobile/desktop widget snapshot. Minimal failing input: balance-only plugin
// falls through to fill=null and disappears from tubes/widgets.
describe('plugin engine menubar and widget projection', () => {
  it('renders custom window labels and balance facts for a plugin engine with windows + balance', () => {
    const source: MenubarSubscriptionInput = {
      kind: 'subscription',
      id: 'acp-plugin:dsh:dsh',
      providerId: 'acp-plugin:dsh:dsh',
      family: 'plugin',
      logoSvg: familyLogo('plugin'),
      brand: 'DeepSeek Harness',
      account: null,
      plan: null,
      windows: [
        { kind: 'custom', label: 'Pro quota', usedPercent: 25, resetsAtMs: NOW + 2 * DAY, windowMinutes: 0 },
        { kind: 'custom', label: 'Fast lane', usedPercent: 60, resetsAtMs: NOW + 3 * HOUR, windowMinutes: 0 },
      ],
      balances: [{ currency: 'CNY', amount: 42.5 }],
      credits: null,
      creditsUnlimited: false,
      prepaidUsd: null,
      updatedAtMs: NOW - 60_000,
    };
    const view = buildMenubarView(input([source]));
    expect(view.sources[0]).toMatchObject({ id: source.id, name: 'DeepSeek Harness', value: '40', valueUnit: '%', fill: 0.4 });
    expect(view.details[source.id]).toMatchObject({
      title: 'DeepSeek Harness',
      bigValue: '40',
      bigUnit: '%',
      action: { kind: 'new-task', providerId: source.providerId },
    });
    expect(view.details[source.id].legend.map((item) => item.label)).toEqual(['Pro quota 75%', 'Fast lane 40%']);
    expect(view.details[source.id].facts).toContainEqual(expect.objectContaining({ value: '¥42.50' }));
    const widget = buildUsageWidgetSnapshot(view, NOW, () => null);
    expect(widget?.sources[0]).toMatchObject({ id: source.id, kind: 'subscription', name: 'DeepSeek Harness', monogram: 'D', value: '40', unit: '%', fill: 0.4 });
  });

  // #12709, unit: the existing mixed-quota case checks percentages, but a missing
  // duration cannot establish pace. Only the limiting window belongs in the plugin copy.
  it('describes the limiting plugin window using the timing evidence available', () => {
    const other = { kind: 'custom' as const, label: 'Week', usedPercent: 0, resetsAtMs: NOW + DAY, windowMinutes: 10_080 };
    const fast = { ...other, label: 'Fast', usedPercent: 15, resetsAtMs: NOW + 3 * HOUR, windowMinutes: 0 };
    const detail = (window: MenubarSubscriptionInput['windows'][number], family: MenubarSubscriptionInput['family'] = 'plugin') =>
      buildMenubarView(input([codex('source', 0, { family, windows: [window, other] })])).details.source;
    const unknown = detail(fast);
    const at = unknown.facts[0].value;
    expect(unknown).toMatchObject({ sayPrimary: 'Fast is lowest; ', saySecondary: `refills ${at}.` });
    expect(detail({ ...fast, resetsAtMs: null })).toMatchObject({ sayPrimary: 'Fast is lowest; ', saySecondary: null });
    expect(detail({ ...fast, windowMinutes: 300 })).toMatchObject({
      sayPrimary: 'Plenty of room at this pace.', saySecondary: `Fast refills ${at}.`,
    });
    expect(detail({ ...fast, usedPercent: 40, windowMinutes: 300 })).toMatchObject({
      sayPrimary: 'On pace.', saySecondary: `Fast refills ${at}.`,
    });
    expect(detail({ ...fast, usedPercent: 0 })).toMatchObject({ sayPrimary: 'Full.', saySecondary: null });
    expect(detail(fast, 'claude')).toMatchObject({ sayPrimary: 'On pace.', saySecondary: expect.stringContaining('Week window refreshes') });
  });

  function viewWithPools(groups: (string | undefined)[], family: MenubarSubscriptionInput['family'] = 'plugin') {
    const windows: MenubarSubscriptionInput['windows'] = groups.map((group, i) => ({
      kind: 'custom', label: `Quota · ${i}`, windowMinutes: i % 2 ? 300 : 10_080,
      usedPercent: i + 1, resetsAtMs: NOW + (i + 1) * HOUR, ...(group ? { group } : {}),
    }));
    return buildMenubarView(input([codex('source', 0, { family, windows })]));
  }

  // #12709: an oversized pool cannot fit in the two-ring detail. Its windows must all
  // survive on the legacy path, including at the protocol limit of 24.
  it('retains the complete ungrouped view for incomplete, oversized and unsupported pool layouts', () => {
    const pairs = (perPool: number) => Array.from({ length: 2 * perPool }, (_, i) => i < perPool ? 'A' : 'B');
    for (const groups of [
      [undefined, undefined], ['A', 'A'], ['A', 'B', 'C'], ['A', 'B', undefined],
      ['A', 'A', 'A', 'B'], ['A', 'B', 'B', 'B'], pairs(5), pairs(12),
    ]) {
      const legacy = viewWithPools(groups.map(() => undefined));
      expect(legacy.details.source).not.toHaveProperty('groups');
      expect(JSON.stringify(viewWithPools(groups))).toBe(JSON.stringify(legacy));
    }
    expect(JSON.stringify(viewWithPools(['A', 'B', 'A', 'B'], 'claude')))
      .toBe(JSON.stringify(viewWithPools(Array(4).fill(undefined), 'claude')));
  });

  it.each([
    { groups: ['A', 'B'], colors: [['poolBlue'], ['poolRed']] },
    { groups: ['A', 'B', 'B'], colors: [['poolBlue'], ['poolRed', 'poolRed2']] },
    { groups: ['A', 'B', 'A'], colors: [['poolBlue', 'poolBlue2'], ['poolRed']] },
  ])('gives each pool one ring per reported window: $groups', ({ groups, colors }) => {
    const detail = viewWithPools(groups).details.source;
    expect(detail.groups?.map(group => group.rings.map(ring => ring.color))).toEqual(colors);
    expect(detail.rings).toHaveLength(groups.length);
  });

  // #12709: in German the full weekly label would truncate the percentage in the
  // two-pool legend. The caption, reset tiles and legacy legend still have room.
  it('uses the German short week label only in the two-pool legend', () => {
    const detail = (secondPool: string) => {
      const windows: MenubarSubscriptionInput['windows'] = ['First', secondPool].map(group => ({
        kind: 'custom', group, label: group + ' · Wöchentlich', windowMinutes: 10_080,
        usedPercent: 12, resetsAtMs: NOW + DAY,
      }));
      return buildMenubarView(input([codex('source', 0, { family: 'plugin', windows })], { locale: 'de' })).details.source;
    };
    const grouped = detail('Second');
    expect(grouped.legend.map(entry => entry.label)).toEqual(['First Woche 88%', 'Second Woche 88%']);
    for (const group of grouped.groups!) {
      expect(group.bigCaption).toBe('Wöchentlich übrig');
      expect(group.facts[0].label).toBe('Wöchentlich wird zurückgesetzt');
    }
    const singlePool = detail('First');
    expect(singlePool.groups).toBeUndefined();
    expect(singlePool.legend.map(entry => entry.label)).toEqual(['First · Wöchentlich 88%', 'First · Wöchentlich 88%']);
  });

  // #12709: custom periods have no sortable duration, and balances belong to the account.
  it('keeps unknown periods last and account facts outside the quota pools', () => {
    const window = (group: string, label: string, windowMinutes: number) =>
      ({ group, label, windowMinutes, kind: 'custom' as const, usedPercent: 20, resetsAtMs: NOW + HOUR });
    const source = codex('source', 0, { family: 'plugin', balances: [{ currency: 'USD', amount: 5 }],
      device: { id: 'peer', name: 'MacBook Pro' },
      windows: [window('First', 'First · monthly', 0), window('Second', 'Custom', 0),
        window('First', 'Week', 10_080), window('Second', 'Session', 300)] });
    const detail = buildMenubarView(input([source])).details.source;
    const [first, second] = detail.groups!;
    expect(first.legend.map(entry => [entry.label, entry.color])).toEqual([
      ['First Weekly 80%', 'poolBlue'], ['First monthly 80%', 'poolBlue2'],
    ]);
    expect(first.facts.map(fact => fact.label)).toEqual(['Weekly resets', 'monthly resets']);
    expect(second.legend.map(entry => entry.label)).toEqual(['Second 5-hour 80%', 'Second Custom 80%']);
    expect(second.facts.map(fact => fact.label)).toEqual(['5-hour resets', 'Custom resets']);
    // Swift skips exactly these top-level reset facts before drawing the account-wide tiles.
    const labels = ['First Weekly resets', 'First monthly resets', 'Second 5-hour resets', 'Second Custom resets'];
    const pooled = [...first.facts, ...second.facts];
    expect(detail.facts.slice(0, pooled.length)).toEqual(pooled.map((fact, i) => ({ ...fact, label: labels[i] })));
    expect(detail.facts.slice(pooled.length)).toEqual([
      expect.objectContaining({ label: 'Balance', value: '$5.00' }),
      expect.objectContaining({ label: 'Computer', value: 'MacBook Pro' }),
      expect.objectContaining({ label: 'Account' }),
    ]);
  });

  it('renders a balance-only plugin engine as a filled tube and keeps it in widgets and low-quota checks', () => {
    const positive: MenubarSubscriptionInput = {
      kind: 'subscription',
      id: 'acp-plugin:gem:cli',
      providerId: 'acp-plugin:gem:cli',
      family: 'plugin',
      logoSvg: familyLogo('plugin'),
      brand: 'Gemini CLI',
      account: null,
      plan: null,
      windows: [],
      balances: [{ currency: 'USD', amount: 12.5 }],
      credits: null,
      creditsUnlimited: false,
      prepaidUsd: null,
      updatedAtMs: NOW - 60_000,
    };
    const view = buildMenubarView(input([positive]));
    expect(view.sources[0]).toMatchObject({ id: positive.id, name: 'Gemini CLI', value: '$12.50', valueUnit: null, fill: 1, level: 'normal' });
    expect(view.details[positive.id]).toMatchObject({ bigValue: '$12.50', bigUnit: null, rings: [{ fraction: 1, color: 'ink' }] });
    expect(view.manage[0]).toMatchObject({ id: positive.id, value: '$12.50' });
    expect(isLowOnEverything(input([positive]))).toBe(false);
    const widget = buildUsageWidgetSnapshot(view, NOW, () => null);
    expect(widget?.sources[0]).toMatchObject({ id: positive.id, kind: 'subscription', value: '$12.50', unit: null, fill: 1 });

    const depleted: MenubarSubscriptionInput = { ...positive, balances: [{ currency: 'USD', amount: 0 }] };
    const depletedView = buildMenubarView(input([depleted]));
    expect(depletedView.sources[0]).toMatchObject({ value: '$0.00', fill: 0, level: 'error' });
    expect(isLowOnEverything(input([depleted]))).toBe(true);
  });
});
