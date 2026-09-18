// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedModelPickerView } from '@/session/UnifiedModelPickerView';
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  const View = ({ children }: any) => el('div', null, children);
  return {
    View, ScrollView: View,
    Pressable: ({ children, onPress, disabled }: any) => el('button', { onClick: onPress, disabled }, children),
    useWindowDimensions: () => ({ height: 800 }),
  };
});
vi.mock('@/components/AppText', async () => {
  const { createElement: el } = await import('react');
  return { Text: ({ children }: any) => el('span', null, children), TextInput: () => null };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 40, bottom: 20 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Star', 'SlidersHorizontal', 'Check', 'Zap', 'LayoutGrid'].map(key => [key, () => null])));
vi.mock('@/components/MobileAgentMark', () => ({ MobileAgentMark: () => null }));
vi.mock('@/session/MobileProviderMark', () => ({ MobileModelIconMark: () => null, MobileProviderMark: () => null }));
vi.mock('@/session/SheetModal', () => ({ SheetModal: ({ children }: any) => children }));
vi.mock('@/session/SheetSurface', () => ({ SheetSurface: ({ children }: any) => children }));
vi.mock('@/session/sessionAgentSwitch', () => ({ mobileAgentLabel: (agent: string) => agent }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), spacing: {}, radius: {}, iconSize: {} }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
it.each([null, '2d · 70%'])('keeps both account identities visible with quota %s', async quotaLabel => {
  const rows = ['first@example.com', 'second@example.com'].map(subtitle => ({
    key: subtitle, subtitle, quotaLabel, entry: { displayName: 'Same Model' },
    config: { agent: 'codex' }, providerMark: {},
  }));
  await act(async () => root.render(createElement(UnifiedModelPickerView, {
    visible: true, groups: [{ key: 'favorites', title: 'Favorites', rows }], filters: [],
  } as any)));
  for (const row of rows) expect(host.textContent).toContain(row.subtitle);
  if (quotaLabel) expect(host.textContent).toContain(quotaLabel);
});
