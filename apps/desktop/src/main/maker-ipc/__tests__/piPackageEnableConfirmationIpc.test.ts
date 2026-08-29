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
    expect(handler).toContain('result = await mutatePiPackage(');
    expect(handler).not.toContain('request.source.trim()');
  });
});
