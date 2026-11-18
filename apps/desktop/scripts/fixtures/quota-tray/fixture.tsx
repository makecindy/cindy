import { mountPage } from '../../ui-page/harness';
import i18n from '../../../src/renderer/i18n';
import { QuotaTray } from '../../../src/renderer/quota-tray-panel';
import { buildMenubarView, type MenubarSubscriptionInput } from '../../../src/main/menubar/snapshot';
import { familyLogo, MENUBAR_HARNESS_LOGOS } from '../../../src/main/menubar/logos';
import { DEFAULT_MENUBAR_SETTINGS, type MenubarView } from '../../../src/shared/menubarQuota';
import { QUOTA_PANEL_DESIGN } from '../../../src/shared/quotaPanelDesign';

// UI regression: eight unread tasks used to force nested scrollbars and hide the headline.
// Render the production panel and snapshot builder; only the host/data boundary is simulated.
mountPage({
  render: ctx => {
    const now = Date.now();
    const strings: Record<string, string> = {};
    const flatten = (object: Record<string, unknown>, prefix = '') => {
      for (const [key, value] of Object.entries(object)) {
        if (typeof value === 'string') strings[prefix + key] = value;
        else if (value && typeof value === 'object') flatten(value as Record<string, unknown>, prefix + key + '.');
      }
    };
    flatten(i18n.getResourceBundle(ctx.locale, 'common').menubar.ui);
    const days = Array.from({ length: 90 }, (_, i) => new Date(now - (89 - i) * 86400000).toISOString().slice(0, 10));
    const daily = days.map((_, i) => ({ money: [i % 3, (i % 7) * 5, 0] as [number, number, number], paid: 0, tokens: [10, 20, 0] as [number, number, number] }));
    const scope = { daily, models: { '7': [], '30': [], '90': [] }, devices: [{ name: 'Preview', isSelf: true, syncedAtMs: null }] };
    let settings = { ...DEFAULT_MENUBAR_SETTINGS };
    let listener: ((view: MenubarView | null) => void) | undefined;
    let unread = true;
    const build = () => {
      const sources: MenubarSubscriptionInput[] = ['Home-PC', 'guyong', 'Work'].map((name, i) => ({
        kind: 'subscription', id: name, providerId: name, family: 'codex', logoSvg: familyLogo('codex'),
        brand: 'Codex', account: name, plan: 'Pro', windows: [{ kind: 'week', usedPercent: [95, 39, 60][i], resetsAtMs: now + 14400000, windowMinutes: 10080 }],
        credits: null, creditsUnlimited: false, prepaidUsd: null, updatedAtMs: now,
      }));
      const view = buildMenubarView({
        nowMs: now, locale: ctx.locale, moneySymbol: '¥', settings, sources, tasks: [],
        usage: { days, scopes: { all: scope, local: scope } }, updatedAtMs: now,
        harnessLogos: MENUBAR_HARNESS_LOGOS, uiStrings: strings,
        t: (key, values) => i18n.t('menubar.' + key, values) as string,
      });
      view.presentation = QUOTA_PANEL_DESIGN;
      view.tasks = [{ sessionId: 'usage-task', title: 'Usage task', harness: 'codex', logoSvg: familyLogo('codex'),
        value: 25, tokens: 10, running: false, startedAtMs: null, idleStatus: '', meta: '' }];
      view.activities = Array.from({ length: 8 }, (_, i) => ({
        sessionId: 'preview-' + i, title: 'Review task ' + (i + 1), logoSvg: familyLogo('codex'),
        companion: false, attention: unread, phase: 'needs-interaction', preview: 'Review the latest changes',
        status: strings.activityWaiting, startedAtMs: null, lastActivityAtMs: now - (i + 1) * 60000,
      }));
      return view;
    };
    window.quotaTray = {
      ready: () => listener?.(build()),
      painted: () => {
        if (!document.querySelector('.panel') || [...document.images].some(image => !image.complete)) {
          throw new Error('Tray reported presentation readiness before its content loaded');
        }
        document.documentElement.dataset.quotaPainted = 'true';
      },
      onWindowHiddenChange: callback => {
        const hide = () => callback(true);
        const show = () => callback(false);
        const toggleUnread = () => { unread = !unread; listener?.(build()); };
        window.addEventListener('fixture-tray-hide', hide);
        window.addEventListener('fixture-tray-show', show);
        window.addEventListener('fixture-toggle-unread', toggleUnread);
        callback(false);
        return () => {
          window.removeEventListener('fixture-tray-hide', hide);
          window.removeEventListener('fixture-tray-show', show);
          window.removeEventListener('fixture-toggle-unread', toggleUnread);
        };
      },
      subscribe: callback => { listener = callback; return () => { listener = undefined; }; },
      refresh: () => listener?.(build()), openApp: () => {},
      openSession: id => { document.documentElement.dataset.openedSession = id; }, detailAction: () => {},
      openProviderSettings: () => {}, openRemoteControlSettings: () => {},
      resize: height => { document.documentElement.dataset.quotaNaturalHeight = String(height); },
      updateSettings: patch => { settings = { ...settings, ...patch }; listener?.(build()); },
    };
    return <QuotaTray/>;
  },
});
