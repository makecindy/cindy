import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('custom provider billing IPC security contract', () => {
  it.each([
    ['CUSTOM_PROVIDER_BILLING_GET', 'customProviderBillingWire()'],
    ['CUSTOM_PROVIDER_BILLING_SET', 'writeCustomProviderShowSdkCostEnabled(enabled)'],
    ['CUSTOM_PROVIDER_BILLING_RESET', 'resetCustomProviderBillingSettings()'],
  ] as const)('guards %s before reading or mutating settings', (channel, operation) => {
    const start = bootstrapSource.indexOf(`ipcMain.handle(MAKER_IPC_INVOKE.${channel}`);
    const end = bootstrapSource.indexOf('\n  });', start);
    const handler = bootstrapSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('assertTrustedAppRendererEvent(event);');
    expect(handler.indexOf('assertTrustedAppRendererEvent(event);')).toBeLessThan(
      handler.indexOf(operation),
    );
  });

  it('rejects the set payload only after authenticating the sender', () => {
    const start = bootstrapSource.indexOf(
      'ipcMain.handle(MAKER_IPC_INVOKE.CUSTOM_PROVIDER_BILLING_SET',
    );
    const end = bootstrapSource.indexOf('\n  });', start);
    const handler = bootstrapSource.slice(start, end);

    expect(handler.indexOf('assertTrustedAppRendererEvent(event);')).toBeLessThan(
      handler.indexOf("typeof enabled !== 'boolean'"),
    );
  });
});
