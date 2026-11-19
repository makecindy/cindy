// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import type { MobileUsageWidgetSnapshot as Snapshot, MobileUsageWidgetSource as Source } from '@cindy/maker-shared/device-link-contract';
import { UsageQuotaColumns } from '@/widgets/UsageQuotaColumns';
import { DrawerUsage, UsageDashboard } from '@/widgets/UsageDashboard';

const auth = vi.hoisted(() => ({ user: { membershipKind: 'personal' } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
const sync = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('@/widgets/usageWidgetSync', () => ({
  automaticUsageState: () => sync.state, readUsageWidgetStore: () => null, subscribeUsageWidgetStore: () => () => {},
}));
vi.mock('@/session/MobileProviderMark', () => ({ MobileProviderMark: () => null }));
// Reduce Motion as the phone last reported it; null is "not known yet".
const motion = vi.hoisted(() => ({ reduced: true as boolean | null }));
vi.mock('@/hooks/useReduceMotion', () => ({ getCachedReduceMotionEnabled: () => motion.reduced }));
// Worklets run inline: the first frame of an animated prop is what a static render shows.
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useSharedValue: (value: unknown) => ({ value }), useAnimatedProps: (props: () => unknown) => props(),
  withTiming: (value: unknown) => value, cancelAnimation: () => {}, Easing: { linear: null },
}));
vi.mock('react-native-svg', () => ({
  default: ({ opacity, children }: { opacity?: number; children?: ReactNode }) => <i data-tube-opacity={opacity}>{children}</i>,
  G: ({ children }: { children?: ReactNode }) => children,
  // The well and the liquid are both Rects; the liquid is drawn last.
  Rect: ({ fill, fillOpacity }: { fill?: string; fillOpacity?: number }) => <b data-liquid={fill} data-liquid-opacity={fillOpacity} />,
  // The hatch of a reserve tube is a plain Path; only the opening liquid has animated props.
  Path: ({ animatedProps }: { animatedProps?: { d: string } }) => animatedProps ? <u data-opening={animatedProps.d} /> : null,
  Defs: () => null, ClipPath: () => null, LinearGradient: () => null, Stop: () => null,
}));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('react-native', () => ({
  // Chart segments carry their series color as an inline background.
  View: ({ children, style }: { children?: ReactNode; style?: { backgroundColor?: string } }) =>
    <div data-fill={style?.backgroundColor}>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  StyleSheet: { create: (styles: unknown) => styles },
}));
// Every theme color resolves to its own token name, so assertions can name colors.
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: (_, token) => token }) }), useThemedStyles: () => ({}),
}));

const subscription: Source = { id: 'plan', kind: 'subscription', name: 'Claude Pro', logo: null,
  monogram: 'C', value: '68', unit: '%', label: null, level: 'normal', fill: 0.68, reserve: false,
  emphasized: false, when: '', resetsAtMs: null };
const wallet: Source = { ...subscription, id: 'money', kind: 'balance', name: 'Cindy balance', value: '$0.00', unit: null };
function snapshotOf(sources: Source[], extra: Partial<Snapshot> = {}): Snapshot {
  return { version: 1, generatedAtMs: Date.now(), updatedAtMs: null, locale: 'en', moneySymbol: '$',
    sources, usage: { scope: 'local', days: [], daily: [] }, strings: { today: 'Today' }, ...extra };
}
function render(membershipKind: string, sources: Source[]) {
  auth.user.membershipKind = membershipKind;
  return renderToStaticMarkup(<UsageDashboard snapshot={snapshotOf(sources)} />);
}

