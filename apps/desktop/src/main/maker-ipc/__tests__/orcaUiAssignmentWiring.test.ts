import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');
const lifecycleSource = readFileSync(resolve(__dirname, '..', 'orcaLifecycleService.ts'), 'utf8');

describe('Orca UI assignment wiring', () => {
  it('waits for queryable Lead history before sending the deferred task', () => {
    const start = registerSource.indexOf('MAKER_INVOKE.WORKER_DISPATCH_UI_ASSIGNMENT');
    const end = registerSource.indexOf('async function clearLeadOrcaRoleState', start);
    const handler = registerSource.slice(start, end);

    const wait = handler.indexOf('orcaUiAssignmentHistoryGate.waitUntilQueryable(');
    const dispatch = handler.indexOf('orcaTeamService.sendToWorker({');
    expect(start).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(wait);
    expect(handler).toContain('buildUiAssignmentInitialTask({');
  });

  it('queries user rows after the handoff snapshot and observes durable persistence', () => {
    const gateStart = registerSource.indexOf(
      'const orcaUiAssignmentHistoryGate = createOrcaUiAssignmentHistoryGate({',
    );
    const gateEnd = registerSource.indexOf('const orcaLifecycleService', gateStart);
    const gate = registerSource.slice(gateStart, gateEnd);
    expect(gate).toContain('fromMs: snapshotBeforeMs');
    expect(gate).toContain("roles: ['user']");
    expect(lifecycleSource).toContain('uiAssignmentSnapshotBeforeMs: Date.now()');
    expect(registerSource).toContain(
      'orcaUiAssignmentHistoryGate.notifyUserMessagePersisted(sessionId);',
    );
  });
});
