import { describe, expect, it } from 'vitest';

import { currentBuddyName } from '../BotStartedTasks';

type Bots = Parameters<typeof currentBuddyName>[2];
const bots = (([
  { id: 'bot-1', name: 'Muffin', sessions: [{ id: 'session-1', role: 'canonical' }] },
]) as unknown) as Bots;

describe('currentBuddyName', () => {
  it('uses the current name for a buddy chat on this computer', () => {
    expect(currentBuddyName('session-1', true, bots)).toBe('Muffin');
  });

  it('matches a bare canonical id after a device prefix', () => {
    expect(currentBuddyName('remote-mac::session-1', true, bots)).toBe('Muffin');
  });

  // A remote copy can share the bare id with the local buddy's canonical chat.
  // Borrowing the local name there would label the remote task with the wrong buddy.
  it('keeps the remote title when the session belongs to another computer', () => {
    expect(currentBuddyName('remote-mac::session-1', false, bots)).toBeNull();
    expect(currentBuddyName('session-1', false, bots)).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(currentBuddyName('session-other', true, bots)).toBeNull();
    expect(currentBuddyName(undefined, true, bots)).toBeNull();
  });
});

