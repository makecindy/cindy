import { performance } from 'node:perf_hooks';

export type NotificationSoundKind = 'done' | 'error' | 'needs-reply';

export type NotificationSoundClaim = { status: 'play'; token: string } | { status: 'covered' };

export const NOTIFICATION_SOUND_COOLDOWN_MS = 1_500;

// The reservation only covers the renderer's bounded Audio.play() startup
// attempt. A crashed or disconnected renderer must not silence all future
// notifications forever.
const SOUND_RESERVATION_TIMEOUT_MS = 1_000;

const lastPlayedAtByKind = new Map<NotificationSoundKind, number>();
const reservationsByKind = new Map<NotificationSoundKind, { token: string; expiresAt: number }>();
let nextToken = 0;

function monotonicNow(): number {
  return performance.now();
}

export function claimNotificationSound(
  kind: NotificationSoundKind,
  now = monotonicNow(),
): NotificationSoundClaim {
  const lastPlayedAt = lastPlayedAtByKind.get(kind);
  if (
    lastPlayedAt !== undefined &&
    now >= lastPlayedAt &&
    now - lastPlayedAt < NOTIFICATION_SOUND_COOLDOWN_MS
  ) {
    return { status: 'covered' };
  }

  const existing = reservationsByKind.get(kind);
  if (existing && existing.expiresAt > now) return { status: 'covered' };
  if (existing) reservationsByKind.delete(kind);

  const token = `notification-sound-${++nextToken}`;
  reservationsByKind.set(kind, {
    token,
    expiresAt: now + SOUND_RESERVATION_TIMEOUT_MS,
  });
  return { status: 'play', token };
}

export function settleNotificationSound(
  kind: NotificationSoundKind,
  token: string,
  started: boolean,
  now = monotonicNow(),
): void {
  const reservation = reservationsByKind.get(kind);
  if (!reservation || reservation.token !== token) return;
  reservationsByKind.delete(kind);
  if (started) lastPlayedAtByKind.set(kind, now);
}

/** Only for isolated unit tests; production state is process-owned. */
export function resetNotificationSoundCoordinatorForTest(): void {
  lastPlayedAtByKind.clear();
  reservationsByKind.clear();
  nextToken = 0;
}
