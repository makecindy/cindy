import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = fs
  .readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
  .replace(/\r\n/g, '\n');

function forgeInstallBody(): string {
  const start = source.indexOf('export async function installOrUpdateLocalGhostPackageFromForge');
  const end = source.indexOf('/**\n * Plugin 市场专用装入入口', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Forge OIDC install entry wiring', () => {
  it('企业取消在任何 install/update 与 receipt 写入前收口', () => {
    const body = forgeInstallBody();
    const confirm = body.indexOf(
      'await ensureForgeOidcInstallConfirmBridge().request(confirmFacts)',
    );
    const mutation = body.indexOf('return withGhostInstallLock');
    expect(confirm).toBeGreaterThanOrEqual(0);
    expect(mutation).toBeGreaterThan(confirm);
    expect(body).toContain("throwIpcError('MUTATION_CANCELLED'");
    const beforeMutation = body.slice(0, mutation);
    expect(beforeMutation).not.toContain('installAndDockLocked(');
    expect(beforeMutation).not.toContain('updateLocalGhostPackageLocked(');
  });

  it('个人与企业身份的新装和原位更新都传 agent-forge', () => {
    const body = forgeInstallBody();
    expect(body).toContain("const membershipKind = user?.membershipKind ?? 'personal';");
    expect(body).toContain('const installOrigin = forgeInstallOriginForMembership(membershipKind);');
    expect(body).toContain('...(installOrigin ? { installOrigin } : {})');
    expect(body).toContain(
      'ghostInstallApprovalToken(installed.approval),\n        installOrigin,',
    );
    expect(body).not.toContain("installOrigin: 'agent-forge'");
  });

  it('tokenBroker 只在企业身份下拿 Forge facts，且不触发 OIDC 确认窗', () => {
    const body = forgeInstallBody();
    expect(body).toContain('installOrigin ? { installOrigin } : undefined');
    expect(body).toContain('forgeOidcInstallConfirmFacts(');
  });

  it('wires OIDC confirmation to the registered main App window instead of focused auxiliaries', () => {
    const start = source.indexOf('function ensureForgeOidcInstallConfirmBridge()');
    const end = source.indexOf('/**\n * 确认弹窗槽单例', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const wiring = source.slice(start, end);

    expect(wiring).toContain('createForgeOidcInstallMainWindowSender<BrowserWindow>({');
    expect(wiring).toContain('getMainWindow: getDeepLinkMainWindow');
    expect(wiring).not.toContain('BrowserWindow.getFocusedWindow');
    expect(wiring).not.toContain('BrowserWindow.getAllWindows');
    expect(source).not.toContain('function pickTrustedAppWindow');
  });
});
