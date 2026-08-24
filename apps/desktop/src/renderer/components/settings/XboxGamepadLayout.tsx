import type { CSSProperties } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type {
  XboxGamepadButtonId,
  XboxGamepadLayout as XboxGamepadLayoutModel,
  XboxGamepadPreviewInput,
  XboxGamepadStickId,
} from '../../../shared/xboxGamepad';

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
}

/**
 * Drawn over Dash's Xbox Series line-art in its own pixel grid, then verified
 * by rasterizing this SVG and diffing it against that reference — every
 * coordinate below is measured, not guessed. The viewBox is the reference
 * crop, so a measurement on the picture can be used here as-is.
 */
const VIEWBOX = { x: 60, y: 80, w: 1050, h: 660 };

/** Outer silhouette traced along the reference's outline stroke. */
const BODY_PATH =
  'M 282 89 C 286 89 292 88 297 89 C 302 90 306 91 310 93 C 314 95 317 97 320 102 C 324 108 327 122 331 126 C 335 131 336 129 342 129 C 349 129 363 128 370 128 C 377 128 380 129 384 130 C 388 131 393 134 396 136 C 400 139 402 143 405 145 C 409 148 413 150 417 151 C 421 152 422 153 431 153 C 440 153 459 153 473 153 C 487 153 501 153 515 153 C 529 153 543 153 557 153 C 571 153 585 153 599 153 C 613 153 627 153 641 153 C 655 153 669 153 683 153 C 697 153 716 153 725 153 C 734 153 734 153 739 153 C 744 153 749 153 753 151 C 757 150 761 147 765 144 C 769 141 771 138 775 135 C 779 133 783 130 787 129 C 791 128 794 128 801 128 C 808 128 823 130 829 129 C 836 128 836 129 840 124 C 844 119 848 105 852 100 C 856 95 859 94 863 92 C 867 90 872 89 876 89 C 881 89 886 89 890 90 C 895 91 899 92 903 94 C 907 96 909 96 914 103 C 919 111 928 127 935 139 C 942 151 951 165 957 175 C 963 185 967 193 971 199 C 975 205 976 201 980 209 C 984 217 991 234 996 246 C 1001 259 1006 271 1011 284 C 1016 297 1021 310 1026 323 C 1031 336 1036 348 1041 361 C 1046 374 1051 386 1055 399 C 1060 412 1064 424 1068 437 C 1072 450 1076 463 1080 476 C 1084 489 1087 502 1090 515 C 1093 528 1096 546 1098 555 C 1100 564 1100 562 1101 569 C 1102 576 1103 588 1103 597 C 1103 606 1102 616 1101 625 C 1100 634 1099 641 1095 651 C 1091 661 1082 677 1075 686 C 1069 695 1065 699 1056 705 C 1047 711 1030 719 1020 723 C 1010 727 1001 729 994 730 C 987 731 989 732 980 730 C 971 728 954 723 941 718 C 929 713 917 705 905 698 C 893 691 881 685 869 678 C 857 671 843 663 833 658 C 823 653 820 649 809 646 C 798 643 782 640 768 639 C 754 638 740 639 726 639 C 712 639 698 639 684 639 C 670 639 656 639 642 639 C 628 639 614 639 600 639 C 586 639 572 639 558 639 C 544 639 530 639 516 639 C 502 639 488 639 474 639 C 460 639 444 639 432 639 C 420 639 413 638 404 639 C 395 640 383 642 376 643 C 369 644 371 643 363 646 C 355 650 338 658 326 664 C 314 670 302 677 290 684 C 278 691 266 698 254 704 C 242 711 228 719 218 723 C 208 727 199 729 192 730 C 185 731 187 732 178 730 C 169 728 150 723 139 719 C 129 715 121 710 115 706 C 109 702 108 700 104 697 C 101 694 98 692 94 686 C 90 680 82 668 79 662 C 76 656 76 658 74 649 C 72 640 68 620 67 608 C 66 597 66 589 67 580 C 68 571 70 563 72 552 C 74 541 77 525 80 512 C 83 499 89 482 91 473 C 93 464 93 464 94 460 C 95 456 98 451 99 447 C 100 443 99 443 102 434 C 105 426 111 409 116 396 C 121 383 126 370 131 357 C 136 344 141 332 146 319 C 151 306 156 294 161 281 C 166 268 172 254 176 243 C 180 232 183 223 186 217 C 189 211 190 209 193 205 C 196 201 197 202 202 194 C 207 186 217 170 224 158 C 231 146 238 133 244 123 C 250 113 255 104 259 99 C 264 94 267 94 271 92 C 275 90 278 90 282 89 Z';

