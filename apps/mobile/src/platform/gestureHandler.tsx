import Constants, { ExecutionEnvironment } from 'expo-constants';
import React, {
  forwardRef,
  useImperativeHandle,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { View, type ViewProps } from 'react-native';
import type {
  Gesture as GestureApi,
  GestureDetector as GestureDetectorApi,
  GestureHandlerRootView as GestureHandlerRootViewApi,
} from 'react-native-gesture-handler';
import type {
  SwipeableMethods,
  SwipeableProps,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { SwipeableProps as ClassicSwipeableProps } from 'react-native-gesture-handler/Swipeable';

type GestureHandlerModule = typeof import('react-native-gesture-handler');
type ReanimatedSwipeableModule =
  typeof import('react-native-gesture-handler/ReanimatedSwipeable');
type ClassicSwipeableModule =
  typeof import('react-native-gesture-handler/Swipeable');

const isStoreClient =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

let gestureHandlerModule: GestureHandlerModule | null | undefined;
let reanimatedSwipeableModule: ReanimatedSwipeableModule | null | undefined;
let classicSwipeableModule: ClassicSwipeableModule | null | undefined;

function loadGestureHandler(): GestureHandlerModule | null {
  if (isStoreClient) return null;
  if (gestureHandlerModule === undefined) {
    gestureHandlerModule = require(
      'react-native-gesture-handler',
    ) as GestureHandlerModule;
  }
  return gestureHandlerModule;
}

function loadReanimatedSwipeable(): ReanimatedSwipeableModule | null {
  if (isStoreClient) return null;
  if (reanimatedSwipeableModule === undefined) {
    reanimatedSwipeableModule = require(
      'react-native-gesture-handler/ReanimatedSwipeable',
    ) as ReanimatedSwipeableModule;
  }
  return reanimatedSwipeableModule;
}

function loadClassicSwipeable(): ClassicSwipeableModule | null {
  if (isStoreClient) return null;
  if (classicSwipeableModule === undefined) {
    classicSwipeableModule = require(
      'react-native-gesture-handler/Swipeable',
    ) as ClassicSwipeableModule;
  }
  return classicSwipeableModule;
}

function NoopGestureHandlerRootView(props: ViewProps) {
  return React.createElement(View, props);
}

function NoopGestureDetector({ children }: { children: ReactNode }) {
  return React.createElement(React.Fragment, null, children);
}

const noopGesture = new Proxy(
  {},
  {
    get() {
      return () => noopGesture;
    },
  },
);

const noopGestureApi = new Proxy(
  {},
  {
    get() {
      return () => noopGesture;
    },
  },
) as unknown as typeof GestureApi;

const noopSwipeableMethods: SwipeableMethods = {
  close() {},
  openLeft() {},
  openRight() {},
  reset() {},
};

const NoopReanimatedSwipeable = forwardRef<SwipeableMethods, SwipeableProps>(
  ({ children, containerStyle, testID }, ref) => {
    useImperativeHandle(ref, () => noopSwipeableMethods, []);
    return (
      <View style={containerStyle} testID={testID}>
        {children}
      </View>
    );
  },
);
NoopReanimatedSwipeable.displayName = 'NoopReanimatedSwipeable';

export interface ClassicSwipeableMethods {
  close(): void;
  openLeft(): void;
  openRight(): void;
  reset(): void;
}

const NoopClassicSwipeable = forwardRef<ClassicSwipeableMethods, ClassicSwipeableProps>(
  ({ children, containerStyle, testID }, ref) => {
    useImperativeHandle(ref, () => noopSwipeableMethods, []);
    return (
      <View style={containerStyle} testID={testID}>
        {children}
      </View>
    );
  },
);
NoopClassicSwipeable.displayName = 'NoopClassicSwipeable';

export const GestureHandlerRootView =
  loadGestureHandler()?.GestureHandlerRootView ??
  (NoopGestureHandlerRootView as unknown as typeof GestureHandlerRootViewApi);

export const GestureDetector =
  loadGestureHandler()?.GestureDetector ??
  (NoopGestureDetector as unknown as typeof GestureDetectorApi);

export const Gesture = loadGestureHandler()?.Gesture ?? noopGestureApi;

export const ReanimatedSwipeable =
  loadReanimatedSwipeable()?.default ??
  (NoopReanimatedSwipeable as unknown as React.ComponentType<SwipeableProps>);

export const ClassicSwipeable = (
  loadClassicSwipeable()?.default ?? NoopClassicSwipeable
) as unknown as React.ComponentType<
  ClassicSwipeableProps & React.RefAttributes<ClassicSwipeableMethods>
>;

export const SwipeDirection = loadReanimatedSwipeable()?.SwipeDirection ?? {
  LEFT: 'left',
  RIGHT: 'right',
};

export type { SwipeableMethods, SwipeableProps };
export type GestureHandlerRootViewProps = ComponentProps<
  typeof GestureHandlerRootView
>;
