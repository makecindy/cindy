/**
 * 本地主题(用户自定义 / 复制主题)的加载期归一化。
 *
 * 背景:`--text-placeholder` 统一 slot 是后引入的(见 colors.ts + docs/design-rules/cindy-design-system.md §13 G3)。
 * 在它之前创建的本地主题快照只冻结了旧的 per-surface placeholder key
 * (`chat-input-placeholder` / `ask-input-placeholder` / `settings-input-placeholder` /
 * `plan-action-fb-placeholder`),没有 `text-placeholder`。这些旧 override 在加载时会
 * 优先于新 default(`var(--text-placeholder)`),导致同一本地主题内四个输入面的 placeholder
 * 不统一:Settings 仍用旧自定义色,而 chat/ask/plan 可能保留旧值或回退到基础色。
 *
 * 这里在**加载期**(renderer 侧 `mapWireTheme`)做兼容归一化,不改写盘上 JSON、幂等:
 * 当快照缺 `text-placeholder` 时,从旧 `settings-input-placeholder`(优先——历史上即
 * "读着像空"的淡色)或任一 per-surface 值播种出 `text-placeholder`,并丢弃 4 个旧
 * per-surface placeholder override,让四个输入面统一走新 slot。外部主题导入新增
 * Switch 安全 token 前保存的完整色板,也会在缺少二者时从旧语义色运行时补齐;
 * 复制主题固化的 registry 默认别名同样按缺失处理。
 */

import { parseCssColor, toHex, type Rgb } from '../../shared/theme-import/color';
import { deriveUncheckedSwitchTrack } from '../../shared/theme-import/palette';
import { colorRegistry } from './color-registry';

/** 旧的 per-surface placeholder alias —— 归一化后由 `--text-placeholder` slot 统一接管。 */
const PER_SURFACE_PLACEHOLDER_KEYS = [
  'settings-input-placeholder',
  'chat-input-placeholder',
  'ask-input-placeholder',
  'plan-action-fb-placeholder',
] as const;

const CONNECTED_BADGE_KEY = 'settings-badge-connected';
const CONNECTED_BADGE_TEXT_KEY = 'settings-badge-connected-text';
const LEGACY_CONNECTED_BADGE_DEFAULT = 'var(--text-primary)';
const SWITCH_TRACK_OFF_KEY = 'switch-track-off';
const SWITCH_THUMB_OFF_KEY = 'switch-thumb-off';
const LEGACY_SWITCH_TRACK_KEY = 'border-default';
const LEGACY_SWITCH_THUMB_KEY = 'surface';
const UNCHECKED_SWITCH_SURFACE_KEYS = [
  'surface',
  'surface-elevated',
  'surface-card-ivory',
  'surface-hover',
  'surface-hover-soft',
] as const;

function parseThemeColor(colors: Record<string, string>, key: string): Rgb | null {
  const value = colors[key];
  return value === undefined ? null : parseCssColor(value);
}

function isRegistryDefaultSwitchValue(key: string, value: string): boolean {
  return (
    colorRegistry.resolveDefault(key, 'light') === value
    || colorRegistry.resolveDefault(key, 'dark') === value
  );
}

/**
 * 旧导入产物没有 provenance/version 字段,不能靠文件名猜来源。仅当两个新 token
 * 都缺失或等于 registry 默认别名、且完整的旧语义色可解析时补齐；任何真正的
 * 显式新 token 或不完整手写主题原样保留。
 */
function normalizeUncheckedSwitchColors(
  colors: Record<string, string>,
): Record<string, string> {
  const track = colors[SWITCH_TRACK_OFF_KEY];
  const thumbOverride = colors[SWITCH_THUMB_OFF_KEY];
  const hasExplicitTrack =
    track !== undefined && !isRegistryDefaultSwitchValue(SWITCH_TRACK_OFF_KEY, track);
  const hasExplicitThumb =
    thumbOverride !== undefined
    && !isRegistryDefaultSwitchValue(SWITCH_THUMB_OFF_KEY, thumbOverride);
  if (hasExplicitTrack || hasExplicitThumb) {
    return colors;
  }

  const preferredTrack = parseThemeColor(colors, 'text-secondary');
  const thumb = parseThemeColor(colors, 'surface-on-card');
  if (!preferredTrack || !thumb) return colors;

  const surfaces: Rgb[] = [];
  for (const key of UNCHECKED_SWITCH_SURFACE_KEYS) {
    const surface = parseThemeColor(colors, key);
    if (!surface) return colors;
    surfaces.push(surface);
  }

  try {
    const track = deriveUncheckedSwitchTrack(
      preferredTrack,
      [...surfaces, thumb],
    );
    return {
      ...colors,
      [SWITCH_TRACK_OFF_KEY]: toHex(track),
      [SWITCH_THUMB_OFF_KEY]: toHex(thumb),
    };
  } catch {
    // 旧导入模板里 unchecked Switch 实际是 bg-input + bg-background；这两者分别
    // 来自同一色板的 border 与 surface。无解时冻结这对升级前颜色，避免掉到
    // 未经约束的新 registry alias 后比升级前更差。本地主题 bootstrap 仍 best-effort。
    const legacyTrack = parseThemeColor(colors, LEGACY_SWITCH_TRACK_KEY);
    const legacyThumb = parseThemeColor(colors, LEGACY_SWITCH_THUMB_KEY);
    if (!legacyTrack || !legacyThumb) return colors;
    return {
      ...colors,
      [SWITCH_TRACK_OFF_KEY]: toHex(legacyTrack),
      [SWITCH_THUMB_OFF_KEY]: toHex(legacyThumb),
    };
  }
}

export function normalizeLocalThemeColors(
  colors: Record<string, string>,
): Record<string, string> {
  let normalized = colors;
  const legacyConnectedBadge = colors[CONNECTED_BADGE_KEY];
  if (
    legacyConnectedBadge === LEGACY_CONNECTED_BADGE_DEFAULT &&
    colors[CONNECTED_BADGE_TEXT_KEY] === undefined
  ) {
    normalized = {
      ...colors,
      [CONNECTED_BADGE_KEY]: 'var(--card-status-done)',
      [CONNECTED_BADGE_TEXT_KEY]: legacyConnectedBadge,
    };
  }

  if (normalized['text-placeholder'] === undefined) {
    // 优先用 settings-input-placeholder 作为种子:它在历史快照里即"淡到读着像空"的
    // 那一档(其余 per-surface 多为 var(--text-tertiary),偏深)。都没有则不迁移,
    // 让 text-placeholder 走 registry 默认值。
    let seed: string | undefined;
    for (const key of PER_SURFACE_PLACEHOLDER_KEYS) {
      if (normalized[key] !== undefined) {
        seed = normalized[key];
        break;
      }
    }
    if (seed !== undefined) {
      const drop = new Set<string>(PER_SURFACE_PLACEHOLDER_KEYS);
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(normalized)) {
        if (!drop.has(key)) next[key] = value;
      }
      next['text-placeholder'] = seed;
      normalized = next;
    }
  }

  return normalizeUncheckedSwitchColors(normalized);
}
