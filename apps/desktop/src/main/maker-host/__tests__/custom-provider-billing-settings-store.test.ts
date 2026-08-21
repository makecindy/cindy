import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let userDataDir = '';

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error('unexpected path: ' + name);
      return userDataDir;
    },
  },
}));

describe('custom-provider-billing-settings-store', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-custom-billing-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('defaults to hiding SDK cost for custom providers (token-only)', async () => {
    const { readCustomProviderBillingSettings, readCustomProviderBillingSettingsState } =
      await import('../custom-provider-billing-settings-store.js');

    expect(readCustomProviderBillingSettings()).toEqual({ showSdkCostForCustomProviders: false });
    expect(readCustomProviderBillingSettingsState()).toMatchObject({
      value: { showSdkCostForCustomProviders: false },
      isCustomized: false,
      defaults: { showSdkCostForCustomProviders: false },
      customizedKeys: [],
    });
  });

  it('persists an explicit opt-in and can be reset back to the default', async () => {
    const {
      readCustomProviderBillingSettings,
      resetCustomProviderBillingSettings,
      writeCustomProviderShowSdkCostEnabled,
    } = await import('../custom-provider-billing-settings-store.js');

    const enabled = writeCustomProviderShowSdkCostEnabled(true);
    expect(enabled.isCustomized).toBe(true);
    expect(readCustomProviderBillingSettings().showSdkCostForCustomProviders).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(userDataDir, 'custom-provider-billing-settings.json'), 'utf8')),
    ).toEqual({ showSdkCostForCustomProviders: true });

    resetCustomProviderBillingSettings();
    expect(readCustomProviderBillingSettings().showSdkCostForCustomProviders).toBe(false);
    expect(fs.existsSync(path.join(userDataDir, 'custom-provider-billing-settings.json'))).toBe(false);
  });

  it('normalizes malformed persisted values back to defaults', async () => {
    const { __testing, readCustomProviderBillingSettings } = await import(
      '../custom-provider-billing-settings-store.js'
    );

    expect(__testing.normalize({ showSdkCostForCustomProviders: 'yes' })).toEqual({
      showSdkCostForCustomProviders: false,
    });
    expect(__testing.normalize(null)).toEqual({ showSdkCostForCustomProviders: false });

    fs.writeFileSync(
      path.join(userDataDir, 'custom-provider-billing-settings.json'),
      JSON.stringify({ showSdkCostForCustomProviders: 'not-a-boolean' }),
      'utf-8',
    );
    expect(readCustomProviderBillingSettings()).toEqual({ showSdkCostForCustomProviders: false });
  });
});
