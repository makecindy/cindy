import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../../tailwind.config';

// Independent pre-DS-8 expectations (4f03ea9a7b): Tailwind 3 defaults,
// globals.css motion values, and Input's approved 40px / 12px geometry.
// Never generate these expectations from DTCG. Approved style changes must
// explicitly update this ledger under design-governance §1.1 and §6.
const SPACING = {
  '0': '0px', '1': '0.25rem', '2': '0.5rem', '3': '0.75rem',
  '4': '1rem', '5': '1.25rem', '6': '1.5rem', '7': '1.75rem',
  '8': '2rem', '9': '2.25rem', '10': '2.5rem', '11': '2.75rem',
  '12': '3rem', '14': '3.5rem', '16': '4rem', '20': '5rem',
  '24': '6rem', '28': '7rem', '32': '8rem', '36': '9rem',
  '40': '10rem', '44': '11rem', '48': '12rem', '52': '13rem',
  '56': '14rem', '60': '15rem', '64': '16rem', '72': '18rem',
  '80': '20rem', '96': '24rem', px: '1px',
  '0.5': '0.125rem', '1.5': '0.375rem', '2.5': '0.625rem', '3.5': '0.875rem',
};
const RADIUS = {
  none: '0px', DEFAULT: '0.25rem', xl: '0.75rem',
  '2xl': '1rem', '3xl': '1.5rem', full: '9999px',
  lg: 'var(--radius)',
  md: 'calc(var(--radius) - 2px)',
  sm: 'calc(var(--radius) - 4px)',
};
const MOTION = {
  instant: '80ms', fast: '150ms', base: '200ms', enter: '250ms', exit: '150ms',
  'spinner-cycle': '1000ms', 'sidebar-title-marquee-per-viewport': '2400ms',
  'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
  'ease-in': 'cubic-bezier(0.4, 0, 1, 1)',
  'ease-move': 'cubic-bezier(0.4, 0, 0.2, 1)',
};
const css = readFileSync(new URL('../styles/generated/tokens.css', import.meta.url), 'utf8');
const variables = Object.fromEntries(
  [...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]),
);
const theme = config.theme!.extend!;

function resolveVariables(value: string): string {
  return value.replace(/var\(--([\w-]+)(?:,\s*[^)]+)?\)/g, (expression, name: string) => {
    // The user radius must stay symbolic; its default/null fallback is covered
    // by registry freezes and theme compatibility tests, not a fixed CSS value.
    if (name === 'radius') return expression;
    expect(variables[name], `Missing CSS variable --${name}`).toBeDefined();
    return variables[name];
  });
}

function resolveMap(map: unknown) {
  return Object.fromEntries(
    Object.entries(map as Record<string, string>).map(([key, value]) => [key, resolveVariables(value)]),
  );
}

describe('DS-8 foundation defaults freeze', () => {
  it('keeps all 35 spacing classes, six fixed radii and three UI weights at approved values', () => {
    expect(resolveMap(theme.spacing)).toEqual(SPACING);
    expect(resolveMap(theme.borderRadius)).toEqual(RADIUS);
    expect(resolveMap(theme.fontWeight)).toEqual({ normal: '400', medium: '500', semibold: '600' });
  });

  it('keeps user radius derivation and standard Input geometry', () => {
    expect(theme.borderRadius).toMatchObject({
      lg: 'var(--radius)',
      md: 'calc(var(--radius) - var(--radius-offset-md))',
      sm: 'calc(var(--radius) - var(--radius-offset-sm))',
    });
    expect(variables).toMatchObject({
      'radius-offset-md': '2px', 'radius-offset-sm': '4px',
      'size-input-lg': '40px', 'space-input-lg': '12px',
    });
  });

  it('keeps all motion durations/curves and the real Tailwind transition defaults', () => {
    expect(Object.fromEntries(
      Object.entries(variables)
        .filter(([key]) => key.startsWith('motion-'))
        .map(([key, value]) => [key.slice('motion-'.length), value]),
    )).toEqual(MOTION);
    expect(theme.transitionDuration).toEqual({ DEFAULT: 'var(--motion-fast, 150ms)' });
    expect(theme.transitionTimingFunction).toEqual({
      DEFAULT: 'var(--motion-ease-move, cubic-bezier(0.4, 0, 0.2, 1))',
    });
  });
});
