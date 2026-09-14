import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { GamepadGeom } from './gamepadSilhouetteGeom';
import type { XboxGamepadEditablePart, XboxGamepadKeyHint } from './XboxGamepadLayout';

/** Colleague gamepad art, already cropped to the display board. */
export const GAMEPAD_VIEWBOX = { x: 0, y: 0, w: 1050, h: 660 };

export const GAMEPAD_PRESS_FILL = 'currentColor';
export const GAMEPAD_PRESS_OPACITY = 0.2;
export const GAMEPAD_STICK_TRAVEL = 14;
/** Cap fill so the moving stick occludes the well behind it. */
export const GAMEPAD_CARVE = 'var(--settings-theme-card-bg)';

export function analogTranslate(
  analog: { x: number; y: number },
  travel = GAMEPAD_STICK_TRAVEL,
): string {
  const dx = Math.max(-1, Math.min(1, analog.x)) * travel;
  const dy = -Math.max(-1, Math.min(1, analog.y)) * travel;
  return `translate(${dx} ${dy})`;
}

export function GeomShape({
  geom,
  fill,
  fillOpacity,
  stroke,
  strokeWidth,
}: {
  geom: GamepadGeom;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
}) {
  const filled = geom.paint === 'fill';
  const common = {
    fill: fill ?? (filled ? 'currentColor' : 'none'),
    fillOpacity,
    stroke: stroke ?? (filled ? 'none' : undefined),
    strokeWidth: strokeWidth ?? geom.strokeWidth,
  };
  switch (geom.kind) {
    case 'path':
      return <path d={geom.d} {...common} />;
    case 'line':
      return <line x1={geom.x1} y1={geom.y1} x2={geom.x2} y2={geom.y2} {...common} />;
    case 'polyline':
      return <polyline points={geom.points} {...common} />;
    case 'polygon':
      return <polygon points={geom.points} {...common} />;
    case 'ellipse':
      return <ellipse cx={geom.cx} cy={geom.cy} rx={geom.rx} ry={geom.ry} {...common} />;
    case 'circle':
      return <circle cx={geom.cx} cy={geom.cy} r={geom.r} {...common} />;
    case 'rect':
      return (
        <rect
          x={geom.x}
          y={geom.y}
          width={geom.width}
          height={geom.height}
          rx={geom.rx}
          ry={geom.ry}
          transform={geom.transform}
          {...common}
        />
      );
  }
}

export function GeomShapes({ geoms }: { geoms: readonly GamepadGeom[] }) {
  return (
    <>
      {geoms.map((geom, index) => (
        <GeomShape key={index} geom={geom} />
      ))}
    </>
  );
}

export function PressGeom({ geom, on }: { geom: GamepadGeom; on: boolean }) {
  if (!on) return null;
  return (
    <GeomShape
      geom={geom}
      fill={GAMEPAD_PRESS_FILL}
      fillOpacity={GAMEPAD_PRESS_OPACITY}
      stroke="none"
    />
  );
}

export function AnalogStick({
  well,
  socket,
  moving,
  press,
  analog,
  clicked,
}: {
  well: readonly GamepadGeom[];
  /** Completed hole under the cap; colleague art only drew the top crescent. */
  socket: { cx: number; cy: number; r: number };
  moving: readonly GamepadGeom[];
  press: GamepadGeom;
  analog: { x: number; y: number };
  clicked: boolean;
}) {
  return (
    <g>
      <GeomShapes geoms={well} />
      <circle cx={socket.cx} cy={socket.cy} r={socket.r} />
      <g transform={analogTranslate(analog)}>
        {moving.map((geom, index) => (
          <GeomShape key={index} geom={geom} fill={index === 0 ? GAMEPAD_CARVE : undefined} />
        ))}
        <PressGeom geom={press} on={clicked} />
      </g>
    </g>
  );
}

export function KeyHint({ hint }: { hint: XboxGamepadKeyHint }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">{hint.legend}</span>
      {hint.name && <span>{hint.name}</span>}
      {hint.description && <span className="text-[var(--text-tertiary)]">{hint.description}</span>}
    </span>
  );
}

