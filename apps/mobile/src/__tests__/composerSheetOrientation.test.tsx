// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ComposerSheet } from '../session/ComposerSheet.ios';
import { presentationDetents } from '@expo/ui/swift-ui/modifiers';
const state = vi.hoisted(() => ({ width: 402, height: 874, sheet: null as any }));
vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>, ScrollView: ({ children }: any) => <div>{children}</div>,
  useWindowDimensions: () => ({ width: state.width, height: state.height }),
}));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return { Form: Container, Button: Container, Group: Container, HStack: Container, Image: Container,
    RNHostView: Container, Spacer: Container, Text: Container, VStack: Container,
    BottomSheet: (props: any) => { state.sheet = props; return <div>{props.children}</div>; },
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'contentShape', 'buttonStyle', 'font', 'foregroundStyle', 'frame', 'padding', 'presentationDetents', 'presentationDragIndicator', 'interactiveDismissDisabled', 'scrollContentBackground'].map(name => [name, vi.fn(() => ({}))])),
  shapes: { rectangle: () => ({}) },
}));
vi.mock('@/theme', () => ({ iconSize: { lg: 20 }, useTheme: () => ({ mode: 'light', colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('selects a supported native detent when opening and rotating a menu', () => {
  const root = createRoot(document.createElement('div'));
  const onClose = vi.fn(); const onClosed = vi.fn();
  const render = () => act(() => root.render(<ComposerSheet visible title="" nativeContent onClose={onClose} onClosed={onClosed}><span>Menu</span></ComposerSheet>));
  try {
    render();
    expect(presentationDetents).toHaveBeenLastCalledWith(['medium', 'large'], { selection: 'medium' });
    state.width = 874; state.height = 402; render();
    expect(presentationDetents).toHaveBeenLastCalledWith(['large'], { selection: 'large' });
    expect(state.sheet.isPresented).toBe(true);
    state.width = 402; state.height = 874; render();
    expect(presentationDetents).toHaveBeenLastCalledWith(['medium', 'large'], { selection: 'medium' });
    expect(onClose).not.toHaveBeenCalled();
    act(() => state.sheet.onIsPresentedChange(false));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClosed).not.toHaveBeenCalled();
    act(() => state.sheet.onDismiss());
    expect(onClosed).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});
