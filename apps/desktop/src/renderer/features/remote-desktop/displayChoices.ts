import type { RemoteDesktopDisplayMode } from '@cindy/device-link';

export type Size = { width: number; height: number };

/** What a recommended size does on this computer's screen. */
export type ResolutionTier = 'same' | 'larger' | 'more' | 'max';

/** A resolution entry; `tier` marks a size recommended for this computer's screen. */
export interface ResolutionChoice extends RemoteDesktopDisplayMode {
  tier?: ResolutionTier;
}

// Scales of this screen's own size, in priority order: when two land on the
// same size, the earlier one stays. Above 1 only stays sharp on a HiDPI screen.
const TIERS: readonly { tier: ResolutionTier; scale: number; hidpi?: boolean }[] = [
  { tier: 'same', scale: 1 },
  { tier: 'larger', scale: 0.8 },
  { tier: 'more', scale: 1.25, hidpi: true },
];
const FITTED_MIN = 320;
const FITTED_MAX = 2560;
const COMMON_RATIOS = [
  [16, 9],
  [16, 10],
  [3, 2],
  [4, 3],
  [5, 4],
  [1, 1],
  [21, 9],
  [32, 9],
];

const valid = (size: Size | null | undefined): size is Size =>
  !!size && size.width > 0 && size.height > 0;
const near = (a: number, b: number) => Math.abs(a / b - 1) < 0.05;
const tiersFor = (pixelRatio: number) => TIERS.filter((tier) => !tier.hidpi || pixelRatio >= 1.5);

/** Same picture shape, tolerant of the even-pixel rounding of fitted sizes. */
export function sameRatio(a: Size | null | undefined, b: Size | null | undefined): boolean {
  return valid(a) && valid(b) && Math.abs((a.width * b.height) / (a.height * b.width) - 1) < 0.01;
}

/** A familiar name such as 16:10, otherwise the long edge per short edge. */
export function ratioLabel(size: Size): string {
  const landscape = size.width >= size.height;
  const ratio = landscape ? size.width / size.height : size.height / size.width;
  const [long, short] = COMMON_RATIOS.find(([a, b]) => Math.abs(ratio / (a / b) - 1) < 0.01) ?? [
    Number(ratio.toFixed(2)),
    1,
  ];
  return landscape ? `${long}:${short}` : `${short}:${long}`;
}

/** The size that matches this screen: the ratio shown point-for-point as large as `area` allows. */
function sameSize(ratio: Size, area: Size): Size {
  const scale = Math.min(area.width / ratio.width, area.height / ratio.height);
  return { width: ratio.width * scale, height: ratio.height * scale };
}

/** Even pixel sizes the host can create; larger requests shrink to its limit. */
function fittedSize(base: Size, scale: number): Size | null {
  const shrink = Math.min(1, FITTED_MAX / (Math.max(base.width, base.height) * scale));
  const width = Math.round((base.width * scale * shrink) / 2) * 2;
  const height = Math.round((base.height * scale * shrink) / 2) * 2;
  return Math.min(width, height) >= FITTED_MIN ? { width, height } : null;
}

/** The size a ratio choice applies first: this screen's size, or the host's largest. */
export function recommendedFit(ratio: Size, area: Size): Size | null {
  return valid(ratio) && valid(area) ? fittedSize(sameSize(ratio, area), 1) : null;
}

/** A picture fitted to `ratio` offers only the recommended sizes, plus the current one. */
export function fittedChoices(
  ratio: Size,
  area: Size,
  current: Size,
  pixelRatio: number,
): ResolutionChoice[] {
  const isCurrent = (size: Size) => size.width === current.width && size.height === current.height;
  const choices: ResolutionChoice[] = [];
  if (valid(ratio) && valid(area)) {
    const base = sameSize(ratio, area);
    const add = (size: Size | null, tier: ResolutionTier) => {
      if (!size || choices.some((choice) => near(choice.width, size.width))) return;
      choices.push({ id: `fitted:${size.width}x${size.height}`, ...size, current: false, tier });
    };
    for (const { tier, scale } of tiersFor(pixelRatio)) {
      // A size the host's limit shrank is simply the largest available.
      const capped = Math.max(base.width, base.height) * scale > FITTED_MAX;
      add(fittedSize(base, scale), capped ? 'max' : tier);
    }
    // A screen past the host's limit collapses the sizes; keep a larger-text one.
    if (choices.length === 1) add(fittedSize(choices[0], 0.8), 'larger');
  }
  if (!choices.some(isCurrent))
    choices.push({
      id: `fitted:${current.width}x${current.height}`,
      width: current.width,
      height: current.height,
      current: true,
    });
  for (const choice of choices) choice.current = isCurrent(choice);
  return choices.sort((a, b) => a.width - b.width);
}

/** The computer's own modes are fixed; mark those close to a recommended size. */
export function tagRecommendedModes(
  modes: RemoteDesktopDisplayMode[],
  area: Size,
  pixelRatio: number,
): ResolutionChoice[] {
  const choices: ResolutionChoice[] = modes.map((mode) => ({ ...mode }));
  const reference = modes.find((mode) => mode.current) ?? modes[0];
  if (!valid(reference) || !valid(area)) return choices;
  const base = sameSize(reference, area);
  for (const { tier, scale } of tiersFor(pixelRatio)) {
    const target = base.width * scale;
    const nearest = choices
      .filter((choice) => choice.tier === undefined)
      .sort((a, b) => Math.abs(a.width - target) - Math.abs(b.width - target))[0];
    if (nearest && near(nearest.width, target)) nearest.tier = tier;
  }
  return choices;
}
