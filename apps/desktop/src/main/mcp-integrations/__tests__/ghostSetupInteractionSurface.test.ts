import { describe, expect, it } from 'vitest';

import {
  beginHeadlessGhostSetupTurn,
  ghostSetupInteractionSessionId,
  isHeadlessGhostSetupTurn,
} from '../ghostSetupInteractionSurface';

describe('ghostSetupInteractionSessionId', () => {
  it('keeps ordinary Desktop sessions interactive', () => {
    expect(
      ghostSetupInteractionSessionId({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'desktop-session',
      }),
    ).toBe('desktop-session');
  });

  it.each(['feishu', 'discord', 'scheduler', 'slack-hook', 'telegram'])(
    'treats %s turns as non-interactive even when they have a business session id',
    (source) => {
      expect(
        ghostSetupInteractionSessionId({
          agentKind: 'codex',
          workingDir: '/repo',
          sessionId: 'headless-session',
          vendorOptions: { source },
        }),
      ).toBeNull();
    },
  );

  it('treats a missing session context as non-interactive', () => {
    expect(ghostSetupInteractionSessionId(undefined)).toBeNull();
  });

  it('temporarily overrides a reused Desktop session for one headless turn', () => {
    const context = {
      agentKind: 'codex',
      workingDir: '/repo',
      sessionId: 'reused-desktop-session',
    };
    const releaseFirst = beginHeadlessGhostSetupTurn(context.sessionId);
    const releaseSecond = beginHeadlessGhostSetupTurn(context.sessionId);

    expect(isHeadlessGhostSetupTurn(context.sessionId)).toBe(true);
    expect(ghostSetupInteractionSessionId(context)).toBeNull();
    releaseFirst();
    expect(ghostSetupInteractionSessionId(context)).toBeNull();
    releaseSecond();
    expect(isHeadlessGhostSetupTurn(context.sessionId)).toBe(false);
    expect(ghostSetupInteractionSessionId(context)).toBe(context.sessionId);
  });
});
