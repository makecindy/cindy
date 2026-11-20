import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  binThinkingMarks,
  formatCompactTokens,
  thinkingStrokeLength,
  type RateMark,
} from '@cindy/maker-shared/usage-format';
import { cn } from '@/lib/utils';

/** Strokes a turn of any length is drawn with: its requests are grouped into this many time slices. */
const THINKING_COLUMNS = 28;
const PAD_LEFT = 4;
const PAD_RIGHT = 8;
const SPEED_TOP = 8;
const STROKE_GAP = 3;
const STROKE_FLOOR = 1.5;

export interface TraceChartPoint {
  /** Position on the generation-time axis, in ms. */
  at: number;
  rate: number;
  settled?: boolean;
}

function formatClock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Generation speed over a time axis, with the reasoning each model request
 * spent drawn beneath the baseline at the moment the request finished. The
 * running-status popover draws it live; the usage details draw the same picture
 * for a finished turn.
 *
 * The halves carry no labels. Moving the pointer over the chart (or pressing on
 * a touch screen) picks a moment and says what is there: the speed at it, and
 * the reasoning of the requests that finished in its slice when there was any.
 *
 * Without any reported reasoning the lower half is left out, and the chart is
 * the plain speed sparkline it was before.
 */
export function GenerationTraceChart({
  points,
  marks,
  fromMs,
  toMs,
  width,
  speedHeight: fullSpeedHeight,
  strokeHeight,
  liveDot = false,
  fixedSize = false,
  label,
  className,
}: {
  points: readonly TraceChartPoint[];
  marks: readonly RateMark[];
  fromMs: number;
  toMs: number;
  /** viewBox units; the element scales to its CSS size. */
  width: number;
  speedHeight: number;
  strokeHeight: number;
  /** Mark the newest reading, as the live chart does. */
  liveDot?: boolean;
  /** Render at exactly the viewBox size instead of scaling to the CSS box. */
  fixedSize?: boolean;
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  // The picked slice, and where its readout goes on screen. The live chart redraws
  // under a resting pointer, so what is shown is read from the data on every render.
  const [pick, setPick] = useState<{ column: number } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pick) return;
    const clear = () => setPick(null);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    window.addEventListener('blur', clear);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
      window.removeEventListener('blur', clear);
      window.removeEventListener('keydown', escape);
    };
  }, [pick]);
  const plotWidth = width - PAD_LEFT - PAD_RIGHT;
  const span = toMs - fromMs;
  const columns = binThinkingMarks(marks, fromMs, toMs, THINKING_COLUMNS);
  const maxThinking = Math.max(0, ...columns.map((column) => column.thinkingTokens ?? 0));
  const showThinking = columns.some((column) => column.thinkingTokens !== null);
  // A finished turn too short for a curve keeps only its strokes, not an empty band above them.
  // The live chart holds its height: its curve is still to come.
  const speedHeight = liveDot || points.some(point => point.settled) || points.length > 1 || !showThinking ? fullSpeedHeight : STROKE_GAP;
  const height = speedHeight + (showThinking ? STROKE_GAP + strokeHeight + 1 : 4);
  const ceiling = Math.max(1, ...points.map((point) => point.rate));
  const yOf = (rate: number) => speedHeight - (rate / ceiling) * (speedHeight - SPEED_TOP);
  const xy = points.map((point) => ({
    x: span > 0 ? PAD_LEFT + ((point.at - fromMs) / span) * plotWidth : PAD_LEFT + plotWidth,
    y: yOf(point.rate),
  }));
  const line = xy.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  const last = xy.at(-1);
  const pitch = plotWidth / THINKING_COLUMNS;
  const strokeWidth = Math.max(1.5, Math.min(5, pitch * 0.45));
  const columnX = (column: number) => PAD_LEFT + (column + 0.5) * pitch;
  const strokeTop = speedHeight + STROKE_GAP;
  const strokeEnd = (tokens: number) =>
    strokeTop + thinkingStrokeLength(tokens, maxThinking, strokeHeight, STROKE_FLOOR);

  // There is a moment to pick once the curve exists.
  const pickable = xy.length > 1 && span > 0;
  const picked = pickable && pick ? pick.column : null;
  const cursorTime = picked === null ? 0 : fromMs + ((picked + 0.5) / THINKING_COLUMNS) * span;
  // Pick a reading that was actually measured. A line between two settled requests
  // is only a visual guide; intermediate times have no measured speed.
  const sample = picked === null ? undefined : points.reduce((nearest, point) =>
    Math.abs(point.at - cursorTime) < Math.abs(nearest.at - cursorTime) ? point : nearest);
  const pickedAt = sample?.at ?? 0;
  const pickedRate = sample?.rate ?? 0;
  const pickedX = span > 0 ? PAD_LEFT + ((pickedAt - fromMs) / span) * plotWidth : PAD_LEFT + plotWidth;
  const pickedThinking = picked === null
    ? null : columns.find((column) => column.column === picked)?.thinkingTokens ?? null;
  const onPick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const x = ((event.clientX - box.left) / box.width) * width;
    const column = Math.min(THINKING_COLUMNS - 1, Math.max(0, Math.floor(((x - PAD_LEFT) / plotWidth) * THINKING_COLUMNS)));
    if (pick?.column === column) return;
    setPick({ column });
  };

  const anchor = useMemo(() => ({
    getBoundingClientRect: () => {
      const rect = chartRef.current?.getBoundingClientRect();
      if (!rect || !pick) return new DOMRect();
      return new DOMRect(rect.left + ((PAD_LEFT + (pick.column + 0.5) *
        (width - PAD_LEFT - PAD_RIGHT) / THINKING_COLUMNS) / width) * rect.width, rect.top, 0, rect.height);
    },
    contextElement: chartRef.current ?? undefined,
  }), [pick, width]);
  const { refs, floatingStyles } = useFloating({
    open: picked !== null,
    strategy: 'fixed',
    placement: 'top',
    elements: { reference: anchor },
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8, crossAxis: true })],
    whileElementsMounted: autoUpdate,
  });

  return (
    <div
      ref={chartRef}
      className={cn('relative', pickable && 'cursor-crosshair touch-none', className)}
      // Down as well as move: on a touch screen a press picks the moment.
      onPointerMove={pickable ? onPick : undefined}
      onPointerDown={pickable ? onPick : undefined}
      onPointerLeave={pickable ? () => setPick(null) : undefined}
      onPointerCancel={() => setPick(null)}
      onPointerUp={(event) => { if (event.pointerType === 'touch') setPick(null); }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        {...(fixedSize ? { width, height } : {})}
        className={cn('block text-[var(--text-primary)]', !fixedSize && 'h-auto w-full')}
        role="img"
        aria-label={label}
      >
        <path d={`M${PAD_LEFT} ${speedHeight}H${PAD_LEFT + plotWidth}`} stroke="currentColor" opacity="0.12" />
        {xy.length > 1 && (
          <>
            <path
              d={`${line} L${xy[xy.length - 1].x},${speedHeight} L${xy[0].x},${speedHeight} Z`}
              fill="currentColor"
              opacity="0.08"
            />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </>
        )}
        {xy.map((point, index) => points[index].settled && (
          <circle key={index} cx={point.x} cy={point.y} r="2" fill="currentColor">
            <title>{t('chat.runningStatus.lastRequestRate')}</title>
          </circle>
        ))}
        {liveDot && last && (
          <circle cx={last.x} cy={last.y} r="2.5" fill="currentColor" opacity={picked === null ? 1 : 0.35} />
        )}
        {showThinking && columns.map((column) => {
          if (column.thinkingTokens === null) return null;
          const x = columnX(column.column);
          return (
            <path
              key={column.column}
              data-testid="thinking-stroke"
              d={`M${x} ${strokeTop}V${strokeEnd(column.thinkingTokens)}`}
              stroke="currentColor"
              strokeWidth={strokeWidth}
              opacity={picked === null ? 0.45 : picked === column.column ? 1 : 0.22}
            />
          );
        })}
        {picked !== null && (
          <g data-testid="trace-pick">
            {/* Only between the two values it ties together: from the speed at that moment down to
                the end of that slice's stroke, or to the baseline when the slice has none. */}
            <path
              d={`M${pickedX} ${yOf(pickedRate)}L${columnX(picked)} ${pickedThinking === null ? speedHeight : strokeEnd(pickedThinking)}`}
              stroke="currentColor"
              strokeWidth="0.75"
              opacity="0.55"
            />
            <circle
              cx={pickedX}
              cy={yOf(pickedRate)}
              r="3.2"
              fill="var(--surface-elevated)"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </g>
        )}
      </svg>
      {picked !== null && pick && createPortal(
        // A portal with fixed position: the usage details scroll and would clip it. Above the
        // chart, so it covers neither the strokes nor the figures under them.
        <div
          ref={refs.setFloating}
          aria-hidden="true"
          data-testid="trace-readout"
          className="pointer-events-none fixed left-0 top-0 z-[10011] w-max max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-hidden select-none rounded-xl bg-[var(--tooltip-bg)] px-2.5 py-1.5 text-12 leading-normal tabular-nums text-[var(--tooltip-text)] shadow-[shadow:var(--shadow-menu)]"
          style={floatingStyles}
        >
          <div className="flex justify-between gap-3">
            <span>{sample?.settled
              ? `${t('chat.runningStatus.lastRequestRate')} · ${t('chat.runningStatus.tokenRate', { rate: Math.round(pickedRate * 10) / 10 })}`
              : t('usageDetails.performanceRateLine', { rate: Math.round(pickedRate * 10) / 10 })}</span>
            <span className="opacity-60">{formatClock(pickedAt - fromMs)}</span>
          </div>
          {/* Only a real amount is worth a line: nothing finished in the slice, nothing reported,
              or no reasoning at all says nothing more than the missing line does. */}
          {pickedThinking !== null && pickedThinking > 0 && (
            <div>{t('usageDetails.traceThinkingTokens', { thinking: formatCompactTokens(pickedThinking) })}</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
