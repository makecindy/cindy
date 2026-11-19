import { useEffect, useRef, useState } from 'react';
import { useDocumentVisible } from '@/hooks/useWindowVisible';

interface ClockInput {
  sessionId: string | null;
  deviceId: string | null;
  enabled: boolean;
  /** Renderer turn identity, used only to invalidate old reads. */
  turnKey: number | null;
  running: boolean;
  endedAt?: number | null;
}

interface SessionClockRow {
  id: string;
  activeTurnStartedAt?: number | null;
  lastTurnEndedAt?: number | null;
  turnElapsedMs?: number | null;
}

interface Sample {
  key: string;
  hostStart: number;
  elapsedMs: number;
  receivedAt: number;
  running: boolean;
}

export function useTurnElapsed({
  sessionId, deviceId, turnKey, running, enabled, endedAt,
}: ClockInput): number | null {
  const documentVisible = useDocumentVisible();
  const [windowHidden, setWindowHidden] = useState(false);
  useEffect(() => window.electronAPI?.onWindowHiddenChange?.(setWindowHidden), []);
  const active = enabled && documentVisible && !windowHidden;
  const key = JSON.stringify([deviceId, sessionId, turnKey]);
  const [sample, setSample] = useState<Sample | null>(null);
  const observed = useRef<Sample | null>(null);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!active || !sessionId || turnKey === null) {
      setSample(null);
      return;
    }
    const id = sessionId;
    let cancelled = false;
    let inFlight = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 250;

    async function sync() {
      if (cancelled || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      clearTimeout(retry);
      try {
        const row = (deviceId
          ? await window.electronAPI.deviceLink.invoke(deviceId, 'local-db:sessions:get', [id])
          : await window.electronAPI.localDb.sessions.get(id)) as SessionClockRow | null;
        if (cancelled || row?.id !== id) return;
        // Old hosts have no elapsed sample. A supported host can temporarily have no
        // marker while its running/terminal event races the durable marker write.
        if (row.turnElapsedMs === undefined) {
          setSample(null);
          return;
        }
        const start = row.activeTurnStartedAt;
        const previous = observed.current?.key === key ? observed.current : null;
        // A final sample belongs to the observed host turn, or (for a very short
        // turn) to the durable completion just delivered in the session patch.
        const matchesCompletion = previous ? previous.hostStart === start
          : endedAt != null && row.lastTurnEndedAt === endedAt;
        if (typeof start === 'number' && Number.isFinite(start) && start > 0 &&
            typeof row.turnElapsedMs === 'number' && Number.isFinite(row.turnElapsedMs) && row.turnElapsedMs >= 0 &&
            running === (start > (row.lastTurnEndedAt ?? 0)) &&
            (!previous || start >= previous.hostStart) && (running || matchesCompletion)) {
          const receivedAt = performance.now();
          const next = { key, hostStart: start, elapsedMs: row.turnElapsedMs, receivedAt, running };
          observed.current = next;
          setSample(next);
          setNow(receivedAt);
          return;
        }
      } catch {
        if (cancelled) return;
      } finally {
        inFlight = false;
      }
      setSample(null);
      // Only retry a missing or racing sample. A settled clock ticks without network traffic.
      if (running || retryDelay <= 2000) {
        retry = setTimeout(sync, retryDelay);
        retryDelay = Math.min(15000, retryDelay * 2);
      }
    }

    function resume() {
      if (document.visibilityState !== 'hidden') void sync();
    }
    void sync();
    window.addEventListener('focus', resume);
    let lastTick = Date.now();
    const interval = running ? setInterval(() => {
      const wallNow = Date.now();
      // performance.now can pause in sleep on macOS. A delayed tick also catches
      // wake with the same window still focused; wall time never feeds elapsed.
      if (Math.abs(wallNow - lastTick) > 3000) resume();
      lastTick = wallNow;
      setNow(performance.now());
    }, 1000) : undefined;
    return () => {
      cancelled = true;
      clearTimeout(retry);
      clearInterval(interval);
      window.removeEventListener('focus', resume);
    };
  }, [deviceId, active, endedAt, key, running, sessionId, turnKey]);

  if (!active || sample?.key !== key || sample.running !== running) return null;
  return sample.elapsedMs + (running ? Math.max(0, now - sample.receivedAt) : 0);
}
