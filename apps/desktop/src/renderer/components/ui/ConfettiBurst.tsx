/** Shared one-shot canvas engine: a full Star burst and a small upward quota reveal. */
import { useEffect, useRef } from 'react';
import type { Options } from 'canvas-confetti';
import { createPortal } from 'react-dom';
import { parseCssColor, toHex } from '../../../shared/theme-import/color';

/** Separate visual presets share loading, accessibility, coordinates and cleanup. */
const BURST_PRESETS = {
  star: { particleCount: 160, spread: 360, startVelocity: 30, gravity: 1.6, ticks: 140 },
  quota: {
    particleCount: 18,
    angle: 90,
    spread: 80,
    startVelocity: 5.5,
    decay: 0.92,
    gravity: 0.35,
    ticks: 105,
    scalar: 0.45,
  },
} satisfies Record<'star' | 'quota', Options>;

const QUOTA_COLOR_TOKENS = [
  '--card-status-done',
  '--card-status-awaiting',
  '--warning-accent',
  '--card-status-error',
];

function readQuotaColors(): string[] {
  const styles = getComputedStyle(document.documentElement);
  return QUOTA_COLOR_TOKENS.flatMap((token) => {
    const color = parseCssColor(styles.getPropertyValue(token).trim());
    return color ? [toHex(color)] : [];
  });
}

interface ConfettiBurstProps {
  /** Original activation position in viewport CSS pixels, not the current cursor. */
  origin: { x: number; y: number };
  onDone: () => void;
  zIndex?: number;
  preset?: 'star' | 'quota';
}

export function ConfettiBurst({
  origin,
  onDone,
  zIndex = 10101,
  preset = 'star',
}: ConfettiBurstProps) {
  const originRef = useRef(origin);
  const presetRef = useRef(preset);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const done = () => {
      if (!disposed) onDoneRef.current();
    };
    if (reduced()) {
      done();
      return;
    }
    // Load only for an explicit celebration. A dedicated canvas keeps cleanup local.
    void import('canvas-confetti')
      .then(({ default: confetti }) => {
        if (disposed) return;
        const canvas = canvasRef.current;
        if (!canvas || reduced()) {
          done();
          return;
        }
        // Use the main thread so the effect needs no blob-worker CSP exception.
        const fire = confetti.create(canvas, { resize: true, useWorker: false });
        stop = () => fire.reset();
        const rect = canvas.getBoundingClientRect();
        const width = rect.width || window.innerWidth;
        const height = rect.height || window.innerHeight;
        const clamp = (value: number) => Math.max(0, Math.min(1, value));
        const preset = presetRef.current;
        const colors = preset === 'quota' ? readQuotaColors() : undefined;
        // Skip a malformed theme rather than introducing unrelated fallback colors.
        if (colors && colors.length !== QUOTA_COLOR_TOKENS.length) {
          done();
          return;
        }
        return Promise.resolve(
          fire({
            ...BURST_PRESETS[preset],
            ...(colors ? { colors } : {}),
            origin: {
              x: clamp((originRef.current.x - rect.left) / Math.max(1, width)),
              y: clamp((originRef.current.y - rect.top) / Math.max(1, height)),
            },
            disableForReducedMotion: true,
          }),
        ).then(done);
      })
      .catch(done);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  return createPortal(
    <canvas
      ref={canvasRef}
      data-confetti-burst
      data-confetti-preset={preset}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 h-full w-full"
      style={{ zIndex }}
    />,
    document.body,
  );
}