// The widget uses the same source kind for a period budget and a personal wallet.
// Exercise UsageDashboard/UsageQuotaColumns output (unit): one subscription with
// value 68 and unit % must display 68%, and an org wallet must display a budget.
// SSR splits the value/unit across nested Text elements, so parse its text rather
// than stripping tags with a regex (CodeQL #522). DOMParser keeps scripts inert.
// Standalone Vitest wall time: 1.91s (2026-11-19); five existing cases, no new test.
describe('usage overview for different account types', () => {
  it('shows a plan without inventing an account balance', () => {
    const html = render('personal', [subscription]);
    expect(new DOMParser().parseFromString(html, 'text/html').body.textContent).toContain('68%');
    expect(html).not.toMatch(/balance|usageBudget/i);
  });
  it('shows a real zero wallet after usage', () => {
    const html = render('personal', [wallet]);
    expect(html).toContain('$0.00');
    expect(html.indexOf('Cindy balance')).toBeGreaterThan(html.indexOf('Today'));
    expect(html).not.toContain('devices.usagePlans');
  });
  it('labels the organization amount as a budget, even with a generic legacy source name', () => {
    const html = render('org', [subscription, wallet]);
    expect(html).toContain('devices.usageBudget');
    expect(html).not.toContain('Cindy balance');
    expect(render('org', [subscription])).not.toContain('devices.usageBudget');
  });
});

describe('widget quota countdowns', () => {
  const strings = {
    'durationShort.days': '{{d}}d',
    'durationShort.daysHours': '{{d}}d {{h}}h',
    resetsIn: 'Resets in {{duration}}',
  };
  function columns(source: Source, compact = false) {
    return renderToStaticMarkup(<UsageQuotaColumns sources={[source]} strings={strings} compact={compact} />);
  }
  it('uses the reset deadline in both layouts and rounds compact durations to the largest unit', () => {
    const source = { ...subscription, when: 'old time', resetsAtMs: Date.now() + 36 * 3_600_000 + 30_000 };
    expect(columns(source)).toContain('Resets in 1d 12h');
    expect(columns(source, true)).toContain('>1d<');
  });
  it('keeps the offline reading age and waits for a fresh reading after a reset', () => {
    const source = { ...subscription, when: 'Offline 3h', resetsAtMs: Date.now() - 60_000 };
    expect(columns({ ...source, stale: true })).toContain('Offline 3h');
    expect(columns(source)).toContain('session.menu.usage.awaitingRefresh');
  });
});

// Both cases enter through the rendered drawer card and details page (unit, shared cost with the
// file above). The age is judged on the phone: a computer that went offline cannot mark its own
// last snapshot as old, so this cannot be covered from the snapshot builder.
describe('old readings', () => {
  const strings = { today: 'Today', updatedHours: 'Updated {{n}}h ago' };
  function views(ageMs: number) {
    const snapshot = snapshotOf([subscription], { updatedAtMs: Date.now() - ageMs, strings });
    sync.state = { kind: 'snapshot', snapshot, deviceName: 'Studio' };
    return [renderToStaticMarkup(<DrawerUsage onOpen={() => {}} />), renderToStaticMarkup(<UsageDashboard snapshot={snapshot} />)];
  }
  it('says how old the plan readings are and dims the tubes once they are an hour old', () => {
    for (const html of views(3 * 3_600_000 + 5_000)) {
      expect(html).toContain('Updated 3h ago');
      expect(html).toContain('data-tube-opacity="0.45"');
    }
  });
  it('shows current readings without a notice', () => {
    for (const html of views(59 * 60_000)) {
      expect(html).not.toContain('h ago');
      expect(html).toContain('data-tube-opacity="1"');
    }
  });
});

// The details page (unit): the daily bars and the share list must describe the same series.
describe('model shares', () => {
  function page(models: string[], modelTokens: number[]) {
    const usage: Snapshot['usage'] = { scope: 'local', days: ['2026-11-19'],
      models: models.map(name => ({ name, harness: 'codex' as const })),
      daily: [{ money: [0, 0, 0], paid: 0, tokens: [sumOf(modelTokens), 0, 0], models: modelTokens.map(() => 0), modelTokens }] };
    const html = renderToStaticMarkup(<UsageDashboard snapshot={snapshotOf([], { usage })} />);
    const body = new DOMParser().parseFromString(html, 'text/html').body;
    return { text: body.textContent ?? '', fills: [...body.querySelectorAll('[data-fill]')].map(node => node.getAttribute('data-fill')) };
  }
  const sumOf = (values: number[]) => values.reduce((a, b) => a + b, 0);
  it('merges everything past the three largest models into one grey Other, in the bars too', () => {
    // Five models and an empty remainder: the fourth and fifth palette colors must not be drawn.
    const { text, fills } = page(['A', 'B', 'C', 'D', 'E'], [50, 40, 30, 20, 10, 0]);
    expect(new Set(fills)).toEqual(new Set(['taskTagTeal', 'taskTagPink', 'taskTagPurple', 'taskTagGray']));
    expect(fills.filter(fill => fill === 'taskTagGray')).toHaveLength(2); // one bar segment, one list dot
    expect(text).toContain('devices.usageOther');
    expect(text).toContain('20% · 30'); // D + E
    expect(text).not.toMatch(/[DE]\d/);
  });
  it('lists four series as they are', () => {
    const { text, fills } = page(['A', 'B', 'C'], [50, 40, 30, 20]);
    expect(new Set(fills)).toEqual(new Set(['taskTagTeal', 'taskTagPink', 'taskTagPurple', 'taskTagGray']));
    expect(text).toContain('14% · 20');
  });
});