/**
 * The d-pad is a raised cross on a disc. Each arm's sides run out to the disc
 * edge — the edge itself closes the arm tips — and the inner corners meet in
 * rounded fillets, so the middle is a true cross with no center plate.
 */
/**
 * Public Xbox emblem (88×88), four petals. Scaled onto the guide button so
 * the X is the leftover gap — not two crossed strokes.
 */
const XBOX_EMBLEM_PATH =
  'M39.73 86.91c-6.628-.635-13.338-3.015-19.102-6.776-4.83-3.15-5.92-4.447-5.92-7.032 0-5.193 5.71-14.29 15.48-24.658 5.547-5.89 13.275-12.79 14.11-12.604 1.626.363 14.616 13.034 19.48 19 7.69 9.43 11.224 17.154 9.428 20.597-1.365 2.617-9.837 7.733-16.06 9.698-5.13 1.62-11.867 2.306-17.416 1.775zM8.184 67.703c-4.014-6.158-6.042-12.22-7.02-20.988-.324-2.895-.21-4.55.733-10.494 1.173-7.4 5.39-15.97 10.46-21.24 2.158-2.24 2.35-2.3 4.982-1.41 3.19 1.08 6.6 3.436 11.89 8.22l3.09 2.794-1.69 2.07c-7.828 9.61-16.09 23.24-19.2 31.67-1.69 4.58-2.37 9.18-1.64 11.095.49 1.294.04.812-1.61-1.714zm70.453 1.047c.397-1.936-.105-5.49-1.28-9.076-2.545-7.765-11.054-22.21-18.867-32.032l-2.46-3.092 2.662-2.443c3.474-3.19 5.886-5.1 8.49-6.723 2.053-1.28 4.988-2.413 6.25-2.413.777 0 3.516 2.85 5.726 5.95 3.424 4.8 5.942 10.63 7.218 16.69.825 3.92.894 12.3.133 16.21-.63 3.208-1.95 7.366-3.23 10.187-.97 2.113-3.36 6.218-4.41 7.554-.54.687-.54.686-.24-.796zM40.44 11.505C36.834 9.675 31.272 7.71 28.2 7.18c-1.076-.185-2.913-.29-4.08-.23-2.536.128-2.423-.004 1.643-1.925 3.38-1.597 6.2-2.536 10.03-3.34C40.098.78 48.193.77 52.43 1.663c4.575.965 9.964 2.97 13 4.84l.904.554-2.07-.104C60.148 6.745 54.15 8.408 47.71 11.54c-1.942.946-3.63 1.7-3.754 1.68-.123-.024-1.706-.795-3.52-1.715z';

const DPAD_DISC = { cx: 447, cy: 522, rx: 75, ry: 72 };

/**
 * Arm sides run out to the disc. Endpoints are the ellipse intersections so
 * the disc stroke itself closes each tip — no flat chord.
 */
const DPAD_CROSS_PATH = [
  'M 421 454.5 V 486 Q 421 496 411 496 H 377.1',
  'M 377.1 548 H 411 Q 421 548 421 558 V 589.5',
  'M 473 589.5 V 558 Q 473 548 483 548 H 516.9',
  'M 516.9 496 H 483 Q 473 496 473 486 V 454.5',
].join(' ');

type Point = [number, number];

const LEFT_STICK: Point = [311, 366];
const RIGHT_STICK: Point = [724, 524];
const FACE: Record<'y' | 'x' | 'b' | 'a', Point> = {
  y: [861, 296],
  x: [787, 369],
  b: [931, 360],
  a: [860, 432],
};

