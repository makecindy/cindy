// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  KeyboardEvent,
  KeyboardEventName,
  KeyboardMetrics,
} from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerKeyboardAvoidingView } from '@/session/ComposerKeyboardAvoidingView';
import { useMobileKeyboardState } from '@/session/useMobileKeyboardState';
import { useComposerCardTransition } from '@/session/useComposerCardTransition';
import { motionDuration } from '@/theme/tokens';

const native = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  viewport: { width: 390, height: 844, scale: 3, fontScale: 1 },
  shown: false,
  metrics: undefined as KeyboardMetrics | undefined,
  reducedMotion: false as boolean | null,
  listeners: new Map<KeyboardEventName, Set<(event: KeyboardEvent) => void>>(),
  schedule: vi.fn(),
  configure: vi.fn(),
  crossFade: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  type Props = {
    children?: ReactNode;
    style?: object | object[];
    behavior?: string;
  };
  const View = ({ children, style }: Props) =>
    createElement(
      'div',
      {
        'data-container': 'view',
        style: Array.isArray(style) ? Object.assign({}, ...style) : style,
      },
      children,
    );
  return {
    View,
    KeyboardAvoidingView: ({ children, behavior, style }: Props) =>
      createElement(
        'div',
        {
          'data-container': 'kav',
          'data-behavior': behavior,
          style,
        },
        children,
      ),
    Platform: native.platform,
    useWindowDimensions: () => native.viewport,
    Keyboard: {
      get isVisible() {
        return native.platform.OS === 'web' ? undefined : () => native.shown;
      },
      get metrics() {
        return native.platform.OS === 'web' ? undefined : () => native.metrics;
      },
      addListener: (
        name: KeyboardEventName,
        listener: (event: KeyboardEvent) => void,
      ) => {
        const listeners = native.listeners.get(name) ?? new Set();
        native.listeners.set(name, listeners);
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
      scheduleLayoutAnimation: native.schedule,
    },
    LayoutAnimation: { configureNext: native.configure },
    AccessibilityInfo: { prefersCrossFadeTransitions: native.crossFade },
    UIManager: {},
  };
});
vi.mock('@/hooks/useReduceMotion', () => ({
  getCachedReduceMotionEnabled: () => native.reducedMotion,
  useReduceMotionEnabled: () => native.reducedMotion,
}));

function Harness({ active = false, inset = 0 }) {
  const keyboard = useMobileKeyboardState();
  useComposerCardTransition(active, keyboard);
  return (
    <ComposerKeyboardAvoidingView
      keyboard={keyboard}
      bottomInset={inset}
      behavior="height"
    >
      <output data-height={keyboard.height} data-visible={keyboard.visible} />
    </ComposerKeyboardAvoidingView>
  );
}

function keyboardEvent(
  screenY = 544,
  height = 300,
  duration = 360,
): KeyboardEvent {
  return {
    duration,
    easing: 'keyboard',
    endCoordinates: { screenX: 0, screenY, width: 390, height },
  };
}

