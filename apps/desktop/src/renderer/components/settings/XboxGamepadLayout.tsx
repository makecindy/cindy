import type { CSSProperties } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type {
  XboxGamepadButtonId,
  XboxGamepadLayout as XboxGamepadLayoutModel,
  XboxGamepadPreviewInput,
  XboxGamepadStickId,
} from '../../../shared/xboxGamepad';
import * as Art from './xboxSeriesSilhouette';

export type XboxGamepadEditablePart = XboxGamepadButtonId | XboxGamepadStickId;

export interface XboxGamepadKeyHint {
  legend: string;
  name?: string | null;
  description?: string | null;
}

export interface XboxGamepadLayoutProps {
  layout: XboxGamepadLayoutModel;
  disabled?: boolean;
  hintFor(part: XboxGamepadEditablePart): XboxGamepadKeyHint;
  onEdit(part: XboxGamepadEditablePart): void;
  preview: XboxGamepadPreviewInput | null;
  labels: {
    leftStick: string;
    rightStick: string;
  };
  /** Switch Pro shares the Xbox stick layout; only the printed chrome changes. */
  variant?: 'xbox' | 'nintendo';
}

/** Colleague Xbox Series art, already cropped to the display board. */
const VIEWBOX = { x: 0, y: 0, w: 1050, h: 660 };

const PRESS_FILL = 'currentColor';
const PRESS_OPACITY = 0.2;
const STICK_TRAVEL = 14;
/** Cap fill so the moving stick occludes the well and the socket behind it. */
const CARVE = 'var(--settings-theme-card-bg)';

const FACE_CENTER = {
  y: [803.7, 213.2] as const,
  x: [728.2, 287.3] as const,
  b: [873.9, 278.7] as const,
  a: [799.6, 351.9] as const,
};