/** Backing color for carved / inverted glyphs — the card the drawing sits on. */
const CARVE = 'var(--settings-theme-card-bg)';

/** Shared press overlay — same gray on every control. */
const PRESS_FILL = 'currentColor';
const PRESS_OPACITY = 0.2;

export function XboxGamepadLayout({
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
      data-testid="xbox-gamepad-layout"
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
        <path d={BODY_PATH} strokeWidth="3" />

        {/* Trigger horns light up on pull; the horn itself is part of the outline. */}
        <HornFill side="left" on={pressed('lt') || trigger('lt') > 0.08} />
        <HornFill side="right" on={pressed('rt') || trigger('rt') > 0.08} />

        {/*
         * The bumper bar is its own plastic piece. Its top edge runs from the
         * shoulder tip, behind the trigger horn, down onto the deck; the seam
         * below runs tip to tip; the short vertical notches are where LB / RB
         * end against the center deck.
         */}
        <path d="M 205 198 C 214 178 226 161 240 149 C 272 143 300 140 332 137 C 362 139 390 145 416 152" />
        <path d="M 965 198 C 956 178 944 161 930 149 C 898 143 870 140 838 137 C 808 139 780 145 754 152" />
        <path d="M 205 199 C 290 191 360 188 435 188 C 535 186 635 186 735 188 C 810 188 880 191 965 199" />
        <path d="M 437 154 L 435 187 M 736 152 L 734 187" />
        <path d="M 440 172 C 545 170 640 170 731 172" />
        <BumperFill side="left" on={pressed('lb')} />
        <BumperFill side="right" on={pressed('rb')} />

        {/* Pairing oval and its ))) marks. */}
        <ellipse cx="505" cy="164" rx="12" ry="6" />
        <path d="M 527 159 C 529 162 529 166 527 169 M 535 158 C 538 161 538 167 535 170 M 543 156 C 547 160 547 168 543 172" />

        {/* Each trigger horn's near edge, wrapping down to the bumper. */}
        <path d="M 262 141 C 264 130 266 119 270 108 M 908 141 C 906 130 904 119 900 108" />

        <Stick center={LEFT_STICK} analog={analog('left')} clicked={pressed('ls')} />
        <Stick center={RIGHT_STICK} analog={analog('right')} clicked={pressed('rs')} />

        {/* D-pad disc and raised cross; pressed fill is clipped to the disc so tips follow the rim. */}
        <ellipse cx={DPAD_DISC.cx} cy={DPAD_DISC.cy} rx={DPAD_DISC.rx} ry={DPAD_DISC.ry} />
        <path d={DPAD_CROSS_PATH} />
        <clipPath id="xbox-dpad-disc">
          <ellipse cx={DPAD_DISC.cx} cy={DPAD_DISC.cy} rx={DPAD_DISC.rx} ry={DPAD_DISC.ry} />
        </clipPath>
        <g clipPath="url(#xbox-dpad-disc)" fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} stroke="none">
          {pressed('dpadUp') && <rect x="421" y="448" width="52" height="48" />}
          {pressed('dpadDown') && <rect x="421" y="548" width="52" height="48" />}
          {pressed('dpadLeft') && <rect x="370" y="496" width="51" height="52" />}
          {pressed('dpadRight') && <rect x="473" y="496" width="51" height="52" />}
        </g>

        <FaceButton center={FACE.y} label="Y" pressed={pressed('y')} />
        <FaceButton center={FACE.x} label="X" pressed={pressed('x')} />
        <FaceButton center={FACE.b} label="B" pressed={pressed('b')} />
        <FaceButton center={FACE.a} label="A" pressed={pressed('a')} />

        {/* View: two stacked screens, front one occludes the back. */}
        <circle
          cx="509"
          cy="369"
          r="22"
          fill={pressed('view') ? PRESS_FILL : 'none'}
          fillOpacity={pressed('view') ? PRESS_OPACITY : undefined}
        />
        <g stroke="currentColor" strokeWidth="1.8">
          <rect x="500" y="360" width="11" height="11" rx="1.6" fill="none" />
          <rect x="507" y="366" width="11" height="11" rx="1.6" fill={CARVE} />
        </g>
        <circle
          cx="661"
          cy="369"
          r="22"
          fill={pressed('menu') ? PRESS_FILL : 'none'}
          fillOpacity={pressed('menu') ? PRESS_OPACITY : undefined}
        />
        <path d="M 654 362 H 668 M 654 369 H 668 M 654 376 H 668" stroke="currentColor" strokeWidth="2" />
        {/* Share is decor: empty pill, no binding slot. */}
        <rect x="561.51" y="412.85" width="46.98" height="24.3" rx="12.15" />

        {/* Xbox guide: official four-petal emblem. The X is the gap between the leaves. */}
        <g transform="translate(546 222) scale(0.8409)" fill="currentColor" stroke="none">
          <path d={XBOX_EMBLEM_PATH} />
        </g>
        {pressed('xbox') && (
          <circle cx="583" cy="259" r="37" fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} stroke="none" />
        )}
      </svg>

      <Hit part="lt" hint={hintFor('lt')} disabled={disabled} pressed={pressed('lt')} onEdit={onEdit} box={[238, 86, 96, 62]} />
      <Hit part="rt" hint={hintFor('rt')} disabled={disabled} pressed={pressed('rt')} onEdit={onEdit} box={[836, 86, 96, 62]} />
      <Hit part="lb" hint={hintFor('lb')} disabled={disabled} pressed={pressed('lb')} onEdit={onEdit} box={[205, 136, 232, 64]} />
      <Hit part="rb" hint={hintFor('rb')} disabled={disabled} pressed={pressed('rb')} onEdit={onEdit} box={[734, 136, 231, 64]} />

      <Hit part="xbox" hint={hintFor('xbox')} disabled={disabled} pressed={pressed('xbox')} onEdit={onEdit} box={[546, 222, 74, 74]} round />
      <Hit part="view" hint={hintFor('view')} disabled={disabled} pressed={pressed('view')} onEdit={onEdit} box={[485, 345, 48, 48]} round />
      <Hit part="menu" hint={hintFor('menu')} disabled={disabled} pressed={pressed('menu')} onEdit={onEdit} box={[637, 345, 48, 48]} round />

      <Hit
        part="left"
        hint={hintFor('left')}
        disabled={disabled}
        pressed={pressed('ls')}
        onEdit={onEdit}
        box={[234, 292, 154, 148]}
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
        box={[647, 449, 154, 150]}
        round
        testId="xbox-gamepad-stick-right"
        title={labels.rightStick}
      />

      <div data-testid="xbox-gamepad-face">
        <Hit part="y" hint={hintFor('y')} disabled={disabled} pressed={pressed('y')} onEdit={onEdit} box={[825, 260, 72, 72]} round />
        <Hit part="x" hint={hintFor('x')} disabled={disabled} pressed={pressed('x')} onEdit={onEdit} box={[751, 333, 72, 72]} round />
        <Hit part="b" hint={hintFor('b')} disabled={disabled} pressed={pressed('b')} onEdit={onEdit} box={[895, 324, 72, 72]} round />
        <Hit part="a" hint={hintFor('a')} disabled={disabled} pressed={pressed('a')} onEdit={onEdit} box={[824, 396, 72, 72]} round />
      </div>

      <div data-testid="xbox-gamepad-dpad">
        <Hit part="dpadUp" hint={hintFor('dpadUp')} disabled={disabled} pressed={pressed('dpadUp')} onEdit={onEdit} box={[423, 459, 52, 38]} />
        <Hit part="dpadLeft" hint={hintFor('dpadLeft')} disabled={disabled} pressed={pressed('dpadLeft')} onEdit={onEdit} box={[383, 497, 40, 52]} />
        <Hit part="dpadRight" hint={hintFor('dpadRight')} disabled={disabled} pressed={pressed('dpadRight')} onEdit={onEdit} box={[475, 497, 42, 52]} />
        <Hit part="dpadDown" hint={hintFor('dpadDown')} disabled={disabled} pressed={pressed('dpadDown')} onEdit={onEdit} box={[423, 549, 52, 40]} />
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