let root: Root;
let container: HTMLDivElement;
function render(props: Parameters<typeof Harness>[0] = {}) {
  act(() => root.render(<Harness {...props} />));
}
function emit(name: KeyboardEventName, event = keyboardEvent()) {
  act(() => {
    // 与 RN KeyboardImpl 一致：原生缓存只由 didShow / didHide 更新。
    if (name === 'keyboardDidShow') {
      native.shown = true;
      native.metrics = event.endCoordinates;
    } else if (name === 'keyboardDidHide') {
      native.shown = false;
      native.metrics = undefined;
    }
    for (const listener of native.listeners.get(name) ?? []) listener(event);
  });
}
function height() {
  return Number(container.querySelector('output')?.getAttribute('data-height'));
}
function padding() {
  return (container.firstElementChild as HTMLElement).style.paddingBottom;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.platform.OS = 'ios';
  native.viewport = { width: 390, height: 844, scale: 3, fontScale: 1 };
  native.shown = false;
  native.metrics = undefined;
  native.reducedMotion = false;
  native.listeners.clear();
  native.schedule.mockReset();
  native.configure.mockReset();
  native.crossFade.mockReset().mockResolvedValue(false);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('composer keyboard geometry and motion', () => {
  it('updates both available height and iOS avoidance when an already-open keyboard changes height', () => {
    render();
    emit('keyboardWillShow');
    expect(height()).toBe(300);
    expect(padding()).toBe('300px');
    const emojiKeyboard = keyboardEvent(444, 400, 480);
    emit('keyboardWillChangeFrame', emojiKeyboard);
    expect(height()).toBe(400);
    expect(padding()).toBe('400px');
    expect(native.schedule).toHaveBeenLastCalledWith(emojiKeyboard);
    expect(container.querySelector('[data-container="kav"]')).toBeNull();
  });

  it('uses visible overlap while dragging down, including cancellation and the final few points', () => {
    render();
    emit('keyboardWillShow');
    for (const [top, expected] of [
      [744, 100],
      [840, 4],
      [844, 0],
      [544, 300],
    ]) {
      emit('keyboardWillChangeFrame', keyboardEvent(top, 300, 0));
      expect(height()).toBe(expected);
      expect(padding()).toBe(`${expected}px`);
    }
    expect(native.schedule).toHaveBeenCalledTimes(1);
    expect(native.configure).toHaveBeenLastCalledWith({
      duration: 0,
      update: { duration: 0, type: 'linear' },
    });
  });

  it('removes avoidance on hide and ignores late floating keyboard frames until the next show', () => {
    render();
    emit('keyboardWillShow');
    emit('keyboardWillChangeFrame', keyboardEvent(300, 300));
    expect(padding()).toBe('0px');
    emit('keyboardWillHide');
    emit('keyboardWillChangeFrame');
    expect(height()).toBe(0);
    emit('keyboardWillShow');
    expect(height()).toBe(300);
  });

  it('does not move the whole page for a narrow floating iPad keyboard', () => {
    render();
    const floating = keyboardEvent();
    floating.endCoordinates.width = 250;
    emit('keyboardWillShow', floating);
    expect(height()).toBe(0);
  });

  it('subtracts the new-page safe area once without affecting the full-window detail page', () => {
    render({ inset: 34 });
    emit('keyboardWillShow');
    expect(height()).toBe(300);
    expect(padding()).toBe('266px');
    render({ inset: 0 });
    expect(padding()).toBe('300px');
    emit('keyboardWillHide');
    expect(padding()).toBe('0px');
  });

  it('uses initial metrics only for mounting with an open keyboard, then follows frame events', () => {
    native.shown = true;
    native.metrics = keyboardEvent().endCoordinates;
    render();
    expect(height()).toBe(300);
    emit('keyboardWillChangeFrame', keyboardEvent(644));
    expect(height()).toBe(200);
  });

  it('deduplicates equal show/frame geometry instead of rescheduling the same animation', () => {
    render();
    emit('keyboardWillShow');
    emit('keyboardWillChangeFrame', keyboardEvent());
    emit('keyboardDidChangeFrame', keyboardEvent());
    emit('keyboardDidShow', keyboardEvent());
    expect(native.schedule).toHaveBeenCalledTimes(1);
    expect(native.configure).not.toHaveBeenCalled();
  });

  it('clears stale metrics when mounting between willHide and didHide', () => {
    emit('keyboardDidShow');
    emit('keyboardWillHide');
    render();
    expect(height()).toBe(300);
    emit('keyboardDidHide');
    expect(height()).toBe(0);
    expect(padding()).toBe('0px');
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('reconciles an opening keyboard whose willShow preceded mounting without replaying its animation', () => {
    emit('keyboardWillShow');
    render();
    expect(height()).toBe(0);
    emit('keyboardDidShow');
    expect(height()).toBe(300);
    expect(padding()).toBe('300px');
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('reconciles a keyboard resize whose willChangeFrame preceded mounting', () => {
    emit('keyboardDidShow');
    emit('keyboardWillChangeFrame', keyboardEvent(444, 400));
    render();
    expect(height()).toBe(300);
    emit('keyboardDidChangeFrame', keyboardEvent(444, 400));
    expect(height()).toBe(400);
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('preserves the cross-fade screenY=0 exception', async () => {
    native.crossFade.mockResolvedValue(true);
    render();
    await act(async () => {
      emit('keyboardWillShow', keyboardEvent(0, 844));
    });
    expect(height()).toBe(0);
    expect(padding()).toBe('0px');
  });

  it('ignores an old cross-fade query after a newer keyboard frame', async () => {
    let resolveCrossFade!: (value: boolean) => void;
    native.crossFade.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCrossFade = resolve;
        }),
    );
    render();
    emit('keyboardWillShow', keyboardEvent(0, 844));
    emit('keyboardWillChangeFrame', keyboardEvent(444, 400));
    await act(async () => resolveCrossFade(true));
    expect(height()).toBe(400);
  });

  it('does not flash a full-screen inset when mounting with cross-fade keyboard metrics', async () => {
    native.shown = true;
    native.metrics = keyboardEvent(0, 844).endCoordinates;
    native.crossFade.mockResolvedValue(true);
    render();
    expect(padding()).toBe('0px');
    await act(async () => {});
    expect(height()).toBe(0);
  });

  it('does not add a card animation to a zero-duration keyboard update in the same commit', () => {
    render();
    act(() => {
      for (const listener of native.listeners.get('keyboardWillShow') ?? []) {
        listener(keyboardEvent(544, 300, 0));
      }
      root.render(<Harness active />);
    });
    expect(padding()).toBe('300px');
    expect(native.configure).toHaveBeenCalledTimes(1);
    expect(native.configure).toHaveBeenCalledWith({
      duration: 0,
      update: { duration: 0, type: 'linear' },
    });
  });

  it.each([true, null])(
    'keeps geometry working without extra motion when reduce-motion is %s',
    (reducedMotion) => {
      native.reducedMotion = reducedMotion;
      render();
      render({ active: true });
      expect(native.configure).not.toHaveBeenCalled();
      emit('keyboardWillShow');
      expect(height()).toBe(300);
      expect(native.schedule).not.toHaveBeenCalled();
      expect(native.configure).toHaveBeenLastCalledWith({
        duration: 0,
        update: { duration: 0, type: 'linear' },
      });
    },
  );

  it('animates a card before keyboard events arrive, then yields to actual keyboard timing', () => {
    render();
    render({ active: true });
    expect(native.configure).toHaveBeenCalledWith(
      expect.objectContaining({ duration: motionDuration.base }),
    );
    native.configure.mockClear();
    emit('keyboardWillShow');
    render({ active: false });
    expect(native.configure).not.toHaveBeenCalled();
    emit('keyboardWillHide');
    expect(native.schedule).toHaveBeenCalledTimes(2);
  });

  it('uses the size-change token for standalone card transitions, without replaying old keyboard motion', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    render();
    emit('keyboardWillShow');
    now.mockReturnValue(2000);
    render({ active: true });
    expect(native.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: motionDuration.base }),
    );
    expect(native.schedule).toHaveBeenCalledTimes(1);
  });

  it('preserves Android did-events and KAV height behavior without adding another keyboard inset', () => {
    native.platform.OS = 'android';
    render({ inset: 24 });
    emit('keyboardDidShow', keyboardEvent(544, 300, 0));
    expect(height()).toBe(300);
    expect(
      container
        .querySelector('[data-container="kav"]')
        ?.getAttribute('data-behavior'),
    ).toBe('height');
    expect(padding()).toBe('');
    expect(native.schedule).not.toHaveBeenCalled();
    expect(native.configure).not.toHaveBeenCalled();
    emit('keyboardDidHide');
    expect(height()).toBe(0);
    render({ active: true });
    expect(native.configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ duration: motionDuration.base }),
    );
  });

  it('mounts on web without native keyboard snapshot APIs or extra avoidance', () => {
    native.platform.OS = 'web';
    render({ inset: 34 });
    expect(height()).toBe(0);
    expect(container.querySelector('output')?.getAttribute('data-visible')).toBe('false');
    expect(container.querySelector('[data-container="kav"]')).not.toBeNull();
    expect(padding()).toBe('');
    expect(native.schedule).not.toHaveBeenCalled();
  });

  it('removes every keyboard listener on unmount', () => {
    render();
    act(() => root.render(null));
    expect(
      [...native.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
  });
});
