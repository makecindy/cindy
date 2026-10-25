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
  const service = readFileSync(
    resolve(__dirname, '../../../../../../packages/orca-workflow/src/host/orcaTeamService.ts'),
    'utf8',
  );

  it('injects the delivery guard into the Orca team service', () => {
    expect(register).toMatch(
      /captureControlAuthority:\s*async\s*\(leadSessionId\)\s*=>\s*\(await\s+captureOrcaPluginAuthority\(leadSessionId\)\)\.assertCurrent/,
    );
  });

  it('uses the delivery guard at acceptance and at deferred acknowledgement', () => {
    expect(service).toContain('const assertCurrent = captured ?? await deps.captureControlAuthority?.(params.callerLeadSessionId);');
    expect(service).toContain('beforeMutation: assertCurrent,');
    expect(service.match(/captureControlAuthority\?\.\(params\.callerLeadSessionId\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
