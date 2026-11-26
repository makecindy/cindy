import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_MARK_DATA_URL } from '@cindy/maker-shared/branding';
import { MobileVendorIcon } from '@/components/MobileVendorIcon';

vi.mock('@/theme', () => ({
  useTheme: () => ({ colors: { statusAccent: 'running-color', textTertiary: 'idle-color', textSecondary: 'secondary-color' } }),
  iconSize: { sm: 16 },
  iconStroke: { regular: 1.5 },
  radius: { micro: 2 },
}));
vi.mock('@/hooks/useLoopingAnimation', () => ({ useLoopingAnimation: () => false }));
vi.mock('@/session/RemoteSourceMark', () => ({ RemoteSourceMark: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/MobileAgentMark', () => ({ MobileAgentMark: () => null }));
vi.mock('lucide-react-native', () => ({ Puzzle: () => null }));
vi.mock('react-native', () => ({
  Animated: { Value: class {}, View: ({ children }: { children: ReactNode }) => children },
  Easing: {},
  Image: ({ style }: { style: { tintColor?: string } }) => <span data-image-tint={style.tintColor ?? 'original'} />,
  View: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
  Path: ({ fill }: { fill: string }) => <path fill={fill} />,
}));

// Unit / #12735: the real task icon and its SVG mark must use the running
// status color when the icon is the monochrome Antigravity data URL.
// Previously only the generic fallback took this color when no image existed.
describe('mobile Antigravity task icon', () => {
  it('uses the running color for the monochrome mark and preserves other artwork', () => {
    const renderRunning = (iconDataUrl: string) => renderToStaticMarkup(
      <MobileVendorIcon vendor="acp" running pluginEngine={{ iconDataUrl, name: 'Test plugin' }} />,
    );
    expect(renderRunning(ANTIGRAVITY_MARK_DATA_URL)).toContain('fill="running-color"');
    expect(renderRunning('data:image/png;base64,image')).toContain('data-image-tint="original"');
  });
});
