import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Cross-file wiring contract: queued acceptance and terminal-time retries must never get the
 * round-scoped guard again. The behaviour of the scope itself is unit-tested; this guard only
 * pins that production wiring still feeds it (removing the injection silently reverts the fix,
 * because the service then falls back to the round guard).
 */
describe('Orca delivery authority wiring', () => {
  const here = resolve(__dirname, '..');
  const register = readFileSync(resolve(here, 'register.ts'), 'utf8');
  const service = readFileSync(resolve(here, 'orcaTeamService.ts'), 'utf8');

  it('injects the delivery guard into the Orca team service', () => {
    expect(register).toMatch(
      /captureDeliveryAuthority:\s*\(leadSessionId\)\s*=>\s*captureOrcaDeliveryAuthority\(leadSessionId\)/,
    );
  });

  it('uses the delivery guard at acceptance and at deferred acknowledgement', () => {
    expect(service).toMatch(/assertAcceptedCurrent\s*=\s*params\.assertDeliveryCurrent\s*\?\?\s*params\.assertCurrent/);
    expect(service).toMatch(/assertDeliveryCurrent:\s*await deps\.captureDeliveryAuthority\?\.\(link\.leadSessionId\)/);
    expect(service.match(/captureDeferredAuthority\(params\.callerLeadSessionId, opts\)/g)).toHaveLength(2);
  });
});