function hitHandlers(
  part: XboxGamepadEditablePart,
  hint: XboxGamepadKeyHint,
  disabled: boolean,
  pressed: boolean,
  onEdit: (part: XboxGamepadEditablePart) => void,
) {
  const label = [hint.legend, hint.name].filter(Boolean).join(' ');
  return {
    role: 'button' as const,
    tabIndex: disabled ? -1 : 0,
    'aria-label': label,
    'aria-pressed': pressed,
    'aria-disabled': disabled || undefined,
    className: cn(
      'fill-transparent stroke-none hover:fill-current/20',
      disabled ? 'pointer-events-none' : 'pointer-events-auto cursor-pointer',
      'focus-visible:outline-none focus-visible:stroke-[var(--focus-ring-soft)] focus-visible:stroke-2',
    ),
    onClick: () => {
      if (!disabled) onEdit(part);
    },
    onKeyDown: (event: KeyboardEvent<SVGElement>) => {
      if (disabled) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onEdit(part);
      }
    },
  };
}

export function GeomHit({
  part,
  geom,
  hint,
  disabled,
  pressed,
  onEdit,
}: {
  part: XboxGamepadEditablePart;
  geom: GamepadGeom;
  hint: XboxGamepadKeyHint;
  disabled: boolean;
  pressed: boolean;
  onEdit(part: XboxGamepadEditablePart): void;
}) {
  const handlers = hitHandlers(part, hint, disabled, pressed, onEdit);
  let shape: ReactNode;
  switch (geom.kind) {
    case 'path':
      shape = <path d={geom.d} {...handlers} />;
      break;
    case 'ellipse':
      shape = <ellipse cx={geom.cx} cy={geom.cy} rx={geom.rx} ry={geom.ry} {...handlers} />;
      break;
    case 'circle':
      shape = <circle cx={geom.cx} cy={geom.cy} r={geom.r} {...handlers} />;
      break;
    case 'rect':
      shape = (
        <rect
          x={geom.x}
          y={geom.y}
          width={geom.width}
          height={geom.height}
          rx={geom.rx}
          ry={geom.ry}
          transform={geom.transform}
          {...handlers}
        />
      );
      break;
    case 'polygon':
      shape = <polygon points={geom.points} {...handlers} />;
      break;
    case 'polyline':
      shape = <polyline points={geom.points} {...handlers} />;
      break;
    case 'line':
      shape = <line x1={geom.x1} y1={geom.y1} x2={geom.x2} y2={geom.y2} {...handlers} />;
      break;
  }
  return (
    <Tip text={<KeyHint hint={hint} />} side="top">
      {shape}
    </Tip>
  );
}

function boxStyle(
  viewBox: typeof GAMEPAD_VIEWBOX,
  [x, y, w, h]: [number, number, number, number],
): CSSProperties {
  return {
    left: `${((x - viewBox.x) / viewBox.w) * 100}%`,
    top: `${((y - viewBox.y) / viewBox.h) * 100}%`,
    width: `${(w / viewBox.w) * 100}%`,
    height: `${(h / viewBox.h) * 100}%`,
  };
}

export function Hit({
  part,
  hint,
  disabled,
  pressed,
  onEdit,
  box,
  round = false,
  testId,
}: {
  part: XboxGamepadEditablePart;
  hint: XboxGamepadKeyHint;
  disabled: boolean;
  pressed: boolean;
  onEdit(part: XboxGamepadEditablePart): void;
  box: [number, number, number, number];
  round?: boolean;
  testId?: string;
}) {
  const label = [hint.legend, hint.name].filter(Boolean).join(' ');
  return (
    <Tip text={<KeyHint hint={hint} />} side="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        data-testid={testId}
        onClick={() => onEdit(part)}
        style={boxStyle(GAMEPAD_VIEWBOX, box)}
        className={cn(
          'absolute z-[1] border-0 bg-transparent',
          round ? 'rounded-full' : 'rounded-[8px]',
          !disabled && 'cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      />
    </Tip>
  );
}

export function GamepadArtBoard({
  testId,
  children,
  hits,
  overlays,
}: {
  testId: string;
  children: ReactNode;
  hits: ReactNode;
  overlays?: ReactNode;
}) {
  const { x, y, w, h } = GAMEPAD_VIEWBOX;
  return (
    <div
      className="relative mx-auto w-full max-w-[560px] text-[var(--text-primary)]"
      data-testid={testId}
      style={{ aspectRatio: `${w} / ${h}` }}
    >
      <svg
        viewBox={`${x} ${y} ${w} ${h}`}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {children}
      </svg>
      <svg
        viewBox={`${x} ${y} ${w} ${h}`}
        className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
        fill="none"
        stroke="none"
      >
        {hits}
      </svg>
      {overlays}
    </div>
  );
}
