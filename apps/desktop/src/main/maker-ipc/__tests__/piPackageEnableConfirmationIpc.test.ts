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

describe('Pi package enable confirmation IPC contract', () => {
  it('rejects untrusted Renderer events before inspecting payload or package identity', () => {
    const handler = mutationHandlerSource();
    const trustGuard = handler.indexOf('assertTrustedAppRendererEvent(event);');
    const payloadRead = handler.indexOf('const payload = requireObject(raw);');
    const identityCapture = handler.indexOf('capturePiPackageEnableIdentity(request.source)');

    expect(trustGuard).toBeGreaterThanOrEqual(0);
    expect(trustGuard).toBeLessThan(payloadRead);
    expect(trustGuard).toBeLessThan(identityCapture);
  });

  it('shows the Main-inspected package label and fingerprint before binding that fingerprint', () => {
    const handler = mutationHandlerSource();
    const identityCapture = handler.indexOf('capturePiPackageEnableIdentity(request.source)');
    const inspectedLabel = handler.indexOf("message: enableIdentity?.displayLabel ?? ''");
    const nativeDialog = handler.indexOf('dialog.showMessageBox');
    const decisionGate = handler.indexOf('if (decision.response !== 0)');
    const grantIssue = handler.indexOf('issuePiPackageMutationGrant(request, grantBinding)');

    expect(identityCapture).toBeGreaterThanOrEqual(0);
    expect(inspectedLabel).toBeGreaterThan(identityCapture);
    expect(nativeDialog).toBeGreaterThan(inspectedLabel);
    expect(decisionGate).toBeGreaterThan(nativeDialog);
    expect(grantIssue).toBeGreaterThan(decisionGate);
    expect(handler).toContain(
      'expectedPackageFingerprint: enableIdentity.expectedPackageFingerprint',
    );
    expect(handler).not.toContain('payload.name');
    expect(handler).not.toContain('payload.version');
  });

  it('uses one Main-owned display escape for every Renderer-provided mutation source', () => {
    const handler = mutationHandlerSource();
    const displayEscape = handler.indexOf(
      'const source = escapePiPackageNativeDialogText(request.source);',
    );
    const nativeDialog = handler.indexOf('dialog.showMessageBox');
    const grantIssue = handler.indexOf('issuePiPackageMutationGrant(request, grantBinding)');

    expect(displayEscape).toBeGreaterThanOrEqual(0);
    expect(displayEscape).toBeLessThan(nativeDialog);
    expect(grantIssue).toBeGreaterThan(nativeDialog);
    expect(handler).not.toContain('request.source.trim()');
    expect(handler).toContain('mutatePiPackage(request, issuePiPackageMutationGrant(request, grantBinding))');
  });
});
