import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function mutationHandlerSource(): string {
  const source = readFileSync(resolve(process.cwd(), 'src/main/maker-ipc/register.ts'), 'utf8');
  const start = source.indexOf('ipcMain.handle(MAKER_INVOKE.PI_PACKAGES_MUTATE');
  const end = source.indexOf('\n  ipcMain.handle(', start + 1);
  if (start < 0 || end < 0) throw new Error('Pi package mutation IPC handler not found');
  return source.slice(start, end);
}

describe('Pi package Settings authorization IPC contract', () => {
  it('rejects untrusted Renderer events before inspecting the payload', () => {
    const handler = mutationHandlerSource();
    const trustGuard = handler.indexOf('assertTrustedAppRendererEvent(event);');
    const payloadRead = handler.indexOf('const payload = requireObject(raw);');

    expect(trustGuard).toBeGreaterThanOrEqual(0);
    expect(trustGuard).toBeLessThan(payloadRead);
  });

  it('uses the trusted Settings action as authorization without a second content decision', () => {
    const handler = mutationHandlerSource();
    const grantIssue = handler.indexOf('issuePiPackageMutationGrant(request)');

    expect(grantIssue).toBeGreaterThanOrEqual(0);
    expect(handler).not.toContain('capturePiPackageEnableIdentity');
    expect(handler).not.toContain('expectedPackageFingerprint');
    expect(handler).not.toContain('dialog.showMessageBox');
    expect(handler).not.toContain('MUTATION_CANCELLED');
    expect(handler).not.toContain('payload.name');
    expect(handler).not.toContain('payload.version');
  });

  it('binds every granted mutation to the exact validated request', () => {
    const handler = mutationHandlerSource();
    expect(handler).toContain('issuePiPackageMutationGrant(request)');
    expect(handler).toContain('const result = !piPackageMutationNeedsGrant(request)');
    expect(handler).not.toContain('request.source.trim()');
  });

  it.each(['install', 'update'])('logs stable fields rather than raw %s stderr', (action) => {
    const handler = mutationHandlerSource();
    const logStart = handler.indexOf("log.warn('Pi extension mutation failed'");
    const logEnd = handler.indexOf('\n        });', logStart);
    const failureLog = handler.slice(logStart, logEnd);

    expect(action).toMatch(/^(install|update)$/);
    expect(failureLog).toContain('action: request.action');
    expect(failureLog).toContain('failureCategory: piPackageMutationFailureCategory(error)');
    expect(failureLog).toContain('mayHaveChangedState: piPackageMutationMayHaveChangedState(error)');
    expect(failureLog).not.toContain('error.message');
    expect(failureLog).not.toContain('String(error)');
    expect(failureLog).not.toContain('message:');
  });

  it('retires stale local Pi runtimes only after a committed mutation edge', () => {
    const handler = mutationHandlerSource();
    expect(handler).toContain('await invalidateRuntimes();');
    expect(handler).toContain('piPackageMutationMayHaveChangedState(error)');
    expect(handler).not.toContain("request.action === 'remove'");
  });

  it('returns partial convergence without rewriting native mutation success', () => {
    const handler = mutationHandlerSource();
    expect(handler).toContain("runtimeConvergence: 'partial' as const");
    expect(handler).toContain('runtimeConvergencePartial = true');
    expect(handler).toContain("recoveryAction: 'restart-cindy'");
    expect(handler).not.toContain('throw new Error(`failed to retire');
  });

  it('maps unavailable or stale toggle state to an actionable redacted IPC failure', () => {
    const handler = mutationHandlerSource();
    expect(handler).toContain("piPackageMutationFailureCategory(error) === 'state-unavailable'");
    expect(handler).toContain("t('settings.piPackages.failure.stateUnavailable')");
  });
});
