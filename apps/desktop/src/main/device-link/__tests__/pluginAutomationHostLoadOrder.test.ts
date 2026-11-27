/**
 * The main bundle may evaluate this module before serverApiClient.desktop (an import
 * cycle; the cloud image's overlays reorder it). Loading must not read serverApiFetch.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../serverApiClient.desktop.js', () => ({
  get serverApiFetch(): never {
    throw new ReferenceError("Cannot access 'serverApiFetch' before initialization");
  },
}));

describe('plugin automation host load order', () => {
  it('loads before the server API client is initialized', async () => {
    await expect(import('../pluginAutomationHost.desktop.js')).resolves.toHaveProperty('pluginAutomationAccount');
  });
});