export function XboxGamepadLayout({
  disabled = false,
  hintFor,
  onEdit,
  preview,
  labels,
  variant = 'xbox',
}: XboxGamepadLayoutProps) {
  const pressed = (id: XboxGamepadButtonId) => preview?.buttons[id] ?? false;
  const analog = (id: XboxGamepadStickId) => preview?.sticks[id] ?? { x: 0, y: 0 };
  const trigger = (id: 'lt' | 'rt') => preview?.triggers[id] ?? 0;
  const nintendo = variant === 'nintendo';

  return (
    <div
      className="relative mx-auto w-full max-w-[560px] text-[var(--text-primary)]"
      data-testid={nintendo ? 'switch-gamepad-layout' : 'xbox-gamepad-layout'}
      style={{ aspectRatio: `${VIEWBOX.w} / ${VIEWBOX.h}` }}
    >
      <svg
        viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
        className="pointer-events-none absolute inset-0 h-full w-full"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d={Art.BODY} strokeWidth="3" />

        <Press d={Art.PRESS_LT} on={pressed('lt') || trigger('lt') > 0.08} />
        <Press d={Art.PRESS_RT} on={pressed('rt') || trigger('rt') > 0.08} />
        <Press d={Art.PRESS_LB} on={pressed('lb')} />
        <Press d={Art.PRESS_RB} on={pressed('rb')} />

        <path d={Art.BUMPER_TOP} />
        <path d={Art.BUMPER_MID} />
        <path d={Art.BUMPER_BOTTOM} />
        <path d={Art.BUMPER_NOTCH} />
        <path d={Art.LT_TICK} />
        <path d={Art.RT_TICK} />

        {!nintendo && (
          <g>
            <path d={Art.PAIRING_PILL} />
            <path d={Art.PAIRING_CREASE} />
            <path d={Art.PAIRING_CHEVRON_1} />
            <path d={Art.PAIRING_CHEVRON_2} />
            <path d={Art.PAIRING_CHEVRON_3} />
          </g>
        )}

        <Stick
          well={Art.STICK_LEFT_WELL}
          ring={Art.STICK_LEFT_RING}
          cap={Art.STICK_LEFT_CAP}
          dish={Art.STICK_LEFT_DISH}
          press={Art.PRESS_STICK_LEFT}
          socket={{ cx: 250.04, cy: 271.0, r: 34.71 }}
          analog={analog('left')}
          clicked={pressed('ls')}
        />
        <Stick
          well={Art.STICK_RIGHT_WELL}
          ring={Art.STICK_RIGHT_RING}
          cap={Art.STICK_RIGHT_CAP}
          dish={Art.STICK_RIGHT_DISH}
          press={Art.PRESS_STICK_RIGHT}
          socket={{ cx: 661.92, cy: 427.49, r: 33.68 }}
          analog={analog('right')}
          clicked={pressed('rs')}
        />

        <path d={Art.DPAD_DISC_OUTER} />
        <path d={Art.DPAD_DISC_INNER} />
        <path d={Art.DPAD_CROSS} />
        <path d={Art.DPAD_CENTER} />
        <path d={Art.DPAD_SEAMS} />
        <Press d={Art.PRESS_DPAD_UP} on={pressed('dpadUp')} />
        <Press d={Art.PRESS_DPAD_DOWN} on={pressed('dpadDown')} />
        <Press d={Art.PRESS_DPAD_LEFT} on={pressed('dpadLeft')} />
        <Press d={Art.PRESS_DPAD_RIGHT} on={pressed('dpadRight')} />

        <path d={Art.FACE_Y_OUTER} />
        <path d={Art.FACE_Y_INNER} />
        <path d={Art.FACE_X_OUTER} />
        <path d={Art.FACE_X_INNER} />
        <path d={Art.FACE_B_OUTER} />
        <path d={Art.FACE_B_INNER} />
        <path d={Art.FACE_A_OUTER} />
        <path d={Art.FACE_A_INNER} />
        {nintendo ? (
          <>
            <FaceLetter center={FACE_CENTER.y} label="X" />
            <FaceLetter center={FACE_CENTER.x} label="Y" />
            <FaceLetter center={FACE_CENTER.b} label="A" />
            <FaceLetter center={FACE_CENTER.a} label="B" />
          </>
        ) : (
          <g fill="currentColor" stroke="none">
            <path d={Art.FACE_Y_GLYPH} />
            <path d={Art.FACE_X_GLYPH} />
            <path d={Art.FACE_B_GLYPH} />
            <path d={Art.FACE_A_GLYPH} />
          </g>
        )}
        <Press d={Art.PRESS_Y} on={pressed('y')} />
        <Press d={Art.PRESS_X} on={pressed('x')} />
        <Press d={Art.PRESS_B} on={pressed('b')} />
        <Press d={Art.PRESS_A} on={pressed('a')} />

        <path d={Art.VIEW_OUTER} />
        <path d={Art.VIEW_INNER} />
        {nintendo ? (
          <path d="M 436.2 289.1 H 456.2" strokeWidth="2.4" />
        ) : (
          <g fill="currentColor" stroke="none">
            <path d={Art.VIEW_GLYPH_WINDOWS} />
            <path d={Art.VIEW_GLYPH_STACK} />
          </g>
        )}
        <Press d={Art.PRESS_VIEW} on={pressed('view')} />

        <path d={Art.MENU_OUTER} />
        <path d={Art.MENU_INNER} />
        {nintendo ? (
          <path d="M 592.4 288.4 H 612.4 M 602.4 278.4 V 298.4" strokeWidth="2.4" />
        ) : (
          <g fill="currentColor" stroke="none">
            <path d={Art.MENU_BAR_1} />
            <path d={Art.MENU_BAR_2} />
            <path d={Art.MENU_BAR_3} />
          </g>
        )}
        <Press d={Art.PRESS_MENU} on={pressed('menu')} />

        {/* Share is decoration: capsule only, no binding slot. */}
        <path d={Art.SHARE_OUTER} />
        <path d={Art.SHARE_INNER} />

        {nintendo ? (
          <>
            <circle
              cx="524.4"
              cy="179.7"
              r="28"
              fill={pressed('xbox') ? PRESS_FILL : 'none'}
              fillOpacity={pressed('xbox') ? PRESS_OPACITY : undefined}
            />
            <path
              d="M 524.4 162 L 540 174 V 196 H 532 V 186 H 516.8 V 196 H 508.8 V 174 Z"
              strokeWidth="2"
            />
          </>
        ) : (
          <>
            <path d={Art.GUIDE_EMBLEM} fill="currentColor" stroke="none" />
            <Press d={Art.PRESS_GUIDE} on={pressed('xbox')} />
          </>
        )}
      </svg>

      <svg
        viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
        className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
        fill="none"
        stroke="none"
      >
        <PathHit part="lt" d={Art.PRESS_LT} hint={hintFor('lt')} disabled={disabled} pressed={pressed('lt')} onEdit={onEdit} />
        <PathHit part="rt" d={Art.PRESS_RT} hint={hintFor('rt')} disabled={disabled} pressed={pressed('rt')} onEdit={onEdit} />
        <PathHit part="lb" d={Art.PRESS_LB} hint={hintFor('lb')} disabled={disabled} pressed={pressed('lb')} onEdit={onEdit} />
        <PathHit part="rb" d={Art.PRESS_RB} hint={hintFor('rb')} disabled={disabled} pressed={pressed('rb')} onEdit={onEdit} />
        <g data-testid="xbox-gamepad-dpad">
          <PathHit part="dpadUp" d={Art.PRESS_DPAD_UP} hint={hintFor('dpadUp')} disabled={disabled} pressed={pressed('dpadUp')} onEdit={onEdit} />
          <PathHit part="dpadDown" d={Art.PRESS_DPAD_DOWN} hint={hintFor('dpadDown')} disabled={disabled} pressed={pressed('dpadDown')} onEdit={onEdit} />
          <PathHit part="dpadLeft" d={Art.PRESS_DPAD_LEFT} hint={hintFor('dpadLeft')} disabled={disabled} pressed={pressed('dpadLeft')} onEdit={onEdit} />
          <PathHit part="dpadRight" d={Art.PRESS_DPAD_RIGHT} hint={hintFor('dpadRight')} disabled={disabled} pressed={pressed('dpadRight')} onEdit={onEdit} />
        </g>
      </svg>

      <Hit part="xbox" hint={hintFor('xbox')} disabled={disabled} pressed={pressed('xbox')} onEdit={onEdit} box={[484.3, 139.1, 80.3, 81.1]} />
      <Hit part="view" hint={hintFor('view')} disabled={disabled} pressed={pressed('view')} onEdit={onEdit} box={[424.7, 268.3, 42.9, 41.6]} round />
      <Hit part="menu" hint={hintFor('menu')} disabled={disabled} pressed={pressed('menu')} onEdit={onEdit} box={[582.0, 268.1, 40.6, 40.7]} round />

      <Hit
        part="left"
        hint={hintFor('left')}
        disabled={disabled}
        pressed={pressed('ls')}
        onEdit={onEdit}
        box={[182.7, 237.3, 123.9, 128.7]}
        round
        testId="xbox-gamepad-stick-left"
        title={labels.leftStick}
      />
      <Hit
        part="right"
        hint={hintFor('right')}
        disabled={disabled}
        pressed={pressed('rs')}
        onEdit={onEdit}
        box={[600.6, 394.4, 123.6, 129.6]}
        round
        testId="xbox-gamepad-stick-right"
        title={labels.rightStick}
      />

      <div data-testid="xbox-gamepad-face">
        <Hit part="y" hint={hintFor('y')} disabled={disabled} pressed={pressed('y')} onEdit={onEdit} box={[768.8, 180.6, 69.9, 65.2]} round />
        <Hit part="x" hint={hintFor('x')} disabled={disabled} pressed={pressed('x')} onEdit={onEdit} box={[693.2, 253.8, 70.0, 67.1]} round />
        <Hit part="b" hint={hintFor('b')} disabled={disabled} pressed={pressed('b')} onEdit={onEdit} box={[840.4, 245.5, 67.0, 66.5]} round />
        <Hit part="a" hint={hintFor('a')} disabled={disabled} pressed={pressed('a')} onEdit={onEdit} box={[767.0, 319.9, 65.2, 64.1]} round />
      </div>
    </div>
  );
}

