import { useEffect, useRef } from 'react';

// The Swift panel's TubeView and LiquidSurface (native/menubar/macos-menubar-helper.swift) on
// Windows: the same surface shape, opening slosh, in-use ripple and hover nudge. Lengths are px,
// times seconds; keep the numbers in step with the Swift ones.
/** The 40px tube less the 3px well inset on each side (quota-tray.css). */
const WELL_WIDTH = 34;
const WELL_INSET = 3;
const STAGGER = 0.06;
const RIPPLE = 1.5;
const ARRIVAL = 0.5;
const SLOSH_TILT = 5;
const RISE_SHIVER = 0.3;
const RISE_ROCK = 1.1;
const RISE_ROCK_PERIOD = 0.34;
const SLOSH_SECONDS = 4.6;
const NUDGE_TILT = 1.7;
const NUDGE_PERIOD = 0.72;
const NUDGE_DECAY = 0.5;
const NUDGE_SECONDS = 2.2;
const WAVE_PERIOD = 3.6;
const FRAME_MS = 1000 / 30;
const TAU = 2 * Math.PI;

const between = (min: number, max: number) => min + Math.random() * (max - min);
/** One opening's slosh, drawn anew each time so no two openings move alike. */
const randomSlosh = () => ({
  direction: Math.random() < 0.5 ? 1 : -1, strength: between(0.8, 1.15), period: between(0.82, 1.12),
  decay: between(1, 1.5), secondRatio: between(0.18, 0.4), secondPeriodRatio: between(0.4, 0.55),
  arrivalShift: between(-0.06, 0.08),
});

/**
 * Liquid whose top edge waves (`amplitude`), leans (`tilt`: left up, right down) and bows
 * (`second`: edges up, middle down), meeting the walls in a soft corner. Zero everywhere is a
 * flat surface; the lean and bow average to zero, so the level reads the same.
 */
function surfacePath(height: number, phase: number, amplitude: number, tilt: number, second: number): string {
  if (height <= 0) return '';
  const amp = Math.min(amplitude, height / 4);
  const k = TAU / (WELL_WIDTH * 1.35);
  const y = (x: number) => {
    const u = x / WELL_WIDTH;
    const wave = 0.65 * Math.sin(k * x + phase) + 0.35 * Math.sin(1.7 * k * x - 1.3 * phase);
    return amp * (1 + wave) - (tilt * (1 - 2 * u) + second * Math.cos(TAU * u));
  };
  const n = (value: number) => value.toFixed(2);
  const corner = Math.min(4, height / 2, WELL_WIDTH / 4);
  // Drawn past the bottom: the well clips it, and a level change may resize the box mid-frame.
  const bottom = n(height + 200);
  let d = `M0 ${bottom}L0 ${n(y(0) + corner)}Q0 ${n(y(0))} ${n(corner)} ${n(y(corner))}`;
  for (let step = 1; step < 16; step++) {
    const x = corner + (WELL_WIDTH - 2 * corner) * step / 16;
    d += `L${n(x)} ${n(y(x))}`;
  }
  const right = WELL_WIDTH - corner;
  return `${d}L${n(right)} ${n(y(right))}Q${WELL_WIDTH} ${n(y(WELL_WIDTH))} ${WELL_WIDTH} ${n(y(WELL_WIDTH) + corner)}L${WELL_WIDTH} ${bottom}Z`;
}

