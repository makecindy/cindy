import { useEffect, useState } from 'react';
import Animated, { Easing, cancelAnimation, useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import { Path } from 'react-native-svg';
import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';

// The Mac menu bar panel's opening, for the drawer usage card (DESIGN.md §14.4 「macOS menu bar
// quota fill」): the liquid rises, sloshes once it stops, and plain numbers count up. Ported from
// TubeView, LiquidSurface and CountUpText in apps/desktop/native/menubar/macos-menubar-helper.swift
// (the Windows card's port is renderer/quota-tray-tube.tsx). Times are seconds and stay in step
// with the Swift ones; its lengths are for a 34pt well and scale with the width of ours.
const MAC_WELL = 34;
/** Each tube starts this long after the one before it. */
export const TUBE_STAGGER = 0.06;
const RISE_SECONDS = 0.9;
const ARRIVAL = 0.5;
const SLOSH_TILT = 5;
const RISE_SHIVER = 0.3;
const RISE_ROCK = 1.1;
const RISE_ROCK_PERIOD = 0.34;
const SLOSH_SECONDS = 4.6;
const WAVE_PERIOD = 3.6;
const COUNT_FRAME_MS = 1000 / 30;
const TAU = 2 * Math.PI;

const between = (min: number, max: number) => min + Math.random() * (max - min);
/** One opening's slosh, drawn anew each time so no two openings move alike. */
export const randomSlosh = () => ({
  direction: Math.random() < 0.5 ? 1 : -1, strength: between(0.8, 1.15), period: between(0.82, 1.12),
  decay: between(1, 1.5), secondRatio: between(0.18, 0.4), secondPeriodRatio: between(0.4, 0.55),
  arrivalShift: between(-0.06, 0.08),
});
type Slosh = ReturnType<typeof randomSlosh>;

/** The panel's open/fill curve, control points (0.22, 1) and (0.36, 1), solved for `x`. */
function fillCurve(x: number): number {
  'worklet';
  const bezier = (t: number, p1: number, p2: number) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;
  let t = x;
  for (let pass = 0; pass < 6; pass++) {
    const slope = 3 * (1 - t) ** 2 * 0.22 + 6 * (1 - t) * t * (0.36 - 0.22) + 3 * t ** 2 * (1 - 0.36);
    if (slope < 1e-6) break;
    t = Math.max(0, Math.min(1, t - (bezier(t, 0.22, 0.36) - x) / slope));
  }
  return bezier(t, 1, 1);
}

type Well = { x: number; bottom: number; width: number; level: number; fraction: number; phase: number };

/**
 * The liquid `t` seconds into its own opening, as a path in the tube's coordinates. Its top edge
 * shivers and rocks while rising, then leans (left up, right down) and bows (edges up, middle
 * down) as the slosh decays; both average to zero, so the level reads the same. Afterwards it is
 * flat, with the same soft corners as the still liquid.
 */
export function openingLiquid(t: number, well: Well, slosh: Slosh): string {
  'worklet';
  const height = well.level * fillCurve(Math.max(0, Math.min(1, t / RISE_SECONDS)));
  if (height <= 0) return 'M0 0';
  const arrival = ARRIVAL + slosh.arrivalShift;
  let ripple = 0;
  let tilt = 0;
  let second = 0;
  if (t < arrival) {
    // Rising: a small quick rock that swells mid-climb and is level again on arrival.
    tilt = RISE_ROCK * (0.5 + 0.5 * well.fraction) * Math.sin(Math.PI * t / arrival) * Math.sin(TAU * t / RISE_ROCK_PERIOD) * slosh.direction;
    ripple = RISE_SHIVER;
  } else if (t < arrival + SLOSH_SECONDS) {
    // Stopped: inertia tips the surface side to side like a damped pendulum, with a faster,
    // smaller bow on top. A nearly full tube swings widely, a low one barely does.
    const s = t - arrival;
    const momentum = Math.max(0.04, well.fraction ** 1.5);
    tilt = slosh.direction * slosh.strength * SLOSH_TILT * momentum * Math.exp(-s / slosh.decay) * Math.sin(TAU * s / slosh.period);
    second = -slosh.direction * slosh.secondRatio * SLOSH_TILT * momentum
      * Math.exp(-s / (slosh.decay * 0.7)) * Math.sin(TAU * s / (slosh.period * slosh.secondPeriodRatio));
    ripple = RISE_SHIVER * Math.exp(-s / 0.6);
  }
  const scale = well.width / MAC_WELL;
  const amp = Math.min(ripple * scale, height / 4);
  const k = TAU / (well.width * 1.35);
  const phase = t * TAU / WAVE_PERIOD + well.phase;
  const top = well.bottom - height;
  const y = (x: number) => {
    const u = x / well.width;
    const wave = 0.65 * Math.sin(k * x + phase) + 0.35 * Math.sin(1.7 * k * x - 1.3 * phase);
    return top + amp * (1 + wave) - scale * (tilt * (1 - 2 * u) + second * Math.cos(TAU * u));
  };
  const n = (value: number) => value.toFixed(2);
  const corner = Math.min(4, height / 2, well.width / 4);
  // Drawn past the bottom: the well clips it.
  const floor = n(well.bottom + 4);
  const left = well.x;
  const right = well.x + well.width;
  let d = `M${n(left)} ${floor}L${n(left)} ${n(y(0) + corner)}Q${n(left)} ${n(y(0))} ${n(left + corner)} ${n(y(corner))}`;
  for (let step = 1; step < 16; step++) {
    const x = corner + (well.width - 2 * corner) * step / 16;
    d += `L${n(left + x)} ${n(y(x))}`;
  }
  return `${d}L${n(right - corner)} ${n(y(well.width - corner))}Q${n(right)} ${n(y(well.width))} ${n(right)} ${n(y(well.width) + corner)}L${n(right)} ${floor}Z`;
}

/**
 * Whether this mount plays the opening. A mount is one opening, so it is decided once, and only
 * a Reduce Motion setting known to be off plays it: otherwise the final picture shows, still.
 */
export function useOpeningMotion(): boolean {
  return useState(() => getCachedReduceMotionEnabled() === false)[0];
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** A tube's liquid rising from empty to `level` and sloshing to rest, drawn on the UI thread. */
export function OpeningLiquid({ x, bottom, width, level, fraction, index, fill, fillOpacity }: {
  x: number; bottom: number; width: number; level: number; fraction: number; index: number; fill: string; fillOpacity: number;
}) {
  const [slosh] = useState(randomSlosh);
  const clock = useSharedValue(0);
  useEffect(() => {
    // Past the end of the slosh the surface is flat, so the clock simply stops there.
    const seconds = index * TUBE_STAGGER + ARRIVAL + 0.1 + SLOSH_SECONDS;
    clock.value = withTiming(seconds, { duration: seconds * 1000, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [clock, index]);
  const animatedProps = useAnimatedProps(() => ({
    d: openingLiquid(clock.value - index * TUBE_STAGGER, { x, bottom, width, level, fraction, phase: index * 1.3 }, slosh),
  }));
  return <AnimatedPath animatedProps={animatedProps} fill={fill} fillOpacity={fillOpacity} />;
}

/** Text before the first digit, the digits with their separators, and text after the last digit. */
const NUMBER_TEXT = /^(\D*)(\d(?:[\s\S]*\d)?)(\D*)$/;

/**
 * Reads a displayed number with one locale's separators and returns how to write any value the
 * same way, or null when that reading does not write the text back exactly (a German "31,17"
 * read as en-US would otherwise count through amounts orders of magnitude off).
 */
function readNumber(core: string, locale: string): ((value: number) => string) & { value: number } | null {
  // Read the separators off a sample: Hermes has no `formatToParts` on iOS.
  const sample = /^12(\D?)345(\D)6$/.exec(new Intl.NumberFormat(locale).format(12345.6));
  if (!sample) return null;
  const [, group = '', decimal = '.'] = sample;
  const [whole = '', fraction = '', extra] = core.split(decimal);
  if (extra !== undefined) return null;
  const digits = group ? whole.split(group).join('') : whole;
  if (!/^\d+$/.test(digits) || !/^\d*$/.test(fraction)) return null;
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fraction.length, maximumFractionDigits: fraction.length, useGrouping: !!group && whole.includes(group),
  }).format;
  const value = Number(digits + '.' + (fraction || '0'));
  return format(value) === core ? Object.assign((n: number) => format(n), { value }) : null;
}

/**
 * How to count a displayed amount ("68", "62,500", "257K", "1.2M") up from zero, or null to show
 * it as-is. The text's own locale is tried first; abbreviated amounts may be written in en-US.
 * A shorter count is led by figure spaces, so the text keeps its width and nothing beside it moves.
 */
export function countUpFrames(text: string, locale: string): ((progress: number) => string) | null {
  const match = NUMBER_TEXT.exec(text);
  if (!match) return null;
  const [, prefix = '', core = '', suffix = ''] = match;
  let read: ReturnType<typeof readNumber> = null;
  try {
    read = readNumber(core, locale) ?? readNumber(core, 'en-US');
  } catch {
    // A runtime without this locale's number format shows the amount as it is.
  }
  if (!read) return null;
  const count = read;
  return progress => {
    const shown = prefix + count(count.value * progress) + suffix;
    return ' '.repeat(Math.max(0, text.length - shown.length)) + shown;
  };
}

/**
 * A plain number counting up from zero alongside the rising liquid, once per mount; a value
 * that changes later shows at once. Renders text only, for use inside a `Text`.
 */
export function CountUp({ text, locale, delay = 0, play }: { text: string; locale: string; delay?: number; play: boolean }) {
  const [progress, setProgress] = useState(play ? 0 : 1);
  useEffect(() => {
    if (!play) return;
    let frame = 0;
    let start: number | undefined;
    let drawnAt = -Infinity;
    const tick = (ms: number) => {
      start ??= ms + delay * 1000;
      const next = Math.max(0, Math.min(1, (ms - start) / (RISE_SECONDS * 1000)));
      if (next < 1) frame = requestAnimationFrame(tick);
      if (next < 1 && ms - drawnAt < COUNT_FRAME_MS) return;
      drawnAt = ms;
      setProgress(next);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [play, delay]);
  const render = progress < 1 ? countUpFrames(text, locale) : null;
  return render ? render(fillCurve(progress)) : text;
}
