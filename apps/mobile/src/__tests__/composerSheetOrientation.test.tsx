// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ComposerSheet } from '../session/ComposerSheet.ios';
import { CompanionSheet } from '../session/CompanionSheet.ios';
import { FormSheet } from '../session/FormSheet.ios';
import { ScrollView as RNScrollView } from 'react-native';
import { onGeometryChange, presentationDetents } from '@expo/ui/swift-ui/modifiers';
const state = vi.hoisted(() => ({ width: 402, height: 874, sheet: null as any, formScreen: null as any, formStack: null as any }));
vi.mock('../session/ComposerSheet', async () => import('../session/ComposerSheet.ios'));
vi.mock('react-native', () => ({
  View: ({ children, style }: any) => <div style={style}>{children}</div>,
  ScrollView: ({ children, maintainVisibleContentPosition }: any) => <section data-rn-scroll data-preserve-position={maintainVisibleContentPosition?.minIndexForVisible}>{children}</section>,
  useWindowDimensions: () => ({ width: state.width, height: state.height }),
  Modal: () => { throw new Error('A native stack must own form presentation without a second Modal touch root'); },
  ActivityIndicator: () => <span role="progressbar" />,
  StyleSheet: { create: (styles: any) => styles },
}));
vi.mock('react-native-screens', () => ({
  ScreenStack: (props: any) => { state.formStack = props; return props.children; },
  ScreenStackItem: (props: any) => {
    const { headerConfig, children } = props;
    if (headerConfig.hidden) return null;
    state.formScreen = props;
    return <div>
      <nav>{[...headerConfig.headerLeftBarButtonItems, ...headerConfig.headerRightBarButtonItems].map((item: any) =>
        <button key={item.identifier} data-testid={item.identifier} aria-label={item.accessibilityLabel}
          data-system-image={item.icon?.name} disabled={item.disabled} onClick={item.onPress}>{item.title}</button>)}</nav>
      {children}
    </div>;
  },
}));
vi.mock('../session/CompanionNativeContent.ios', () => ({
  CompanionNativeContent: ({ children }: any) => <div data-rn-size="content">{children}</div>,
}));
vi.mock('@expo/ui', () => ({ Host: ({ children }: any) => <div>{children}</div> }));
vi.mock('@expo/ui/swift-ui', () => {
  const Container = ({ children }: any) => <div>{children}</div>;
  return { ScrollView: ({ children }: any) => <section data-native-scroll>{children}</section>,
    Form: ({ children, modifiers }: any) => <div data-native="Form" data-modifiers={JSON.stringify(modifiers)}>{children}</div>,
    List: ({ children, modifiers }: any) => <div data-native="List" data-modifiers={JSON.stringify(modifiers)}>{children}</div>,
    Button: ({ children, onPress }: any) => <button onClick={onPress}>{children}</button>, Group: Container, HStack: Container, Image: Container,
    RNHostView: ({ children, matchContents }: any) => <div data-rn-size={matchContents ? 'content' : 'viewport'}>{children}</div>,
    Spacer: Container, Text: Container, VStack: Container, ZStack: Container,
    BottomSheet: (props: any) => { state.sheet = props; return <div>{props.children}</div>; },
  };
});