export function Tube({ fill, index, active, visible, height, emphasized, level }: {
  fill: number; index: number; active: boolean; visible: boolean; height: number; emphasized: boolean; level: string;
}) {
  const path = useRef<SVGPathElement>(null);
  const motion = useRef({ opened: -Infinity, slosh: randomSlosh(), nudged: -Infinity, nudgeDirection: 1, rippleFrom: 0, rippleGoal: 0, rippleAt: -Infinity });
  const fraction = Math.max(0, Math.min(1, fill));
  const liquid = fraction > 0 ? Math.max(3, fraction * (height - WELL_INSET * 2)) : 0;

  useEffect(() => {
    if (visible) Object.assign(motion.current, { opened: performance.now() / 1000, slosh: randomSlosh(), rippleFrom: 0, rippleGoal: 0 });
  }, [visible]);

  useEffect(() => {
    const m = motion.current;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = (phase = 0, ripple = 0, tilt = 0, second = 0) => path.current?.setAttribute('d', surfacePath(liquid, phase, ripple, tilt, second));
    draw();
    if (!visible || !liquid || reduced.matches) return;
    const slosh = m.slosh;
    const sloshEnd = m.opened + index * STAGGER + ARRIVAL + 0.1 + SLOSH_SECONDS;
    // The ripple of a source in use eases between levels on the same clock as the wave.
    const rippleSeconds = () => (m.rippleGoal > m.rippleFrom ? 0.8 : 1.4);
    const rippleLevel = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - m.rippleAt) / rippleSeconds()));
      return m.rippleFrom + (m.rippleGoal - m.rippleFrom) * p * p * (3 - 2 * p);
    };
    let frame = 0;
    let drawnAt = -Infinity;
    const tick = (ms: number) => {
      const now = ms / 1000;
      const opening = now < sloshEnd;
      const nudge = now - m.nudged;
      // The standing ripple waits for the opening slosh to end, then restarts from still.
      const goal = active && !opening ? RIPPLE : 0;
      if (goal !== m.rippleGoal) Object.assign(m, { rippleFrom: rippleLevel(now), rippleGoal: goal, rippleAt: now });
      const easing = now - m.rippleAt < rippleSeconds();
      if (reduced.matches || !(opening || active || easing || nudge < NUDGE_SECONDS)) {
        frame = 0;
        draw();
        return;
      }
      frame = requestAnimationFrame(tick);
      if (ms - drawnAt < FRAME_MS) return;
      drawnAt = ms;
      let ripple = rippleLevel(now);
      let tilt = 0;
      let second = 0;
      if (opening) {
        const t = now - m.opened - index * STAGGER;
        const arrival = ARRIVAL + slosh.arrivalShift;
        if (t < arrival) {
          // Rising: a small quick rock that swells mid-climb and is level again on arrival.
          const risen = Math.max(0, t);
          tilt = RISE_ROCK * (0.5 + 0.5 * fraction) * Math.sin(Math.PI * risen / arrival) * Math.sin(TAU * risen / RISE_ROCK_PERIOD) * slosh.direction;
          ripple = Math.max(ripple, RISE_SHIVER);
        } else {
          // Stopped: inertia tips the surface side to side like a damped pendulum, a faster,
          // smaller bow on top. A nearly full tube swings widely, a low one barely does.
          const s = t - arrival;
          const momentum = Math.max(0.04, fraction ** 1.5);
          tilt = slosh.direction * slosh.strength * SLOSH_TILT * momentum * Math.exp(-s / slosh.decay) * Math.sin(TAU * s / slosh.period);
          second = -slosh.direction * slosh.secondRatio * SLOSH_TILT * momentum
            * Math.exp(-s / (slosh.decay * 0.7)) * Math.sin(TAU * s / (slosh.period * slosh.secondPeriodRatio));
          ripple = Math.max(ripple, RISE_SHIVER * Math.exp(-s / 0.6));
        }
      }
      if (nudge >= 0 && nudge < NUDGE_SECONDS) {
        // Fuller tubes sway a little more; even a low one visibly answers the pointer.
        const sway = m.nudgeDirection * NUDGE_TILT * (0.35 + 0.65 * fraction);
        tilt += sway * Math.exp(-nudge / NUDGE_DECAY) * Math.sin(TAU * nudge / NUDGE_PERIOD);
        second -= sway * 0.3 * Math.exp(-nudge / (NUDGE_DECAY * 0.7)) * Math.sin(TAU * nudge / (NUDGE_PERIOD * 0.48));
      }
      draw(now * TAU / WAVE_PERIOD + index * 1.3, ripple, tilt, second);
    };
    frame = requestAnimationFrame(tick);
    const source = path.current?.closest('.source');
    const onEnter = () => {
      const now = performance.now() / 1000;
      // Sweeping the pointer across the row must not restart a nudge that just began.
      if (now - m.nudged < 0.35) return;
      Object.assign(m, { nudged: now, nudgeDirection: Math.random() < 0.5 ? 1 : -1 });
      if (!frame) frame = requestAnimationFrame(tick);
    };
    source?.addEventListener('pointerenter', onEnter);
    return () => {
      cancelAnimationFrame(frame);
      source?.removeEventListener('pointerenter', onEnter);
    };
  }, [visible, liquid, fraction, active, index]);

  return <div className="tube" data-best={emphasized} data-level={level}>
    <span className="well"><i style={{ height: liquid }}><svg aria-hidden="true"><path ref={path}/></svg></i></span>
  </div>;
}

