// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seenScreenOptions: unknown[] = [];

function Screen({ options }: { options: unknown }) {
  seenScreenOptions.push(options);
  return null;
}

function Toolbar({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
Toolbar.Button = () => null;

vi.mock('expo-router', () => ({
  Stack: { Screen, Toolbar },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));
vi.mock('@/platform/AdaptiveWindowContext', () => ({
  useAdaptiveWindow: () => ({ barEdge: 'top' }),
}));
vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: { textPrimary: '#111111' } }),
}));

import { SystemNavigationBack } from '@/platform/chrome/SystemNavigationBack';

beforeEach(() => {
  seenScreenOptions.length = 0;
});

afterEach(() => cleanup());

describe('navigation option stability', () => {
  it('retains system-back options through unrelated rerenders and replaces them for option inputs', () => {
    const view = render(
      <SystemNavigationBack label="Back" onPress={() => undefined} />,
    );
    const initialOptions = seenScreenOptions.at(-1);

    view.rerender(
      <SystemNavigationBack label="Return" disabled onPress={() => undefined} />,
    );
    expect(seenScreenOptions.at(-1)).toBe(initialOptions);

    view.rerender(
      <SystemNavigationBack available={false} label="Return" disabled onPress={() => undefined} />,
    );
    expect(seenScreenOptions.at(-1)).not.toBe(initialOptions);
  });
});
