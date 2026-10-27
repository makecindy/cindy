import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: false }));
vi.mock('expo-router', () => ({ Redirect: 'Redirect' }));
vi.mock('@/components/CenteredScreen', () => ({ CenteredScreen: 'CenteredScreen' }));
vi.mock('@/config/env', () => ({
  get MOBILE_VISUAL_MOCK_ENABLED() { return state.enabled; },
}));
import SplashPreviewScreen from '../../app/splash-preview';

// Unit: execute the production route. The dev-only preview must redirect when
// disabled; source/import/style assertions did not verify either route result.
describe('mobile splash preview route', () => {
  it.each([false, true])('gates the rendered preview when enabled=%s', (enabled) => {
    state.enabled = enabled;
    const element = SplashPreviewScreen();
    expect(element.type).toBe(enabled ? 'CenteredScreen' : 'Redirect');
    expect(element.props).toEqual(enabled ? { title: 'Cindy', variant: 'splash' } : { href: '/' });
  });
});
