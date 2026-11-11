import { useEffect } from 'react';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { GestureDetector } from '@/platform/gestureHandler';
import { MobileComposerInputRow, ComposerResizeGrabber, type MobileComposerInputRowProps } from './MobileComposerInputRow';
import { textScrollEdgeFromEvent } from './composerResize';
import type { useComposerResize } from './useComposerResize';
import type { ComposerPullThroughBridge } from './composerPullThrough';

type Props = MobileComposerInputRowProps & {
  autoMaxHeight?: number;
  chromeHeight?: number;
  resize: ReturnType<typeof useComposerResize>;
  pullThrough?: ComposerPullThroughBridge;
  grabberTestID?: string;
};

/** Shared gesture ownership, folding and resize handle. Callers only supply business slots. */
export function ResizableComposerInputRow({ resize, pullThrough, grabberTestID, autoMaxHeight, chromeHeight = 0, ...props }: Props) {
  useEffect(() => {
    if (!pullThrough) return;
    pullThrough.armed.value = props.cardActive === true;
    return () => { pullThrough.armed.value = false; };
  }, [props.cardActive, pullThrough]);
  const active = resize.active;
  const manual = resize.mode === 'manual';
  const expandedMax = resize.maxFrameHeight + chromeHeight;
  const bounds = useAnimatedStyle(() => ({
    maxHeight: autoMaxHeight == null ? undefined : active.value || manual ? expandedMax : autoMaxHeight,
  }));
  return <GestureDetector gesture={resize.bodyGesture}>
    <Reanimated.View style={[{ flexShrink: 1 }, bounds]}>
      <MobileComposerInputRow {...props}
        bodyScrollGesture={resize.scrollGesture}
        inputFrameAnimatedStyle={resize.frameStyle}
        inputFrameRef={resize.textFrameRef}
        collapseProgress={resize.collapseProgress}
        maxHeight={resize.inputMaxHeight}
        scrollEnabled={resize.scrollEnabled}
        onScroll={event => {
          // Android 的 TextInput 滚动事件不带 contentSize / layoutMeasurement：端点未知时回落到 measuredOverflow。
          resize.setTextScrollEdge(textScrollEdgeFromEvent(event.nativeEvent));
          props.onScroll?.(event);
        }}
        resizeHandle={props.cardActive ? <ComposerResizeGrabber visible
          onAdjust={resize.adjustByLine} panHandlers={resize.panHandlers} gesture={resize.gesture}
          measureRef={pullThrough?.grabberRef} testID={grabberTestID} /> : null}
      />
    </Reanimated.View>
  </GestureDetector>;
}
