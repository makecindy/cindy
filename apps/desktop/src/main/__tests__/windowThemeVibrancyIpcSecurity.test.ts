import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const bootstrapSource = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('window theme vibrancy IPC trust boundary', () => {
  it('validates the sender and payload before persistence or window mutations', () => {
    const start = bootstrapSource.search(
      /ipcMain\.on\(\s*['"]theme:apply-vibrancy['"]/u,
    );
    const endMatch = /ipcMain\.on\(\s*['"]get-app-version['"]/u.exec(
      bootstrapSource.slice(start),
    );
    const end = endMatch ? start + endMatch.index : -1;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const handler = bootstrapSource.slice(start, end);
    const senderGuard = handler.indexOf('assertTrustedAppRendererEvent(event);');
    const payloadParse = handler.indexOf('parseWindowThemeVibrancyPayload(rawPayload);');
    const modeGuard = handler.indexOf('payload.mode === undefined');
    const systemFollowGuard = handler.indexOf('payload.systemModeFollowsSystem === undefined');
    const snapshotWrite = handler.indexOf('writeWindowThemeSnapshot(');
    const resolvedThemeWrite = handler.indexOf('rememberResolvedAppTheme(payload.isDark);');
    const vibrancyMutation = handler.indexOf('applyWindowVibrancy(payload.familyId');

    expect(handler).toContain('(event, rawPayload: unknown)');
    expect(senderGuard).toBeGreaterThanOrEqual(0);
    expect(payloadParse).toBeGreaterThan(senderGuard);
    expect(modeGuard).toBeGreaterThan(payloadParse);
    expect(systemFollowGuard).toBeGreaterThan(payloadParse);
    expect(snapshotWrite).toBeGreaterThan(systemFollowGuard);
    expect(resolvedThemeWrite).toBeGreaterThan(systemFollowGuard);
    expect(vibrancyMutation).toBeGreaterThan(systemFollowGuard);
  });
});
