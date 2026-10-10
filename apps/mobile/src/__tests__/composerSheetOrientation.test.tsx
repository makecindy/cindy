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
vi.mock('../session/CompanionNativeContent.ios', () => ({
  CompanionNativeContent: ({ children }: any) => <div data-rn-size="content">{children}</div>,
}));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return { ScrollView: ({ children }: any) => <section data-native-scroll>{children}</section>,
    Form: Container, Button: Container, Group: Container, HStack: Container, Image: Container,
    RNHostView: ({ children, matchContents }: any) => <div data-rn-size={matchContents ? "content" : "viewport"}>{children}</div>, Spacer: Container, Text: Container, VStack: Container, ZStack: Container,
    BottomSheet: (props: any) => { state.sheet = props; return <div>{props.children}</div>; },
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(['accessibilityLabel', 'contentShape', 'buttonStyle', 'font', 'foregroundStyle', 'frame', 'padding', 'presentationDetents', 'presentationDragIndicator', 'interactiveDismissDisabled', 'scrollContentBackground', 'scrollDismissesKeyboard'].map(name => [name, vi.fn(() => ({}))])),
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

// Native components are DOM mocks here: this guards composition only, not
// medium-detent scrolling, keyboard resizing, final-action reachability or footer visibility on iOS.
it('composes a content-sized RN bridge inside the native scroll component and a sibling footer', () => {
  state.width = 402; state.height = 874;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ComposerSheet visible title="" onClose={() => {}} footer={<span>Save</span>}><span>Delete group</span></ComposerSheet>));
    const viewport = container.querySelector('[data-native-scroll]');
    expect(viewport?.textContent).toBe('Delete group');
    expect(viewport?.querySelector('[data-rn-size=content]')).not.toBeNull();
    expect(viewport?.textContent).not.toContain('Save');
    expect(container.textContent).toContain('Save');
  } finally { act(() => root.unmount()); }
});
