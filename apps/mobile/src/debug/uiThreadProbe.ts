/**
 * Tells a hung native main thread apart from a busy JS thread, which `js stall` cannot.
 *
 * A ping is stamped when it leaves JS and again when the UI runtime runs it, so the lag excludes
 * the time JS takes to read the reply. A force quit during a hang would never deliver the reply,
 * so a ping still outstanding is reported by the JS tick and flushed before that can happen.
 *
 * "Unanswered" is deliberately not "unresponsive": the reply is delivered by a JS callback, so a
 * JS thread busy for seconds leaves the ping outstanding even though the UI thread ran it at once.
 * The report therefore says only that no reply arrived; read it with `loopLag` to tell the two apart.
 */
export const UI_THREAD_STALL_MS = 500;
export const UI_THREAD_UNANSWERED_MS = 3_000;

type Ping = (sentAt: number, arrived: (sentAt: number, arrivedAt: number) => void) => void;

export function createUiThreadProbe(options: {
  ping: Ping;
  now?: () => number;
  onLag: (lagMs: number) => void;
  onUnanswered: (pendingMs: number) => void;
}) {
  const now = options.now ?? Date.now;
  let pendingSince: number | null = null;
  let reported = false;
  return {
    /** Sends at most one ping at a time. Call only while the app is active. */
    sample(): void {
      if (pendingSince !== null) {
        const pendingMs = now() - pendingSince;
        if (!reported && pendingMs >= UI_THREAD_UNANSWERED_MS) {
          reported = true;
          options.onUnanswered(pendingMs);
        }
        return;
      }
      const sentAt = now();
      pendingSince = sentAt;
      reported = false;
      try {
        options.ping(sentAt, (from, arrivedAt) => {
          if (pendingSince !== from) return;
          pendingSince = null;
          options.onLag(Math.max(0, arrivedAt - from));
        });
      } catch {
        pendingSince = null;
      }
    },
    /** The main thread is expected to be idle or suspended outside the foreground. */
    reset(): void {
      pendingSince = null;
      reported = false;
    },
  };
}

export function createWorkletUiPing(): Ping | null {
  try {
    const { scheduleOnRN, scheduleOnUI } = require('react-native-worklets') as typeof import('react-native-worklets');
    return (sentAt, arrived) => {
      scheduleOnUI((from: number) => {
        'worklet';
        scheduleOnRN(arrived, from, Date.now());
      }, sentAt);
    };
  } catch {
    return null;
  }
}
