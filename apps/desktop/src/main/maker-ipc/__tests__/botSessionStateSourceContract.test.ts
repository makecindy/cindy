import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

describe('Bot unified task-state source contract', () => {
  it('does not rebuild task facts from maker turn endings or database title patches', () => {
    const register = source('../register.ts');
    const sessionsIpc = source('../../localDb/ipc/sessions.ts');
    const imBroadcast = source('../../im/shared/sessionBroadcast.ts');

    expect(register).not.toContain('recordTurnEvent');
    expect(register).not.toContain('recordMetadataPatch');
    expect(register).not.toContain('subscribeSessionMetadataPatches');
    expect(sessionsIpc).not.toContain('publishSessionMetadataPatch');
    expect(imBroadcast).not.toContain('publishSessionMetadataPatch');
  });

  it('keeps Bots as a consumer of the control-plane transition source', () => {
    const contract = source('../../../shared/botSessionEvents.ts');
    const service = source('../botSessionEventService.ts');

    expect(contract).toContain('interface BotSessionStateTransitionSource');
    expect(contract).not.toMatch(/export function publish/i);
    expect(service).toContain('stateTransitionSource?: BotSessionStateTransitionSource');
    expect(service).toContain('bindStateTransitionSource');
  });
});
