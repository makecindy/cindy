// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import type { MobileUsageWidgetSnapshot as Snapshot, MobileUsageWidgetSource as Source } from '@cindy/maker-shared/device-link-contract';
import { UsageQuotaColumns } from '@/widgets/UsageQuotaColumns';
import { UsageDashboard } from '@/widgets/UsageDashboard';

const auth = vi.hoisted(() => ({ user: { membershipKind: 'personal' } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/widgets/usageWidgetSync', () => ({}));
vi.mock('@/session/MobileProviderMark', () => ({ MobileProviderMark: () => null }));
vi.mock('react-native-svg', () => ({
  default: () => null, Defs: () => null, ClipPath: () => null, Rect: () => null, Path: () => null,
  LinearGradient: () => null, G: () => null, Stop: () => null,
}));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('react-native', () => ({ View: ({ children }: { children?: ReactNode }) => <div>{children}</div>, StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));

const subscription: Source = { id: 'plan', kind: 'subscription', name: 'Claude Pro', logo: null,
  monogram: 'C', value: '68', unit: '%', label: null, level: 'normal', fill: 0.68, reserve: false,
  emphasized: false, when: '', resetsAtMs: null };
const wallet: Source = { ...subscription, id: 'money', kind: 'balance', name: 'Cindy balance', value: '$0.00', unit: null };
function render(membershipKind: string, sources: Source[]) {
  auth.user.membershipKind = membershipKind;
  const snapshot: Snapshot = { version: 1, generatedAtMs: 0, updatedAtMs: null, locale: 'en', moneySymbol: '$',
    sources, usage: { scope: 'local', days: [], daily: [] }, strings: { today: 'Today' } };
  return renderToStaticMarkup(<UsageDashboard snapshot={snapshot} />);
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
