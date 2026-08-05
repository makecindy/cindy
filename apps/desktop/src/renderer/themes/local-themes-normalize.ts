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
 * per-surface placeholder override,让四个输入面统一走新 slot。
 */

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

  // 新主题 / 已迁移过的快照本就带 text-placeholder,原样返回(幂等)。
  if (normalized['text-placeholder'] !== undefined) return normalized;

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
  if (seed === undefined) return normalized;

  const drop = new Set<string>(PER_SURFACE_PLACEHOLDER_KEYS);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (!drop.has(key)) next[key] = value;
  }
  next['text-placeholder'] = seed;
  return next;
}
