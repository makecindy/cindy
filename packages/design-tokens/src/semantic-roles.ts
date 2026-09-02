/**
 * DS-3 第一批 semantic 角色：DESIGN.md §10 Tier-1 既有名称
 * （surface / border / text / accent）+ status 语义。
 * 不改名、不发明新语义。U2 与 annotation-accent 等保护值不在此列。
 */
export type SemanticGroup = 'surface' | 'border' | 'text' | 'accent' | 'status';

export interface SemanticRole {
  id: string;
  group: SemanticGroup;
}

export const SEMANTIC_ROLES: readonly SemanticRole[] = [
  { id: 'surface', group: 'surface' },
  { id: 'surface-hsl', group: 'surface' },
  { id: 'surface-elevated', group: 'surface' },
  { id: 'surface-elevated-soft', group: 'surface' },
  { id: 'surface-card-ivory', group: 'surface' },
  { id: 'surface-chip', group: 'surface' },
  { id: 'surface-chip-alt', group: 'surface' },
  { id: 'surface-hover', group: 'surface' },
  { id: 'surface-hover-soft', group: 'surface' },
  { id: 'surface-hover-hsl', group: 'surface' },
  { id: 'surface-on-card', group: 'surface' },

  { id: 'border-default', group: 'border' },
  { id: 'border-default-hsl', group: 'border' },
  { id: 'border-shadcn-hsl', group: 'border' },
  { id: 'border-transparent-mixed', group: 'border' },

  { id: 'text-primary', group: 'text' },
  { id: 'text-primary-hsl', group: 'text' },
  { id: 'text-primary-on-dark', group: 'text' },
  { id: 'text-primary-emphasis', group: 'text' },
  { id: 'text-primary-inv', group: 'text' },
  { id: 'text-primary-body-strong', group: 'text' },
  { id: 'text-secondary-mid', group: 'text' },
  { id: 'text-tertiary', group: 'text' },
  { id: 'text-tertiary-stone', group: 'text' },
  { id: 'text-tertiary-mid', group: 'text' },
  { id: 'text-tertiary-hsl', group: 'text' },
  { id: 'text-disabled', group: 'text' },
  { id: 'text-disabled-tertiary', group: 'text' },
  { id: 'text-placeholder', group: 'text' },

  { id: 'accent-cta-bg', group: 'accent' },
  { id: 'accent-cta-bg-pure', group: 'accent' },
  { id: 'accent-emphasis', group: 'accent' },
  { id: 'accent-soft', group: 'accent' },
  { id: 'accent-hover', group: 'accent' },
  { id: 'accent-pure-cta-fg', group: 'accent' },
  { id: 'focus-ring', group: 'accent' },
  { id: 'focus-ring-soft', group: 'accent' },

  { id: 'destructive', group: 'status' },
  { id: 'error-flat', group: 'status' },
  { id: 'error-bg', group: 'status' },
  { id: 'error-border', group: 'status' },
  { id: 'error-fg', group: 'status' },
  { id: 'error-fg-strong', group: 'status' },
  { id: 'warning-accent', group: 'status' },
  { id: 'warning-fg', group: 'status' },
  { id: 'warning-bg-soft', group: 'status' },
] as const;

export const SEMANTIC_ROLE_IDS = new Set(SEMANTIC_ROLES.map((role) => role.id));
