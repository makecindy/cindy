import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * cindy-brain/index.ts owns Electron process singletons and cannot be imported
 * safely in Node tests. Pin this authorization wiring as a source contract.
 */
describe('iOS Simulator plugin Host binding', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('derives plugin task authority only from a Main-owned renderer grant', () => {
    const start = source.indexOf(
      'function focusedIOSSimulatorContext(): IOSSimulatorSlotFocusContext | null {',
    );
    const end = source.indexOf('\n}\n\nfunction focusedIOSSimulatorAuthorizationCandidate', start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('getIOSSimulatorRendererSessionAccess(window.webContents)');
    expect(body).toContain('sessionId: access.sessionId');
    expect(body).toContain('revision: access.generation');
    expect(body).not.toContain('ghostSessionFocusByWebContents');
  });

  it('uses renderer focus only as an explicitly confirmed cold-open hint', () => {
    const start = source.indexOf(
      'async function authorizeFocusedIOSSimulatorContext(): Promise<IOSSimulatorSlotFocusContext | null> {',
    );
    const end = source.indexOf('\n}\n\nfunction isIOSSimulatorContextCurrent', start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('requestIOSSimulatorRendererSessionAccess(');
    expect(body).toContain('getIOSSimulatorRendererSessionAccess(candidate.window.webContents)');
    expect(body).toContain('sessionId: access.sessionId');
    expect(body).toContain('revision: access.generation');
    expect(body).not.toContain('sessionId: candidate.sessionHint');
  });
});