function boxStyle([x, y, w, h]: [number, number, number, number]): CSSProperties {
  return {
    left: `${((x - VIEWBOX.x) / VIEWBOX.w) * 100}%`,
    top: `${((y - VIEWBOX.y) / VIEWBOX.h) * 100}%`,
    width: `${(w / VIEWBOX.w) * 100}%`,
    height: `${(h / VIEWBOX.h) * 100}%`,
  };
}

function PathHit({
  part,
  d,
  hint,
  disabled,
  pressed,
  onEdit,
}: {
  part: XboxGamepadEditablePart;
  d: string;
  hint: XboxGamepadKeyHint;
  disabled: boolean;
  pressed: boolean;
  onEdit(part: XboxGamepadEditablePart): void;
}) {
  const label = [hint.legend, hint.name].filter(Boolean).join(' ');
  return (
    <Tip text={<KeyHint hint={hint} />} side="top">
      <path
        d={d}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        className={cn(
          'fill-transparent stroke-none hover:fill-current/20',
          disabled ? 'pointer-events-none' : 'pointer-events-auto cursor-pointer',
          'focus-visible:outline-none focus-visible:stroke-[var(--focus-ring-soft)] focus-visible:stroke-2',
        )}
        onClick={() => {
          if (!disabled) onEdit(part);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onEdit(part);
          }
        }}
      />
    </Tip>
  );
}

