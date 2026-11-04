/**
 * iPhone home-screen widget snapshot, projected from the quota overview's panel view.
 *
 * Pure: the widget shows exactly what a panel shows (same sources, order, masking and money
 * basis), so it reuses the built view instead of reading usage a second time.
 */

import type {
  MobileUsageWidgetSnapshot,
  MobileUsageWidgetSource,
} from '@cindy/maker-shared/device-link-contract';

import type { MenubarView } from '../../shared/menubarQuota.js';
import { familyLogo, MENUBAR_CINDY_LOGO } from '../menubar/logos.js';
import type { MenubarFamily, MenubarModelSeries } from '../menubar/snapshot.js';

const WIDGET_DAYS = 30;
const FAMILIES: MenubarFamily[] = ['claude', 'codex', 'grok', 'kimi'];

/** Panel strings the widget needs, plus the duration templates for live countdowns. */
const UI_KEYS = [
  'today', 'dailyAverage', 'paid', 'tokenUnit', 'noUsage', 'scopeLocal', 'scopeAll',
  'monthScopeLocal', 'monthScopeAll', 'updatedJustNow', 'updatedMinutes', 'updatedHours', 'updatedDays',
  'harness.claude-code', 'harness.codex', 'harness.pi',
];
const DURATION_KEYS = ['daysHours', 'days', 'hoursMinutes', 'hours', 'minutes'];

export function buildUsageWidgetSnapshot(
  view: MenubarView,
  nowMs: number,
  raw: (key: string) => string | null,
  series?: MenubarModelSeries,
): MobileUsageWidgetSnapshot | null {
  if (view.gate) return null;
  const logoOf = new Map<string, MobileUsageWidgetSource['logo']>(
    FAMILIES.map(family => [familyLogo(family), family]),
  );
  logoOf.set(MENUBAR_CINDY_LOGO, 'cindy');
  const sources: MobileUsageWidgetSource[] = [];
  for (const cell of view.sources) {
    // Pay-as-you-go and unread sources have no level; the panel lists them as rows, not tubes.
    if (cell.kind === 'payg' || cell.fill === null) continue;
    const detail = view.details[cell.id];
    sources.push({
      id: cell.id,
      kind: cell.kind,
      name: cell.name,
      logo: logoOf.get(cell.logoSvg) ?? null,
      monogram: [...cell.name.trim()][0]?.toUpperCase() ?? '?',
      value: cell.value,
      unit: cell.valueUnit,
      label: cell.valueLabel,
      level: cell.level,
      fill: cell.fill,
      reserve: cell.reserve,
      emphasized: cell.emphasized,
      when: cell.when,
      resetsAtMs: cell.resetsAtMs ?? null,
      ...(cell.stale ? { stale: true } : {}),
      ...(cell.unusedAtReset ? { unusedAtReset: true } : {}),
      ...(detail ? {
        detail: {
          title: detail.title,
          plan: detail.plan,
          rings: detail.rings,
          bigValue: detail.bigValue,
          bigUnit: detail.bigUnit,
          bigColor: detail.bigColor,
          bigCompact: detail.bigCompact,
          bigCaption: detail.bigCaption,
          legend: detail.legend,
        },
      } : {}),
    });
  }
  const scope = view.settings.scope;
  const data = view.usage.scopes[scope] ?? view.usage.scopes.all;
  const count = Math.min(view.usage.days.length, data?.daily.length ?? 0, WIDGET_DAYS);
  // Same days as the view; the series is collected alongside it, so it only lines up when its length matches.
  const seriesDaily = series && series.daily.length === view.usage.days.length && count > 0
    ? series.daily.slice(-count) : undefined;
  const seriesTokens = seriesDaily ? series!.tokens.slice(-count) : undefined;
  const strings: Record<string, string> = {};
  for (const key of UI_KEYS) {
    const value = view.strings[key];
    if (value !== undefined) strings[key] = value;
  }
  for (const key of DURATION_KEYS) {
    const value = raw(`menubar.durationShort.${key}`);
    if (value !== null) strings[`durationShort.${key}`] = value;
  }
  const resetsIn = raw('menubar.cell.resetsIn');
  if (resetsIn !== null) strings.resetsIn = resetsIn;
  return {
    version: 1,
    generatedAtMs: nowMs,
    updatedAtMs: view.updatedAtMs,
    locale: view.locale,
    moneySymbol: view.moneySymbol,
    sources,
    usage: {
      scope,
      days: count > 0 ? view.usage.days.slice(-count) : [],
      daily: count > 0 && data ? data.daily.slice(-count).map((day, i) => {
        const models = seriesDaily?.[i];
        const modelTokens = seriesTokens?.[i];
        return { money: day.money, paid: day.paid, tokens: day.tokens, ...(models && modelTokens ? { models, modelTokens } : {}) };
      }) : [],
      ...(seriesDaily ? { models: series!.models } : {}),
    },
    strings,
  };
}
