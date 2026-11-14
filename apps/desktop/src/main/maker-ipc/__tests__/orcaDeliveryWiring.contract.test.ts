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

/**
 * Direct dispatch (idle target) and queued dispatch (busy target) carry the same user row and must
 * persist it through the same writer. silent-stop auto-resume credit is charged per persisted user
 * message inside `createUserMessageDurably`, so a raw `createMessage` write leaves worker sessions —
 * which never receive a renderer send — at zero credit: the first thinking-only empty response ends
 * in `exhausted` and waits for a human wake instead of resuming.
 */
describe('Orca direct dispatch persistence wiring', () => {
  const here = resolve(__dirname, '..');
  const register = readFileSync(resolve(here, 'register.ts'), 'utf8');
  const dispatcher = readFileSync(resolve(here, 'orcaInterAgentDispatcher.ts'), 'utf8');

  it('routes every direct user row through the durable writer', () => {
    // send_to_session 建会话 / send_to_session 既有会话 / Orca 直投兜底,与排队派单共用
    // createUserMessageDurably。
    expect(register.match(/await persistUserTurnMessage\(/g) ?? []).toHaveLength(2);
    expect(register).toMatch(
      /createDbMessage:\s*\(sessionId, message\)\s*=>\s*persistUserTurnMessage\(sessionId, message\)/,
    );
    expect(register).toMatch(/persistUserTurnMessage = createUserMessageDurably;/);
  });

  it('persists direct dispatch through the injected writer only', () => {
    expect(dispatcher).toMatch(/await deps\.createDbMessage\(session\.id, \{/);
    expect(dispatcher).not.toMatch(/\bcreateMessage\(/);
  });
});
