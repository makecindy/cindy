// @vitest-environment jsdom
import { act, createElement, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ modal: null as any, surface: null as any, mounts: 0 }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: () => null }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), iconSize: {}, iconStroke: {}, radius: {}, spacing: { xl: 24 } }));
vi.mock('lucide-react-native', () => ({ X: () => null }));
vi.mock('react-native', () => ({
  View: ({ children, testID }: any) => createElement('div', { 'data-testid': testID }, children),
  ScrollView: ({ children }: any) => createElement('div', null, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 40, bottom: 20, left: 0, right: 0 }) }));
vi.mock('@/session/SheetModal', () => ({ SheetModal: (props: any) => { h.modal = props; return props.children; } }));
vi.mock('@/session/SheetSurface', () => ({ SheetSurface: (props: any) => {
  h.surface = props;
  useEffect(() => { h.mounts++; }, []);
  return props.children;
} }));
import { CompanionSheet } from '@/session/CompanionSheet';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
const close = vi.fn(); const back = vi.fn();
async function render(props: { preventDismiss?: boolean; onBack?: () => void; fitToContents?: boolean; children?: ReactNode }) {
  await act(async () => root.render(createElement(CompanionSheet, { visible: true, title: 'Teammate', onClose: close, children: null, ...props })));
}
beforeEach(() => { vi.clearAllMocks(); h.mounts = 0; root = createRoot(document.createElement('div')); });
afterEach(() => { act(() => root.unmount()); });

it('closes from the backdrop, the grabber and the system back key when nothing is at risk', async () => {
  await render({});
  h.modal.onBackdropPress(); h.surface.onClose(); h.modal.onRequestClose();
  expect(close).toHaveBeenCalledTimes(3);
});

// A01: short identity content must reach the native intrinsic-height surface,
// rather than the old half-screen compatibility container.
it('uses the native content-sized presentation for a short identity and keeps dismissal', async () => {
  h.surface = null;
  await render({ fitToContents: true, children: createElement('span', null, '小满') });
  expect(h.modal.nativePresentation).toBe(true);
  expect(h.surface).toBeNull();
  h.modal.onBackdropPress(); h.modal.onRequestClose();
  expect(close).toHaveBeenCalledTimes(2);
});

it('ignores backdrop, grabber and system back without prompting while the form is protected (iOS interactiveDismissDisabled)', async () => {
  await render({ preventDismiss: true });
  const mounts = h.mounts;
  h.modal.onBackdropPress(); h.modal.onRequestClose();
  await act(async () => h.surface.onClose());
  expect(close).not.toHaveBeenCalled();
  // A blocked drag remounts the surface so it springs back instead of staying half-dismissed.
  expect(h.mounts).toBe(mounts + 1);
});

it.each([false, true])('treats the system back key as the in-page Back on a secondary page (protected: %s)', async preventDismiss => {
  await render({ preventDismiss, onBack: back });
  h.modal.onRequestClose();
  expect(back).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  expect(h.surface.onBack).toBe(back);
});