/** The Swift panel's open/fill curve, control points (0.22, 1) and (0.36, 1), solved for `x`. */
function fillCurve(x: number): number {
  const bezier = (t: number, p1: number, p2: number) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;
  let t = x;
  for (let pass = 0; pass < 6; pass++) {
    const slope = 3 * (1 - t) ** 2 * 0.22 + 6 * (1 - t) * t * (0.36 - 0.22) + 3 * t ** 2 * (1 - 0.36);
    if (slope < 1e-6) break;
    t = Math.max(0, Math.min(1, t - (bezier(t, 0.22, 0.36) - x) / slope));
  }
  return bezier(t, 1, 1);
}

/** Text before the first digit, the digits with their separators, and text after the last digit. */
const NUMBER_TEXT = /^(\D*)(\d(?:[^]*\d)?)(\D*)$/;
const COUNT_SECONDS = 0.9;

/**
 * Reads a displayed number with one locale's separators and returns how to write any value the
 * same way, or null when that reading does not write the text back exactly. Without the check a
 * German "31,17" read as en-US became 3117, and a count-up showed amounts orders of magnitude off.
 */
function readNumber(core: string, locale: string): ((value: number) => string) & { value: number } | null {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find(part => part.type === 'group')?.value ?? ',';
  const decimal = parts.find(part => part.type === 'decimal')?.value ?? '.';
  const [whole, fraction = '', extra] = core.split(decimal);
  if (extra !== undefined) return null;
  const digits = whole.split(group).join('');
  if (!/^\d+$/.test(digits) || !/^\d*$/.test(fraction)) return null;
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fraction.length, maximumFractionDigits: fraction.length, useGrouping: whole.includes(group),
  }).format;
  const value = Number(digits + '.' + (fraction || '0'));
  return format(value) === core ? Object.assign((n: number) => format(n), { value }) : null;
}

/**
 * How to count a displayed amount ("53", "$31.17", "31,17 €", "¥28.0k") up from zero, or null to
 * show it as-is. The card's own locale is tried first; abbreviated amounts are written in en-US.
 */
export function countUpFrames(text: string, locale: string): ((progress: number) => string) | null {
  const match = NUMBER_TEXT.exec(text);
  if (!match) return null;
  const [, prefix, core, suffix] = match;
  const read = readNumber(core, locale) ?? readNumber(core, 'en-US');
  return read ? progress => prefix + read(read.value * progress) + suffix : null;
}

/**
 * A plain number counts up from zero each time the card opens, alongside the rising liquid (the
 * Swift panel's CountUpText). The final text reserves the width, so the count never shifts its
 * neighbours; anything that is not a plain number in this locale shows as-is.
 */
export function CountUp({ text, locale, visible, delay = 0 }: { text: string; locale: string; visible: boolean; delay?: number }) {
  const live = useRef<HTMLSpanElement>(null);
  const counted = useRef(false);
  useEffect(() => {
    const node = live.current;
    if (!node) return;
    node.textContent = text;
    if (!visible) counted.current = false;
    const render = countUpFrames(text, locale);
    if (!visible || counted.current || !render || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    counted.current = true;
    const start = performance.now() + delay * 1000;
    node.textContent = render(0);
    let frame = requestAnimationFrame(function tick(ms) {
      const progress = Math.max(0, Math.min(1, (ms - start) / (COUNT_SECONDS * 1000)));
      node.textContent = progress < 1 ? render(fillCurve(progress)) : text;
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [text, locale, visible, delay]);
  return <span className="count"><span>{text}</span><span ref={live} aria-hidden="true">{text}</span></span>;
}
