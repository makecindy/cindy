import { describe, expect, it, beforeEach } from 'vitest';

import {
  claimNotificationSound,
  NOTIFICATION_SOUND_COOLDOWN_MS,
  resetNotificationSoundCoordinatorForTest,
  settleNotificationSound,
} from '../notificationSoundCoordinator';

describe('notificationSoundCoordinator', () => {
  beforeEach(() => resetNotificationSoundCoordinatorForTest());

  it('allows one renderer to play and covers concurrent renderers', () => {
    const first = claimNotificationSound('done', 100);
    const second = claimNotificationSound('done', 101);

    expect(first.status).toBe('play');
    expect(second).toEqual({ status: 'covered' });
  });

  it('starts the cooldown only after a successful settlement', () => {
    const claim = claimNotificationSound('done', 100);
    if (claim.status !== 'play') throw new Error('expected a play claim');

    settleNotificationSound('done', claim.token, true, 200);

    expect(claimNotificationSound('done', 200 + NOTIFICATION_SOUND_COOLDOWN_MS - 1)).toEqual({
      status: 'covered',
    });
    expect(claimNotificationSound('done', 200 + NOTIFICATION_SOUND_COOLDOWN_MS)).toMatchObject({
      status: 'play',
    });
  });

  it('releases a failed attempt so the next event can retry', () => {
    const claim = claimNotificationSound('error', 100);
    if (claim.status !== 'play') throw new Error('expected a play claim');

    settleNotificationSound('error', claim.token, false, 200);

    expect(claimNotificationSound('error', 201).status).toBe('play');
  });

  it('expires a reservation from a renderer that disappeared', () => {
    expect(claimNotificationSound('needs-reply', 100).status).toBe('play');
    expect(claimNotificationSound('needs-reply', 1_101).status).toBe('play');
  });

  it('ignores stale settlements from an older renderer', () => {
    const first = claimNotificationSound('done', 100);
    if (first.status !== 'play') throw new Error('expected a play claim');
    settleNotificationSound('done', first.token, false, 200);

    const second = claimNotificationSound('done', 201);
    if (second.status !== 'play') throw new Error('expected a retry claim');
    settleNotificationSound('done', first.token, true, 202);

    expect(claimNotificationSound('done', 203).status).toBe('covered');
    settleNotificationSound('done', second.token, false, 204);
    expect(claimNotificationSound('done', 205).status).toBe('play');
  });
});