function Hit({
  part,
  hint,
  disabled,
  pressed,
  onEdit,
  box,
  round = false,
  testId,
  title,
}: {
  part: XboxGamepadEditablePart;
  hint: XboxGamepadKeyHint;
  disabled: boolean;
  pressed: boolean;
  onEdit(part: XboxGamepadEditablePart): void;
  box: [number, number, number, number];
  round?: boolean;
  testId?: string;
  title?: string;
}) {
  const label = [hint.legend, hint.name].filter(Boolean).join(' ');
  return (
    <Tip text={<KeyHint hint={hint} />} side="top">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        title={title}
        disabled={disabled}
        data-testid={testId}
        onClick={() => onEdit(part)}
        style={boxStyle(box)}
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

function Press({ d, on }: { d: string; on: boolean }) {
  if (!on) return null;
  return <path d={d} fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} stroke="none" />;
}

function Stick({
  well,
  ring,
  cap,
  dish,
  press,
  socket,
  analog,
  clicked,
}: {
  well: string;
  ring: string;
  cap: string;
  dish: string;
  press: string;
  socket: { cx: number; cy: number; r: number };
  analog: { x: number; y: number };
  clicked: boolean;
}) {
  const dx = Math.max(-1, Math.min(1, analog.x)) * STICK_TRAVEL;
  const dy = -Math.max(-1, Math.min(1, analog.y)) * STICK_TRAVEL;
  return (
    <g>
      <path d={well} />
      <path d={ring} />
      <circle cx={socket.cx} cy={socket.cy} r={socket.r} />
      <g transform={`translate(${dx} ${dy})`}>
        <path d={cap} fill={CARVE} />
        {clicked && <Press d={press} on />}
        <path d={dish} />
      </g>
    </g>
  );
}

function FaceLetter({ center, label }: { center: readonly [number, number]; label: string }) {
  const [cx, cy] = center;
  return (
    <text
      x={cx}
      y={cy + 2}
      textAnchor="middle"
      dominantBaseline="middle"
      fill="currentColor"
      stroke="none"
      fontSize="20"
      fontWeight="600"
      fontFamily="Inter, system-ui, sans-serif"
    >
      {label}
    </text>
  );
}

function KeyHint({ hint }: { hint: XboxGamepadKeyHint }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-semibold">{hint.legend}</span>
      {hint.name && <span>{hint.name}</span>}
      {hint.description && <span className="text-[var(--text-tertiary)]">{hint.description}</span>}
    </span>
  );
}
