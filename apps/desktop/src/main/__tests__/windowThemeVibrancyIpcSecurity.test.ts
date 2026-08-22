import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('window theme vibrancy IPC trust boundary', () => {
  it('validates the sender and payload before persistence or window mutations', () => {
    const start = bootstrapSource.indexOf("ipcMain.on(\n    'theme:apply-vibrancy'");
    const end = bootstrapSource.indexOf("ipcMain.on('get-app-version'", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = bootstrapSource.slice(start, end);
    const senderGuard = handler.indexOf('assertTrustedAppRendererEvent(event);');
    const payloadParse = handler.indexOf('parseWindowThemeVibrancyPayload(rawPayload);');
    const snapshotWrite = handler.indexOf('writeWindowThemeSnapshot(');
    const vibrancyMutation = handler.indexOf('applyWindowVibrancy(payload.familyId');

    expect(handler).toContain('(event, rawPayload: unknown)');
    expect(senderGuard).toBeGreaterThanOrEqual(0);
    expect(payloadParse).toBeGreaterThan(senderGuard);
    expect(snapshotWrite).toBeGreaterThan(payloadParse);
    expect(vibrancyMutation).toBeGreaterThan(payloadParse);
  });
});
