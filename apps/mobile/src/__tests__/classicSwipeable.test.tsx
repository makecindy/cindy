import { describe, expect, it, vi } from 'vitest';
import Swipeable from '@/platform/ClassicSwipeable';
import { Platform } from 'react-native';
import { State } from 'react-native-gesture-handler';

vi.mock('react-native', () => {
  class Value {
    constructor(public value = 0) {}
    setValue(value: number) { this.value = value; }
    interpolate() { return this; }
  }
  return {
    Platform: { OS: 'android' }, I18nManager: { isRTL: false }, View: 'view',
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
    Animated: { Value, View: 'animated-view', add: () => new Value(), event: () => () => {},
      spring: (value: Value, config: { toValue: number }) => ({
        start: (complete: (result: { finished: boolean }) => void) => {
          value.setValue(config.toValue); complete({ finished: true });
        },
      }),
    },
  };
});
vi.mock('react-native-gesture-handler', () => ({
  PanGestureHandler: 'pan', TapGestureHandler: 'tap',
  State: { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 },
}));

// Unit, #10586: exercise the shared production row's native boundary and release
// path, absent from the caller lifecycle fixtures (which replace ClassicSwipeable).
// Native threshold arbitration itself still requires Android device verification.
function row(extra = {}) {
  const opened = vi.fn();
  const started = vi.fn();
  const swipe = new Swipeable({ ...Swipeable.defaultProps, onSwipeableOpen: opened,
    onSwipeableOpenStartDrag: started, ...extra });
  swipe.setState = ((state: object) => Object.assign(swipe.state, state)) as typeof swipe.setState;
  Object.assign(swipe.state, { leftWidth: 80, rowWidth: 400, rightOffset: 320 });
  return { swipe, opened, started, pan: swipe.render().props };
}

describe('shared classic swipe recognition boundary', () => {
  it('gives vertical-first Android gestures to scrolling without exposing actions', () => {
    Platform.OS = 'android';
    const { swipe, pan, opened, started } = row();
    expect(pan.activeOffsetX).toEqual([-16, 16]);
    expect(pan.failOffsetY).toEqual([-16, 16]);
    // Native failure before activation, even if horizontal drift later passes 16.
    pan.onHandlerStateChange({ nativeEvent: {
      oldState: State.BEGAN, state: State.FAILED, translationX: 24, translationY: 90, velocityX: 0,
    } });
    expect(swipe.state.rowState).toBe(0);
    expect(started).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([[-60, 'right', -1], [60, 'left', 1]] as const)(
    'still opens actions on deliberate horizontal release %s', (translationX, direction, position) => {
      Platform.OS = 'android';
      const { swipe, pan, opened, started } = row();
      const nativeEvent = { translationX, translationY: 3, velocityX: 0 };
      pan.onHandlerStateChange({ nativeEvent: { ...nativeEvent, oldState: State.BEGAN, state: State.ACTIVE } });
      pan.onHandlerStateChange({ nativeEvent: { ...nativeEvent, oldState: State.ACTIVE, state: State.END } });
      expect(started).toHaveBeenCalledWith(direction);
      expect(opened).toHaveBeenCalledWith(direction, swipe);
      expect(swipe.state.rowState).toBe(position);
    },
  );

  it('preserves iOS defaults and explicit caller gesture overrides', () => {
    Platform.OS = 'ios';
    expect(row().pan.activeOffsetX).toEqual([-10, 10]);
    expect(row().pan.failOffsetY).toBeUndefined();
    Platform.OS = 'android';
    const { pan } = row({ dragOffsetFromLeftEdge: 24, dragOffsetFromRightEdge: 20, failOffsetY: [-8, 8] });
    expect(pan.activeOffsetX).toEqual([-20, 24]);
    expect(pan.failOffsetY).toEqual([-8, 8]);
  });
});
