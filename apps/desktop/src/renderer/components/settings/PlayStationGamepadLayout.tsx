import type { CSSProperties } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { XboxGamepadButtonId, XboxGamepadStickId } from '../../../shared/xboxGamepad';

import type {
  XboxGamepadEditablePart,
  XboxGamepadKeyHint,
  XboxGamepadLayoutProps,
} from './XboxGamepadLayout';
import * as Art from './dualSenseSilhouette';
import type { EllipseGeom, RectGeom } from './dualSenseSilhouette';

/** Colleague DualSense art, already cropped to the display board. */
const VIEWBOX = { x: 0, y: 0, w: 1050, h: 660 };

const PRESS_FILL = 'currentColor';
const PRESS_OPACITY = 0.2;
const STICK_TRAVEL = 14;
/** Cap fill so the moving stick occludes the well and the socket behind it. */
const CARVE = 'var(--settings-theme-card-bg)';

export function PlayStationGamepadLayout({
  disabled = false,
  hintFor,
  onEdit,
  preview,
  labels,
}: XboxGamepadLayoutProps) {
  const pressed = (id: XboxGamepadButtonId) => preview?.buttons[id] ?? false;
  const analog = (id: XboxGamepadStickId) => preview?.sticks[id] ?? { x: 0, y: 0 };
  const trigger = (id: 'lt' | 'rt') => preview?.triggers[id] ?? 0;

  return (
    <div
      className="relative mx-auto w-full max-w-[560px] text-[var(--text-primary)]"
      data-testid="playstation-gamepad-layout"
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
        <path d={Art.BODY_LEFT} strokeWidth="2" />
        <path d={Art.BODY_RIGHT} strokeWidth="2" />
        <path d={Art.BUMPER_BOTTOM} strokeWidth="2" />
        <GeomRect geom={Art.USB_PORT} strokeWidth={2} />

        <Press d={Art.PRESS_L2} on={pressed('lt') || trigger('lt') > 0.08} />
        <Press d={Art.PRESS_R2} on={pressed('rt') || trigger('rt') > 0.08} />
        <Press d={Art.PRESS_L1} on={pressed('lb')} />
        <Press d={Art.PRESS_R1} on={pressed('rb')} />

        <path d={Art.L2_TICK} strokeWidth="2" />
        <path d={Art.R2_TICK} strokeWidth="2" />
        <path d={Art.L1_BODY} strokeWidth="2" />
        <path d={Art.L1_CREASE} strokeWidth="2" />
        <path d={Art.R1_BODY} strokeWidth="2" />
        <path d={Art.R1_CREASE} strokeWidth="2" />

        <path d={Art.TOUCHPAD_OUTER} strokeWidth="2" />
        <path d={Art.TOUCHPAD_INNER} strokeWidth="2" />

        <GeomRect geom={Art.CREATE_OUTER} strokeWidth={2} />
        <GeomRect geom={Art.CREATE_INNER} strokeWidth={2} />
        {Art.CREATE_BARS.map((bar, index) => (
          <GeomRect key={index} geom={bar} fill="currentColor" stroke="none" />
        ))}
        <PressRect geom={Art.PRESS_CREATE} on={pressed('view')} />

        <GeomRect geom={Art.OPTIONS_OUTER} strokeWidth={2} />
        <GeomRect geom={Art.OPTIONS_INNER} strokeWidth={2} />
        {Art.OPTIONS_BARS.map((bar, index) => (
          <GeomRect key={index} geom={bar} fill="currentColor" stroke="none" />
        ))}
        <PressRect geom={Art.PRESS_OPTIONS} on={pressed('menu')} />

        <path d={Art.PS_BUTTON} fill="currentColor" stroke="none" />
        <Press d={Art.PRESS_PS} on={pressed('xbox')} />

        {Art.SPEAKER_DOTS.map((dot, index) => (
          <circle key={index} cx={dot.cx} cy={dot.cy} r={dot.r} fill="currentColor" stroke="none" />
        ))}
        <path d={Art.SPEAKER_BLOB} fill="currentColor" stroke="none" />

        <GeomRect geom={Art.MUTE_BODY} strokeWidth={2} />
        <path d={Art.MUTE_CREASE} strokeWidth="2" />

        <Stick
          well={Art.STICK_LEFT_WELL}
          ring={Art.STICK_LEFT_RING}
          cap={Art.STICK_LEFT_CAP}
          socket={Art.STICK_LEFT_SOCKET}
          press={Art.PRESS_STICK_LEFT}
          analog={analog('left')}
          clicked={pressed('ls')}
        />
        <Stick
          well={Art.STICK_RIGHT_WELL}
          ring={Art.STICK_RIGHT_RING}
          cap={Art.STICK_RIGHT_CAP}
          socket={Art.STICK_RIGHT_SOCKET}
          press={Art.PRESS_STICK_RIGHT}
          analog={analog('right')}
          clicked={pressed('rs')}
        />

        <path d={Art.DPAD_UP_OUTER} strokeWidth="2" />
        <path d={Art.DPAD_UP_INNER} strokeWidth="2" />
        <polygon points={Art.DPAD_UP_ARROW} fill="currentColor" stroke="none" />
        <path d={Art.DPAD_LEFT_OUTER} strokeWidth="2" />
        <path d={Art.DPAD_LEFT_INNER} strokeWidth="2" />
        <polygon points={Art.DPAD_LEFT_ARROW} fill="currentColor" stroke="none" />
        <path d={Art.DPAD_RIGHT_OUTER} strokeWidth="2" />
        <path d={Art.DPAD_RIGHT_INNER} strokeWidth="2" />
        <polygon points={Art.DPAD_RIGHT_ARROW} fill="currentColor" stroke="none" />
        <path d={Art.DPAD_DOWN_OUTER} strokeWidth="2" />
        <path d={Art.DPAD_DOWN_INNER} strokeWidth="2" />
        <polygon points={Art.DPAD_DOWN_ARROW} fill="currentColor" stroke="none" />
        <Press d={Art.PRESS_DPAD_UP} on={pressed('dpadUp')} />
        <Press d={Art.PRESS_DPAD_DOWN} on={pressed('dpadDown')} />
        <Press d={Art.PRESS_DPAD_LEFT} on={pressed('dpadLeft')} />
        <Press d={Art.PRESS_DPAD_RIGHT} on={pressed('dpadRight')} />

        <GeomEllipse geom={Art.FACE_TRIANGLE_RING} />
        <path d={Art.FACE_TRIANGLE_RING_PATH} />
        <polygon points={Art.FACE_TRIANGLE_GLYPH} fill="none" stroke="currentColor" strokeWidth="5" />
        <PressEllipse geom={Art.PRESS_TRIANGLE} on={pressed('y')} />

        <GeomEllipse geom={Art.FACE_SQUARE_RING} />
        <GeomEllipse geom={Art.FACE_SQUARE_RING_OUTER} />
        <GeomRect geom={Art.FACE_SQUARE_GLYPH} strokeWidth={5} />
        <PressEllipse geom={Art.PRESS_SQUARE} on={pressed('x')} />

        <GeomEllipse geom={Art.FACE_CIRCLE_RING} />
        <path d={Art.FACE_CIRCLE_RING_PATH} />
        <GeomEllipse geom={Art.FACE_CIRCLE_GLYPH} strokeWidth={5} />
        <PressEllipse geom={Art.PRESS_CIRCLE} on={pressed('b')} />

        <GeomEllipse geom={Art.FACE_CROSS_RING} />
        <path d={Art.FACE_CROSS_RING_PATH} />
        <line
          x1={Art.FACE_CROSS_LINE_A.x1}
          y1={Art.FACE_CROSS_LINE_A.y1}
          x2={Art.FACE_CROSS_LINE_A.x2}
          y2={Art.FACE_CROSS_LINE_A.y2}
          strokeWidth="5"
        />
        <line
          x1={Art.FACE_CROSS_LINE_B.x1}
          y1={Art.FACE_CROSS_LINE_B.y1}
          x2={Art.FACE_CROSS_LINE_B.x2}
          y2={Art.FACE_CROSS_LINE_B.y2}
          strokeWidth="5"
        />
        <PressEllipse geom={Art.PRESS_CROSS} on={pressed('a')} />
      </svg>

      <svg
        viewBox={`${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`}
        className="pointer-events-none absolute inset-0 z-[2] h-full w-full"
        fill="none"
        stroke="none"
      >
        <PathHit part="lt" d={Art.PRESS_L2} hint={hintFor('lt')} disabled={disabled} pressed={pressed('lt')} onEdit={onEdit} />
        <PathHit part="rt" d={Art.PRESS_R2} hint={hintFor('rt')} disabled={disabled} pressed={pressed('rt')} onEdit={onEdit} />
        <PathHit part="lb" d={Art.PRESS_L1} hint={hintFor('lb')} disabled={disabled} pressed={pressed('lb')} onEdit={onEdit} />
        <PathHit part="rb" d={Art.PRESS_R1} hint={hintFor('rb')} disabled={disabled} pressed={pressed('rb')} onEdit={onEdit} />
        <g data-testid="playstation-gamepad-dpad">
          <PathHit part="dpadUp" d={Art.PRESS_DPAD_UP} hint={hintFor('dpadUp')} disabled={disabled} pressed={pressed('dpadUp')} onEdit={onEdit} />
          <PathHit part="dpadDown" d={Art.PRESS_DPAD_DOWN} hint={hintFor('dpadDown')} disabled={disabled} pressed={pressed('dpadDown')} onEdit={onEdit} />
          <PathHit part="dpadLeft" d={Art.PRESS_DPAD_LEFT} hint={hintFor('dpadLeft')} disabled={disabled} pressed={pressed('dpadLeft')} onEdit={onEdit} />
          <PathHit part="dpadRight" d={Art.PRESS_DPAD_RIGHT} hint={hintFor('dpadRight')} disabled={disabled} pressed={pressed('dpadRight')} onEdit={onEdit} />
        </g>
      </svg>

      <Hit part="xbox" hint={hintFor('xbox')} disabled={disabled} pressed={pressed('xbox')} onEdit={onEdit} box={[495, 438, 67, 39]} />
      <Hit part="view" hint={hintFor('view')} disabled={disabled} pressed={pressed('view')} onEdit={onEdit} box={[245, 217, 34, 48]} />
      <Hit part="menu" hint={hintFor('menu')} disabled={disabled} pressed={pressed('menu')} onEdit={onEdit} box={[775, 217, 34, 48]} />

      <Hit
        part="left"
        hint={hintFor('left')}
        disabled={disabled}
        pressed={pressed('ls')}
        onEdit={onEdit}
        box={[276, 428, 158, 152]}
        round
        testId="playstation-gamepad-stick-left"
        title={labels.leftStick}
      />
      <Hit
        part="right"
        hint={hintFor('right')}
        disabled={disabled}
        pressed={pressed('rs')}
        onEdit={onEdit}
        box={[618, 428, 158, 152]}
        round
        testId="playstation-gamepad-stick-right"
        title={labels.rightStick}
      />

      <div data-testid="playstation-gamepad-face">
        <Hit part="y" hint={hintFor('y')} disabled={disabled} pressed={pressed('y')} onEdit={onEdit} box={[844, 250, 65, 61]} round />
        <Hit part="x" hint={hintFor('x')} disabled={disabled} pressed={pressed('x')} onEdit={onEdit} box={[760, 322, 65, 59]} round />
        <Hit part="b" hint={hintFor('b')} disabled={disabled} pressed={pressed('b')} onEdit={onEdit} box={[920, 320, 65, 59]} round />
        <Hit part="a" hint={hintFor('a')} disabled={disabled} pressed={pressed('a')} onEdit={onEdit} box={[838, 386, 65, 61]} round />
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

function PressEllipse({ geom, on }: { geom: EllipseGeom; on: boolean }) {
  if (!on) return null;
  return (
    <ellipse
      cx={geom.cx}
      cy={geom.cy}
      rx={geom.rx}
      ry={geom.ry}
      fill={PRESS_FILL}
      fillOpacity={PRESS_OPACITY}
      stroke="none"
    />
  );
}

function PressRect({ geom, on }: { geom: RectGeom; on: boolean }) {
  if (!on) return null;
  return <GeomRect geom={geom} fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} stroke="none" />;
}

function GeomEllipse({
  geom,
  fill,
  strokeWidth,
}: {
  geom: EllipseGeom;
  fill?: string;
  strokeWidth?: number;
}) {
  return (
    <ellipse
      cx={geom.cx}
      cy={geom.cy}
      rx={geom.rx}
      ry={geom.ry}
      fill={fill}
      strokeWidth={strokeWidth}
    />
  );
}

function GeomRect({
  geom,
  fill,
  fillOpacity,
  stroke,
  strokeWidth,
}: {
  geom: RectGeom;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
}) {
  return (
    <rect
      x={geom.x}
      y={geom.y}
      width={geom.width}
      height={geom.height}
      rx={geom.rx}
      ry={geom.ry}
      transform={geom.transform}
      fill={fill}
      fillOpacity={fillOpacity}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  );
}

function Stick({
  well,
  ring,
  cap,
  socket,
  press,
  analog,
  clicked,
}: {
  well: EllipseGeom;
  ring: EllipseGeom;
  cap: string;
  socket: EllipseGeom;
  press: string;
  analog: { x: number; y: number };
  clicked: boolean;
}) {
  const dx = Math.max(-1, Math.min(1, analog.x)) * STICK_TRAVEL;
  const dy = -Math.max(-1, Math.min(1, analog.y)) * STICK_TRAVEL;
  return (
    <g>
      <GeomEllipse geom={well} />
      <GeomEllipse geom={socket} />
      <g transform={`translate(${dx} ${dy})`}>
        <GeomEllipse geom={ring} fill={CARVE} />
        <path d={cap} fill={CARVE} />
        {clicked && <Press d={press} on />}
      </g>
    </g>
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