/** Translucent fill inside the horn outline while the trigger is pulled. */
function HornFill({ side, on }: { side: 'left' | 'right'; on: boolean }) {
  if (!on) return null;
  const d =
    side === 'left'
      ? [
          'M 224 158',
          'C 231 146 238 133 244 123',
          'C 250 113 255 104 259 99',
          'C 264 94 267 94 271 92',
          'C 275 90 278 90 282 89',
          'C 286 89 292 88 297 89',
          'C 302 90 306 91 310 93',
          'C 314 95 317 97 320 102',
          'C 324 108 327 122 331 126',
          'L 332 137',
          'C 300 140 272 143 240 149',
          'Z',
        ].join(' ')
      : [
          'M 840 124',
          'C 844 119 848 105 852 100',
          'C 856 95 859 94 863 92',
          'C 867 90 872 89 876 89',
          'C 881 89 886 89 890 90',
          'C 895 91 899 92 903 94',
          'C 907 96 909 96 914 103',
          'C 919 111 928 127 935 139',
          'L 930 149',
          'C 898 143 870 140 838 137',
          'Z',
        ].join(' ');
  return <path d={d} fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} stroke="none" />;
}

/** Translucent fill over the bumper segment while it is held. */
function BumperFill({ side, on }: { side: 'left' | 'right'; on: boolean }) {
  if (!on) return null;
  const d =
    side === 'left'
      ? 'M 205 198 C 214 178 226 161 240 149 C 272 143 300 140 332 137 C 362 139 390 145 416 152 L 437 154 L 435 188 C 360 188 290 191 205 199 Z'
      : 'M 965 198 C 956 178 944 161 930 149 C 898 143 870 140 838 137 C 808 139 780 145 754 152 L 736 152 L 734 188 C 810 188 880 191 965 199 Z';
  return <path d={d} fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} stroke="none" />;
}

