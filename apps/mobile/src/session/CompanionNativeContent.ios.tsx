import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { HStack, RNHostView } from '@expo/ui/swift-ui';
import { frame, onGeometryChange } from '@expo/ui/swift-ui/modifiers';

/** Measure the native form row before asking Yoga for the content's height. */
export function CompanionNativeContent({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(0);
  return <HStack modifiers={[
    frame({ maxWidth: Infinity }),
    onGeometryChange(size => { if (size.width > 0) setWidth(size.width); }),
  ]}>
    <RNHostView matchContents><View style={{ width }}>{width > 0 ? children : null}</View></RNHostView>
  </HStack>;
}
