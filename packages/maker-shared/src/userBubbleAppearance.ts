/** User-selected bubble appearance. Runtime color derivation; no platform/theme dependencies. */
/** 按色相排列;id 是持久化值,只增不改,显示名走各端 i18n。 */
export const USER_BUBBLE_PRESETS = [
  "default",
  "peach",
  "yellow",
  "sage",
  "blue",
  "lavender",
  "red",
] as const;
export type UserBubblePreset = (typeof USER_BUBBLE_PRESETS)[number];
export type UserBubblePreference = UserBubblePreset | `#${string}`;

const presetHues = {
  peach: 28,
  yellow: 58,
  sage: 135,
  blue: 210,
  lavender: 275,
  // 品牌红 #DF0C27 的色相;气泡只取柔化后的浅红调,不直接使用品牌红本身。
  red: 352,
};

export function parseUserBubblePreference(
  value: unknown,
): UserBubblePreference {
  if (typeof value !== "string") return "default";
  if ((USER_BUBBLE_PRESETS as readonly string[]).includes(value))
    return value as UserBubblePreset;
  return /^#[\da-f]{6}$/i.test(value)
    ? (value.toLowerCase() as `#${string}`)
    : "default";
}

/** Hues are color-picker input; output roles are generated for the current mode. */
export function bubbleHueColor(hue: number): string {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const channels =
    h < 1
      ? [1, x, 0]
      : h < 2
        ? [x, 1, 0]
        : h < 3
          ? [0, 1, x]
          : h < 4
            ? [0, x, 1]
            : h < 5
              ? [x, 0, 1]
              : [1, 0, x];
  return toHex(channels.map((v) => Math.round((0.35 + v * 0.45) * 255)));
}
function toHex(rgb: number[]): string {
  return (
    "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")
  );
}
function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
export function userBubbleSeed(
  preference: UserBubblePreference,
): string | null {
  if (preference === "default") return null;
  return preference.startsWith("#")
    ? preference
    : bubbleHueColor(presetHues[preference as keyof typeof presetHues]);
}

/**
 * Presets stay soft; custom colors are tinted more so the chosen hue reads clearly.
 * The derived foreground keeps >= 7:1. Callers pass the theme text colors that are
 * actually drawn inside the bubble (body, secondary, inline code...); the tint is
 * reduced until every one of them keeps >= 4.5:1. Zero tint is the theme-neutral
 * surface, which those roles already satisfy.
 */
const tint = {
  preset: { light: 0.16, dark: 0.13 },
  custom: { light: 0.3, dark: 0.18 },
};
const FOREGROUND_MIN_CONTRAST = 7;
const TEXT_ROLE_MIN_CONTRAST = 4.5;
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function resolveUserBubbleColors(
  preference: UserBubblePreference,
  mode: "light" | "dark",
  textRoles: readonly string[] = [],
) {
  const seed = userBubbleSeed(preference);
  if (!seed) return null;
  const channels = rgb(seed);
  const dark = mode === "dark";
  const foreground = toHex(Array(3).fill(dark ? 232 : 38));
  const mix = (strength: number) =>
    toHex(
      channels.map((v) =>
        dark ? 27 + v * strength : 255 - (255 - v) * strength,
      ),
    );
  const readable = (background: string) =>
    contrastRatio(background, foreground) >= FOREGROUND_MIN_CONTRAST &&
    textRoles.every(
      (role) => contrastRatio(background, role) >= TEXT_ROLE_MIN_CONTRAST,
    );
  let strength = tint[preference.startsWith("#") ? "custom" : "preset"][mode];
  if (!readable(mix(strength))) {
    // Luminance moves monotonically with strength, so the largest readable tint is a bisection.
    let low = 0;
    let high = strength;
    for (let i = 0; i < 16; i += 1) {
      const middle = (low + high) / 2;
      if (readable(mix(middle))) low = middle;
      else high = middle;
    }
    strength = low;
  }
  const background = mix(strength);
  const border = toHex(rgb(background).map((v) => (dark ? v + 22 : v - 24)));
  return { background, foreground, border };
}
