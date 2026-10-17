import { describe, expect, it } from 'vitest';

import { DEFAULT_MENUBAR_SETTINGS, type MenubarSettings } from '../../../shared/menubarQuota';
import type { SupportedLocale } from '../../../shared/locale';
import { mainStringKeysUnder, rawMainString } from '../../i18n';
import { familyLogo, MENUBAR_CINDY_LOGO, MENUBAR_HARNESS_LOGOS } from '../logos';
import {
  buildMenubarView,
  isLowOnEverything,
  type MenubarBuildInput,
  type MenubarSourceInput,
  type MenubarSubscriptionInput,
} from '../snapshot';
import { buildMenubarUiStrings, createMenubarTranslate, fillTemplate } from '../strings';

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
  it('recommends the source with the most room and outlines its tube', () => {
    const view = buildMenubarView(input([codex('alpha', 80), codex('beta', 20)]));
    expect(view.headlinePrimary).toBe('beta has the most left.');
    const beta = view.sources.find((s) => s.id === 'beta');
    expect(beta).toMatchObject({ value: '80', valueUnit: '%', level: 'normal', fill: 0.8, emphasized: true });
    expect(view.sources.find((s) => s.id === 'alpha')?.emphasized).toBe(false);
  });

  it('marks a nearly empty window as a warning', () => {
    const view = buildMenubarView(input([codex('alpha', 93)]));
    expect(view.sources[0]).toMatchObject({ value: '7', level: 'warn', fill: 0.07 });
  });

  it('hatches a used-up window that still has extra credits', () => {
    const view = buildMenubarView(input([codex('alpha', 100, { credits: 61_838 }), codex('beta', 10)]));
    const alpha = view.sources.find((s) => s.id === 'alpha');
    expect(alpha).toMatchObject({ value: null, reserve: true, fill: 0, level: 'error' });
    expect(view.details.alpha.action).toEqual({ kind: 'new-task', providerId: 'codex-alpha' });
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

  it('shows an organization quota with its reset and sends it to Settings', () => {
    const quota: MenubarSourceInput = {
      kind: 'balance', id: 'cindy', logoSvg: MENUBAR_CINDY_LOGO, available: 19_996.38, fullAmount: 20_000,
      burnPerDay: null, observedAtMs: NOW, currency: 'USD', quota: { resetsAtMs: NOW + 20 * DAY + 3 * HOUR, todaySpend: 3.62 },
    };
    const view = buildMenubarView(input([quota], { locale: 'zh-CN' }));
    expect(view.sources[0]).toMatchObject({ when: '20天3时后重置' });
    expect(view.sources[0].fill).toBeCloseTo(0.9998);
    expect(view.headlinePrimary).toBe('Cindy 本期配额还能用。');
    expect(view.details.cindy).toMatchObject({ title: 'Cindy 本期配额', action: { kind: 'open-settings' } });
    expect(view.details.cindy.facts).toContainEqual({ label: '今日已用', value: '$3.62', sub: '每日建议 $3,000 以内' });
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
    expect(view.sources[0]).toMatchObject({ value: '90', when: '6天7时后重置', whenLevel: 'normal' });
    // Plenty left: the headline does not narrate a reset.
    expect(view.headlineSecondary).toBeNull();
  });

  it('names when a nearly empty source resets', () => {
    const low = codex('alpha', 92, {
      windows: [{ kind: 'session', usedPercent: 92, resetsAtMs: NOW + 3 * HOUR + 5 * 60_000, windowMinutes: 300 }],
    });
    const view = buildMenubarView(input([low, codex('beta', 20)]));
    expect(view.sources.find((cell) => cell.id === 'alpha')).toMatchObject({ when: 'Resets in 3h 5m', whenLevel: 'warn' });
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
