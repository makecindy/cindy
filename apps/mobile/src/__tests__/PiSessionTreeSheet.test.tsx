// @vitest-environment jsdom
import { act, type CSSProperties, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiSessionTreeSheet } from '@/session/PiSessionTreeSheet';
import type { MobilePiSessionTreeNode } from '@/session/piSessionTreeModel';
import { darkColors, lightColors, spacing } from '@/theme/tokens';

const state = vi.hoisted(() => ({ dark: false, t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t }) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  type Props = { children?: ReactNode; style?: unknown; testID?: string; onPress?: () => void; disabled?: boolean };
  const flatten = (value: unknown): CSSProperties => Object.assign({}, ...(Array.isArray(value) ? value.flat(Infinity).filter(Boolean) : [value]));
  const View = ({ children, style }: Props) => createElement('div', { style: flatten(style) }, children);
  const Pressable = ({ children, style, testID, onPress, disabled }: Props) => createElement('button', {
    'data-testid': testID, onClick: onPress, disabled,
    style: flatten(typeof style === 'function' ? style({ pressed: false }) : style),
  }, children);
  return { View, Text: View, Pressable, ActivityIndicator: () => null,
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844 }) };
});
vi.mock('@/components/AppText', async () => ({ Text: (await import('react-native')).Text }));
vi.mock('lucide-react-native', () => ({ Check: () => null, GitBranch: () => null, MessageSquare: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = () => state.dark ? tokens.darkColors : tokens.lightColors;
  return { ...tokens, useTheme: () => ({ colors: colors() }),
    useThemedStyles: (make: (value: typeof tokens.lightColors) => unknown) => make(colors()) };
});
vi.mock('@/session/SheetModal', () => ({ SheetModal: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/session/SheetSurface', () => ({ SheetSurface: ({ children }: { children: ReactNode }) => children }));

function node(id: string, ...children: MobilePiSessionTreeNode[]): MobilePiSessionTreeNode {
  return { id, role: 'user', preview: id, children };
}
function chain(length: number): MobilePiSessionTreeNode {
  let next = node(`chain-${length - 1}`);
  for (let i = length - 2; i >= 0; i--) next = node(`chain-${i}`, next);
  return next;
}
let host: HTMLDivElement;
let root: Root;
const maker = { getSessionTree: vi.fn(), navigateSessionTree: vi.fn() };
const onNavigated = vi.fn();
const row = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="session.branch.${id}"]`)!;
async function show(roots: MobilePiSessionTreeNode[], disabledReason?: string) {
  maker.getSessionTree.mockResolvedValue({ roots, leafId: 'leaf', activePathIds: ['p', 'leaf'] });
  await act(async () => root.render(<PiSessionTreeSheet visible sessionId="session" maker={maker}
    onClose={vi.fn()} onNavigated={onNavigated} disabledReason={disabledReason} />));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe.each(['light', 'dark'])('Pi tree in %s mode', mode => {
  beforeEach(() => { state.dark = mode === 'dark'; });
  it('keeps a long single chain aligned', async () => {
    await show([chain(40)]);
    for (let i = 0; i < 40; i++) expect(row(`chain-${i}`).style.paddingLeft).toBe(`${spacing.md}px`);
  });
  it('groups forks once, including immediate and later nested forks', async () => {
    await show([node('p', node('a', node('a2', node('a3', node('c', node('c2', node('c3'))), node('d')))), node('b', node('e', node('e2')), node('f')))]);
    const depths = { p: 0, a: 1, a2: 2, a3: 2, c: 3, c2: 4, c3: 4, d: 3, b: 1, e: 2, e2: 3, f: 2 };
    for (const [id, depth] of Object.entries(depths)) expect(row(id).style.paddingLeft).toBe(`${spacing.md + depth * spacing.lg}px`);
  });
  it('treats multiple roots as a virtual fork without drifting along their chains', async () => {
    await show([node('a', node('a2', node('a3'))), node('b')]);
    expect(['a', 'a2', 'a3', 'b'].map(id => row(id).style.paddingLeft)).toEqual([1, 2, 2, 1].map(depth => `${spacing.md + depth * spacing.lg}px`));
  });
  it('retains themed active state, current leaf and navigation result', async () => {
    await show([node('p', node('leaf')), node('other')]);
    const sample = document.createElement('div');
    sample.style.backgroundColor = (state.dark ? darkColors : lightColors).surfaceElevated;
    expect(row('p').style.backgroundColor).toBe(sample.style.backgroundColor);
    expect(row('leaf').disabled).toBe(true);
    maker.navigateSessionTree.mockResolvedValue({ draftText: 'resume this' });
    await act(async () => row('other').click());
    expect(maker.navigateSessionTree).toHaveBeenCalledWith('session', 'other');
    expect(onNavigated).toHaveBeenCalledWith('resume this');
  });
  it('disables branch navigation when the transport is write blocked', async () => {
    await show([node('p', node('leaf'))], 'blocked');
    await act(async () => row('p').click());
    expect(row('p').disabled).toBe(true);
    expect(maker.navigateSessionTree).not.toHaveBeenCalled();
  });
});