// Rendered drawer card and details page (unit): which palette the tubes wear is decided by the
// surface, so it is checked where each surface asks for it.
describe('tube liquid by surface', () => {
  function liquids(level: Source['level']) {
    const snapshot = snapshotOf([{ ...subscription, level }]);
    sync.state = { kind: 'snapshot', snapshot, deviceName: 'Studio' };
    return [<DrawerUsage onOpen={() => {}} />, <UsageDashboard snapshot={snapshot} />].map(view => {
      const rects = new DOMParser().parseFromString(renderToStaticMarkup(view), 'text/html').querySelectorAll('[data-liquid]');
      const liquid = rects[rects.length - 1]!;
      return [liquid.getAttribute('data-liquid'), liquid.getAttribute('data-liquid-opacity')];
    });
  }
  it('keeps the drawer neutral like the menu bar panel and the details page teal like the widget', () => {
    expect(liquids('normal')).toEqual([['textPrimary', '0.46'], ['quotaWidgetPlenty', '1']]);
  });
  it('shows a low level in the quota color on both', () => {
    expect(liquids('warn')).toEqual([['quotaBarWarn', '1'], ['quotaBarWarn', '1']]);
    expect(liquids('error')).toEqual([['quotaBarCrit', '1'], ['quotaBarCrit', '1']]);
  });
});

// Rendered drawer card and details page (unit). The first frame is what matters here: an opening
// starts from empty and zero, and anyone who has not turned Reduce Motion off must get the final
// picture at once. The motion itself is covered in usageOpeningMotion.test.ts.
describe('opening motion', () => {
  function firstFrame(reduced: boolean | null) {
    motion.reduced = reduced;
    const snapshot = snapshotOf([subscription], { usage: { scope: 'local', days: ['2026-11-19'],
      daily: [{ money: [0, 0, 0], paid: 0, tokens: [257_000, 0, 0] }] } });
    sync.state = { kind: 'snapshot', snapshot, deviceName: 'Studio' };
    const [drawer, details] = [<DrawerUsage onOpen={() => {}} />, <UsageDashboard snapshot={snapshot} />].map(view =>
      new DOMParser().parseFromString(renderToStaticMarkup(view), 'text/html').body);
    motion.reduced = true;
    return { drawer: drawer!, details: details! };
  }
  it('starts the drawer card from an empty tube and zeroed numbers', () => {
    const { drawer, details } = firstFrame(false);
    expect(drawer.querySelector('[data-opening]')?.getAttribute('data-opening')).toBe('M0 0');
    expect(drawer.textContent).toContain('\u20070%');
    expect(drawer.textContent).toContain('\u2007\u20070K');
    // The details page is not an opening: it shows its readings as they are.
    expect(details.querySelector('[data-opening]')).toBeNull();
    expect(details.textContent).toContain('68%');
  });
  it('shows the final picture, still, unless Reduce Motion is known to be off', () => {
    for (const reduced of [true, null]) {
      const { drawer } = firstFrame(reduced);
      expect(drawer.querySelector('[data-opening]')).toBeNull();
      expect(drawer.textContent).toContain('68%');
      expect(drawer.textContent).toContain('257K');
    }
  });
});