/**
 * A stick seen from above. The camera looks down into the recessed well, so
 * everything stacks toward the near (lower) side: the cap sits low in the
 * well, the concave top's floor sits low inside the cap — you look into the
 * dish, its far wall visible at the top. The leftover far-rim arc is completed
 * into a full circle behind the cap so the socket can be judged as a ring.
 * The cap group follows the live analog value.
 */
function Stick({
  center,
  analog,
  clicked,
}: {
  center: Point;
  analog: { x: number; y: number };
  clicked: boolean;
}) {
  const [cx, cy] = center;
  const dx = Math.max(-1, Math.min(1, analog.x)) * 14;
  const dy = -Math.max(-1, Math.min(1, analog.y)) * 14;
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx="77" ry="72" />
      {/* Full socket circle fitted to the leftover far-rim crescent. */}
      <circle cx={cx - 2} cy={cy - 3.2} r="44.8" />
      <g transform={`translate(${dx} ${dy})`}>
        <circle cx={cx - 2} cy={cy + 14} r="53" fill={CARVE} />
        {clicked && (
          <circle cx={cx - 2} cy={cy + 14} r="53" fill={PRESS_FILL} fillOpacity={PRESS_OPACITY} />
        )}
        <circle cx={cx - 3} cy={cy + 22} r="41" />
      </g>
    </g>
  );
}

function FaceButton({
  center,
  label,
  pressed,
}: {
  center: Point;
  label: string;
  pressed: boolean;
}) {
  const [cx, cy] = center;
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        r="36"
        fill={pressed ? PRESS_FILL : 'none'}
        fillOpacity={pressed ? PRESS_OPACITY : undefined}
      />
      <text
        x={cx}
        y={cy + 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        stroke="none"
        fontSize="28"
        fontWeight="600"
        fontFamily="Inter, system-ui, sans-serif"
      >
        {label}
      </text>
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
