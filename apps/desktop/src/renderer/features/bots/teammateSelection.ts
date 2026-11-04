import type { CSSProperties } from 'react';

/** Teammates use a quiet surface selection, independent of the task sidebar's inverse pill. */
export const teammateSelectionStyle = {
  '--sidebar-item-active': 'var(--surface-hover-hsl)',
  '--sidebar-item-active-foreground': 'var(--sidebar-nav-text)',
} as CSSProperties;