it('uses a plain list only when requested and preserves form sheets', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<ComposerSheet visible title="" nativeContent nativeList onClose={() => {}}><span>Tasks</span></ComposerSheet>));
    expect(container.querySelector('[data-native="List"]')).not.toBeNull();
    expect(container.querySelector('[data-native="Form"]')).toBeNull();
    act(() => root.render(<ComposerSheet visible title="" nativeContent onClose={() => {}}><span>Settings</span></ComposerSheet>));
    expect(container.querySelector('[data-native="Form"]')).not.toBeNull();
    expect(container.querySelector('[data-native="List"]')).toBeNull();
  } finally { act(() => root.unmount()); }
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  disabled: vi.fn(() => ({})),
  environment: (key: string, value: string) => ({ environment: { key, value } }),
  containerRelativeFrame: vi.fn(() => ({})),
  onGeometryChange: vi.fn(() => ({})),
  ...Object.fromEntries(['accessibilityLabel', 'contentShape', 'buttonStyle', 'font', 'foregroundStyle', 'frame', 'padding', 'presentationDetents', 'presentationDragIndicator', 'interactiveDismissDisabled', 'scrollContentBackground', 'listStyle', 'scrollDismissesKeyboard'].map(name => [name, vi.fn(() => ({}))])),
  shapes: { rectangle: () => ({}) },
}));
vi.mock('@/theme', () => ({ spacing: { sm: 8, lg: 16 }, iconSize: { lg: 20 }, useTheme: () => ({ mode: 'light', colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// PR #7036: existing cases omit aboveContent and never deliver native geometry.
// Unit coverage exercises the real ComposerSheet's photo visibility and resizing;
// zero width followed by 653 -> 500 models opening and resizing a Duo sheet.
// This protects the RN state bridge, while native clipping is checked on-device.
it('shows the photo strip only after measurement and follows changes to the sheet width', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const measure = (width: number) => act(() => {
    const callback = vi.mocked(onGeometryChange).mock.calls.at(-1)![0];
    callback({ width, height: 627, x: 0, y: 0 });
  });
  try {
    act(() => root.render(
      <ComposerSheet visible title="" nativeContent onClose={() => {}}
        aboveContent={<span data-photo-strip>Recent photos</span>}>
        <span>Menu</span>
      </ComposerSheet>,
    ));
    measure(0);
    expect(container.querySelector('[data-photo-strip]')).toBeNull();
    measure(653);
    const strip = container.querySelector('[data-photo-strip]')!;
    expect(strip.textContent).toBe('Recent photos');
    expect(strip.parentElement?.style.width).toBe('653px');
    measure(500);
    expect(strip.parentElement?.style.width).toBe('500px');
    measure(0);
    expect(container.querySelector('[data-photo-strip]')).toBe(strip);
    expect(strip.parentElement?.style.width).toBe('500px');
  } finally { act(() => root.unmount()); }
});

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

// #7658: native appearance/dismissal events guard focus and opening the created group.
// RN Modal + ScreenStack swallowed row touches on-device; this mock rejects that nesting.
it('keeps native form actions outside the roster and waits for completed dismissal', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const close = vi.fn(); const create = vi.fn();
  const closed = vi.fn(); const shown = vi.fn();
  const render = (busy = false, visible = true) => act(() => root.render(<FormSheet visible={visible} title="New group" onClose={close}
    onClosed={closed} onShow={shown} preventDismiss={busy}
    leadingAction={{ label: 'Close', disabled: busy, onPress: close, testID: 'close' }}
    trailingAction={{ label: 'Create', busy, onPress: create, testID: 'create' }}>
    <span>Long roster</span>
  </FormSheet>));
  try {
    render();
    const viewport = container.querySelector('[data-rn-scroll]')!;
    expect(viewport.textContent).toBe('Long roster');
    expect(viewport.querySelector('button')).toBeNull();
    expect(container.querySelector('[data-testid=close]')?.getAttribute('data-system-image')).toBe('xmark');
    expect(container.querySelector('[data-testid=close]')?.getAttribute('aria-label')).toBe('Close');
    expect(container.querySelector('[data-testid=create]')?.textContent).toBe('Create');
    act(() => (container.querySelector('[data-testid=close]') as HTMLButtonElement).click());
    act(() => (container.querySelector('[data-testid=create]') as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    act(() => state.formScreen.onAppear());
    expect(shown).toHaveBeenCalledOnce();
    render(true);
    expect(state.formScreen.gestureEnabled).toBe(false);
    expect(state.formScreen.preventNativeDismiss).toBe(true);
    act(() => (container.querySelector('[data-testid=close]') as HTMLButtonElement).click());
    act(() => (container.querySelector('[data-testid=create]') as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(container.querySelector('[role=progressbar]')).not.toBeNull();
    expect(viewport.querySelector('[role=progressbar]')).toBeNull();
    const dismissed = state.formScreen.onDismissed;
    render(false, false);
    expect(closed).not.toHaveBeenCalled();
    act(() => state.formStack.onFinishTransitioning());
    expect(closed).toHaveBeenCalledOnce();
    act(() => state.formStack.onFinishTransitioning());
    expect(closed).toHaveBeenCalledOnce();
    act(() => dismissed());
    expect(close).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    render();
    act(() => state.formScreen.onAppear());
    expect(shown).toHaveBeenCalledTimes(2);
    act(() => state.formScreen.onDismissed());
    expect(close).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(2);
    render(false, false);
    act(() => state.formStack.onFinishTransitioning());
    expect(closed).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});

// DOM mocks cover composition; native scrolling needs simulator/device acceptance.
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

it('keeps self-scrolling companion pages on the existing RN viewport path', () => {
  state.width = 402; state.height = 874;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(
      <CompanionSheet visible title="" contentScrolls onClose={() => {}} footer={<span>Save</span>}>
        <RNScrollView maintainVisibleContentPosition={{ minIndexForVisible: 0 }}><span>Todo</span></RNScrollView>
      </CompanionSheet>,
    ));
    expect(container.querySelector('[data-native-scroll]')).toBeNull();
    expect(container.querySelector('[data-rn-size=content]')).toBeNull();
    const viewport = container.querySelector('[data-rn-size=viewport]');
    expect(viewport?.querySelector('[data-preserve-position="0"]')?.textContent).toBe('Todo');
    expect(viewport?.textContent).toContain('Save');
    expect(viewport?.querySelector('[data-rn-scroll]')?.textContent).not.toContain('Save');
    // The hosted viewport keeps the large layout; a medium detent would push the footer off screen.
    expect(presentationDetents).toHaveBeenLastCalledWith(['large'], { selection: 'large' });
  } finally { act(() => root.unmount()); }
});


// #6947: per-row editMode never exposes native handles; it belongs on the Form/List.
it.each([false, true])('applies requested edit mode to the native container (plain list: %s)', (nativeList) => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (editing?: boolean) => act(() => root.render(
    <ComposerSheet visible title="" nativeContent nativeList={nativeList} nativeEditMode={editing} onClose={() => {}}>
      <span>Tags</span>
    </ComposerSheet>,
  ));
  const modifiers = () => JSON.parse(container.querySelector('[data-native]')!.getAttribute('data-modifiers')!);
  try {
    render();
    expect(modifiers().some((m: any) => m.environment?.key === 'editMode')).toBe(false);
    render(true);
    expect(modifiers()).toContainEqual({ environment: { key: 'editMode', value: 'active' } });
    render(false);
    expect(modifiers()).toContainEqual({ environment: { key: 'editMode', value: 'inactive' } });
  } finally { act(() => root.unmount()); }
});
