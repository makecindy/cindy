import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Regression guards for receipt ownership and local/session deletion semantics. */
describe('desktop auth account-deletion lifecycle', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/main/authManager.ts'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  it('persists the main-only receipt before exposing display-safe challenge data', () => {
    const start = source.indexOf('export async function requestAccountDeletionChallenge()');
    const end = source.indexOf('\n}\n\n/**\n * Confirm deletion', start);
    const body = source.slice(start, end);

    expect(body).toContain('writePersistedAccountDeletionReceipt(');
    expect(body.indexOf('writePersistedAccountDeletionReceipt(')).toBeLessThan(
      body.indexOf('return {'),
    );
    expect(body).not.toContain('receiptToken: challenge.receiptToken');
  });

  it('recovers an ambiguous confirm through the receipt realm before local logout', () => {
    const start = source.indexOf('export async function confirmAccountDeletion(');
    const end = source.indexOf('\n}\n\n/** Query the persisted receipt', start);
    const body = source.slice(start, end);

    expect(body).toContain("['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE']");
    expect(body).toContain('const client = createAuthClient(receipt.realm);');
    expect(body).toContain('.getAccountDeletionStatus(receipt.receiptToken)');
    expect(body).toContain("recovered.status === 'cancelled'");
    expect(body).toContain(
      'commitAccountDeletionConfirmation(expectedIdentity, receipt.realm, status)',
    );
    expect(body).not.toContain("apiFetch('/api/auth/logout'");
  });

  it('binds confirmation to the credential identity and realm that requested the challenge', () => {
    const helperStart = source.indexOf('function writePersistedAccountDeletionReceipt(');
    const helperEnd = source.indexOf('\n}\n\n// ── PKCE', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody).toContain(
      'serializeAccountDeletionReceiptRecord(realm, receiptToken, authIdentity)',
    );

    const requestStart = source.indexOf('export async function requestAccountDeletionChallenge()');
    const requestEnd = source.indexOf('\n}\n\n/**\n * Confirm deletion', requestStart);
    const requestBody = source.slice(requestStart, requestEnd);
    expect(requestBody).toContain('const expectedIdentity = currentAccountDeletionAuthIdentity();');
    expect(requestBody).toContain('const expectedRealm = activeAuthRealm;');
    expect(requestBody).toMatch(
      /writePersistedAccountDeletionReceipt\(\s*challenge\.receiptToken,\s*expectedRealm,\s*expectedIdentity,?\s*\)/,
    );

    const confirmStart = source.indexOf('export async function confirmAccountDeletion(');
    const confirmEnd = source.indexOf('\n}\n\n/** Query the persisted receipt', confirmStart);
    const confirmBody = source.slice(confirmStart, confirmEnd);
    expect(confirmBody).toContain('receipt.version !== 2');
    expect(confirmBody).toContain('receipt.authIdentity !== expectedIdentity');
    expect(confirmBody).toContain('receipt.realm !== activeAuthRealm');
    expect(confirmBody.indexOf('receipt.authIdentity !== expectedIdentity')).toBeLessThan(
      confirmBody.indexOf('client.confirmAccountDeletion(token'),
    );
  });

  it('queries a persisted deletion receipt against its original realm after logout', () => {
    const statusStart = source.indexOf('export async function getAccountDeletionStatus()');
    const statusEnd = source.indexOf(
      '\n}\n\nexport function clearAccountDeletionReceipt',
      statusStart,
    );
    const statusBody = source.slice(statusStart, statusEnd);
    expect(statusBody).toContain('await loadClientEndpointsForRealm(receipt.realm);');
    expect(statusBody).toContain(
      'createAuthClient(receipt.realm).getAccountDeletionStatus(receipt.receiptToken)',
    );
  });

  it('preserves a confirmed receipt on local clear but drops it on ordinary logout', () => {
    const localClearStart = source.indexOf(
      'export function clearLocalSessionAfterAccountDeletion(): boolean {',
    );
    const localClearEnd = source.indexOf('\n}\n\n/**\n * 当前展示资料', localClearStart);
    const localClearBody = source.slice(localClearStart, localClearEnd);
    expect(localClearBody).toContain('clearAuth();');
    expect(localClearBody).toContain('isConfirmedAccountDeletionSessionCurrent()');
    expect(localClearBody).not.toContain('clearAccountDeletionReceipt');

    const logoutStart = source.indexOf('export async function logout(): Promise<void> {');
    const logoutEnd = source.indexOf('\n}\n\n/**\n * Called on system resume', logoutStart);
    expect(source.slice(logoutStart, logoutEnd)).toContain('clearAccountDeletionReceipt();');
  });

  it('clears stale receipts as soon as a login selects an account', () => {
    const start = source.indexOf('async function acceptLoginOutcome');
    const end = source.indexOf('\n}\n\nasync function runLoginAction', start);
    const body = source.slice(start, end);

    expect(body).toContain("if (outcome.status === 'ok' || outcome.status === 'select_account')");
    expect(body).toContain('removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);');
    expect(body.indexOf('removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);')).toBeLessThan(
      body.indexOf("if (outcome.status === 'select_account')"),
    );
  });

  it('emits the restoration notice only after the final login commits', () => {
    const start = source.indexOf('async function completeLogin(');
    const end = source.indexOf('\n}\n\nasync function acceptLoginOutcome', start);
    const body = source.slice(start, end);

    expect(body).toContain('removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);');
    expect(body).toContain('accountDeletionRestoredNoticePending = deletionWasRestored;');
    expect(body.indexOf('accountDeletionRestoredNoticePending =')).toBeLessThan(
      body.indexOf('notifyRenderer();'),
    );
  });

  it('single-flights terminal rejection through full account teardown', () => {
    const start = source.indexOf('export function invalidateSession(');
    const end = source.indexOf('\n}\n\n// ── Public API', start);
    const body = source.slice(start, end);

    expect(body).toContain('if (sessionInvalidationPromise) return sessionInvalidationPromise;');
    expect(body).toContain('await authSessionTeardown(reason);');
    expect(body).toContain('closeLocalDb();');
    expect(body).toContain('clearAuth({ notify: false, deferSessionCommit: true });');
    expect(body).toContain('notifyAuthListeners();');
    expect(body).toContain('notifySessionExpired(');
    expect(body.indexOf('clearAuth({ notify: false, deferSessionCommit: true });')).toBeLessThan(
      body.indexOf('notifySessionExpired('),
    );
  });

  it('restores the localized renderer notification without leaking internal reason codes', () => {
    const start = source.indexOf('function notifySessionExpired(');
    const end = source.indexOf('\n}\n\n// ── In-process auth state subscription', start);
    const body = source.slice(start, end);

    expect(body).toContain(
      "broadcastToRenderers('auth:session-expired', { message: '', reason });",
    );
  });

  it('routes direct protected auth-client calls through terminal invalidation', () => {
    const helperStart = source.indexOf('async function runProtectedAuthRequest');
    const helperEnd = source.indexOf('\n}\n\n/** Server-controlled visibility', helperStart);
    const helperBody = source.slice(helperStart, helperEnd);

    expect(helperBody).toContain("error.code === 'ACCOUNT_UNAVAILABLE'");
    expect(helperBody).toContain("void invalidateSession('account-unavailable')");
    const availabilityStart = source.indexOf(
      'export function getAccountDeletionAvailability()',
    );
    const availabilityEnd = source.indexOf(
      '\n}\n\n/**\n * Request an OTP',
      availabilityStart,
    );
    const availabilityBody = source.slice(
      availabilityStart,
      availabilityEnd,
    );
    expect(availabilityBody).toContain('return runProtectedAuthRequest(() =>');
    expect(availabilityBody).toContain(
      'createAuthClient().getAccountDeletionAvailability(token)',
    );
  });
});
