import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Same-owner access-token refresh must not bounce the renderer to /login.
 *
 * 2026-08-20: packaged 0.1.56 logged `r:tapdb logout` →
 * `App session is switching` → `LocalDbGate` remount every ~55 minutes. The
 * trigger was `withCloudOwnerCommit` broadcasting `snapshotLoggedOutAuthState()`
 * during Ghost projection repair on a stable cloud owner.
 */
describe('same-owner token refresh keeps the signed-in shell', () => {
  const authSource = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('does not broadcast a logged-out snapshot for same-owner Ghost repair', () => {
    const start = authSource.indexOf('async function withCloudOwnerCommit');
    const end = authSource.indexOf('async function withAccountFreeOwnerCommit', start);
    const body = authSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('if (ownerChanged) {\n          notifyRendererAuthBoundaryPending();');
    expect(body).toContain('enterOwnerChangeShellPending();');
    expect(body).toContain('heldOwnerChangeShell = true;');
    expect(body).toContain('if (heldOwnerChangeShell) leaveOwnerChangeShellPending();');
    expect(body).toContain('releaseBoundary = beginAppSessionBoundary();');
    expect(body.indexOf('notifyRendererAuthBoundaryPending();')).toBeLessThan(
      body.indexOf('enterOwnerChangeShellPending();'),
    );
    expect(body.indexOf('if (ownerChanged)')).toBeLessThan(body.indexOf('notifyRendererAuthBoundaryPending();'));
    expect(body.indexOf('notifyRendererAuthBoundaryPending();')).toBeLessThan(
      body.indexOf('releaseBoundary = beginAppSessionBoundary();'),
    );
    // The unguarded call that remounted the shell every refresh cycle.
    expect(body).not.toContain(
      'prepareTransition: async ({ ownerChanged }) => {\n        notifyRendererAuthBoundaryPending();',
    );
  });

  it('keeps canEnterApp true for IPC pending, but not a real owner-change shell', () => {
    const start = authSource.indexOf('function snapshotAuthState(): AuthState {');
    const end = authSource.indexOf('function snapshotLoggedOutAuthState', start);
    const body = authSource.slice(start, end);

    expect(body).toContain(
      "canEnterApp: appSession.mode !== 'signed-out' && !isOwnerChangeShellPending()",
    );
    expect(body).not.toContain('!isAppSessionBoundaryPending()');
  });

  it('still fakes a signed-out snapshot for a real owner change or logout', () => {
    const cloudStart = authSource.indexOf('async function withCloudOwnerCommit');
    const cloudEnd = authSource.indexOf('async function withAccountFreeOwnerCommit', cloudStart);
    const accountFreeStart = cloudEnd;
    const accountFreeEnd = authSource.indexOf('async function recoverAccountFreeOwnerAtStartup', accountFreeStart);

    expect(authSource.slice(cloudStart, cloudEnd)).toContain('notifyRendererAuthBoundaryPending();');
    expect(authSource.slice(accountFreeStart, accountFreeEnd)).toContain(
      'notifyRendererAuthBoundaryPending();',
    );
  });
});
