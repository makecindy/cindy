import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');
const messagesSource = readFileSync(
  resolve(__dirname, '..', 'localDb', 'ipc', 'messages.ts'),
  'utf8',
);
const dispatchSource = readFileSync(
  resolve(__dirname, '..', 'device-link', 'dispatch.ts'),
  'utf8',
);

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

  it.each([
    'local-db:messages:estimatedSessionValue',
    'local-db:messages:estimatedSessionValueBatch',
  ] as const)('guards %s for local senders and keeps device-link on the async-context path', (channel) => {
    const start = messagesSource.indexOf(`'${channel}'`);
    const end = messagesSource.indexOf('\n  );', start);
    const handler = messagesSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);');
    expect(handler.indexOf('if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);')).toBeLessThan(
      handler.indexOf('getDbClient().drizzle'),
    );
  });

  it('keeps the remote billing GET on the dedicated device-link branch', () => {
    expect(dispatchSource).toContain("payload.channel === 'maker:custom-provider-billing:get'");
    expect(dispatchSource).toContain('return { ok: true, result: customProviderBillingWire() };');
  });
});
