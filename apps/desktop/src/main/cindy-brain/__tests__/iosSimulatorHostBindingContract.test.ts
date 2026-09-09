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
  const bootstrapSource = readFileSync(
    resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
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

  it('refreshes cached detached-sidebar grants from Main before the window is shown', () => {
    const createStart = bootstrapSource.indexOf('createWindow: () => {');
    const createEnd = bootstrapSource.indexOf('\n  getMainWindow:', createStart);
    const createBody = bootstrapSource.slice(createStart, createEnd);

    expect(createStart).toBeGreaterThan(-1);
    expect(createEnd).toBeGreaterThan(createStart);
    expect(createBody).toContain(
      'inheritIOSSimulatorRendererSessionAccess(mainTarget, window.webContents)',
    );
    expect(createBody).toContain(
      'syncIOSSimulatorRendererAccessForSessionChange(window.webContents, null)',
    );

    const start = bootstrapSource.indexOf('onWindowWillShow: (window) => {');
    const end = bootstrapSource.indexOf('\n  onWindowHidden:', start);
    const body = bootstrapSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain(
      'inheritIOSSimulatorRendererSessionAccess(mainTarget, window.webContents)',
    );
    expect(body).toContain(
      'syncIOSSimulatorRendererAccessForSessionChange(window.webContents, null)',
    );

    const hiddenStart = bootstrapSource.indexOf('onWindowHidden: (window) => {');
    const hiddenEnd = bootstrapSource.indexOf('\n  contextChannel:', hiddenStart);
    const hiddenBody = bootstrapSource.slice(hiddenStart, hiddenEnd);
    expect(hiddenStart).toBeGreaterThan(-1);
    expect(hiddenEnd).toBeGreaterThan(hiddenStart);
    expect(hiddenBody).toContain(
      'syncIOSSimulatorRendererAccessForSessionChange(window.webContents, null)',
    );
  });
});
