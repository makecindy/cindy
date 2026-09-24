import { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetModal } from './SheetModal';
import { SheetSurface } from './SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from './contextSheetModel';
import type { ComposerSheetProps } from './ComposerSheet';
export type CompanionSheetProps = ComposerSheetProps & { preventDismiss?: boolean };
export function CompanionSheet({ visible, title, onClose, onClosed, onBack, children, footer, testID, preventDismiss }: CompanionSheetProps) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const close = () => { if (preventDismiss) setSurfaceEpoch(value => value + 1); onClose(); };
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  useEffect(() => { if (visible) setSnap('half'); }, [visible]);
  const heights = useMemo(() => computeContextSheetSnapHeights({ screenHeight: height, safeAreaTopInset: insets.top }), [height, insets.top]);
  return <SheetModal visible={visible} onBackdropPress={close} onRequestClose={onBack ?? onClose} onClosed={onClosed} keyboardAvoiding keyboardAvoidingBehavior="height">
    <SheetSurface key={surfaceEpoch} title={title} heights={heights} snap={snap} onSnapChange={setSnap} bottomInset={insets.bottom} onClose={close} onBack={onBack} footer={footer} testID={testID}>
      {children}
    </SheetSurface>
  </SheetModal>;
}
