// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { initTapdb } from '../analytics/tapdbClient';

vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { subscribeAll: () => () => {}, getRunningSnapshot: () => new Map() },
}));
vi.mock('../../shared/endpoints', () => ({
  TAPDB_EVENT_URL_BY_REGION: {
    cn: 'https://example.invalid/event', dev: 'https://example.invalid/event', global: 'https://example.invalid/event',
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('serializes registered desktop event names without sending navigation details', async () => {
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.title = 'fixture-private-title';
  history.replaceState(null, '', '/fixture-private-route?utm_source=fixture-private-campaign');
  const send = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {});
  const subscribe = vi.fn();
  vi.stubGlobal('electronAPI', {
    platform: 'darwin', appVersion: '1.0.0',
    getAnalyticsSettings: async () => ({ allowed: true }), onAnalyticsSettingsChange: subscribe,
  });
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  initTapdb({ getSnapshot: () => null, onAuthStateChange: () => () => {} });
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  clock.mockReturnValue(2860);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  const events = send.mock.calls.map(([body]) => JSON.parse(decodeURIComponent(String(body))));
  expect(events.map(event => event.name)).toEqual([
    'device_login', '#cindy_desktop_page_show_v1', '#cindy_desktop_page_view_v1', '#cindy_desktop_page_hide_v1',
  ]);
  expect(events[2].properties['#cindy_activity_trigger']).toBe('app_start');
  expect(events[3].properties.duration).toBe(2);
  for (const event of events) {
    expect(event.device_id).toBeTruthy();
    expect(event).not.toHaveProperty('user_id');
    for (const key of ['url', 'url_path', 'referrer', 'referrer_host', 'title']) {
      expect(event.properties).not.toHaveProperty(key);
    }
    expect(JSON.stringify(event)).not.toContain('fixture-private');
  }
  subscribe.mock.calls[0][0]({ allowed: false });
  send.mockClear();
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(send).not.toHaveBeenCalled();
});
