import { useEffect, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetModal } from './SheetModal';
import { SheetSurface } from './SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from './contextSheetModel';
import type { ComposerSheetProps } from './ComposerSheet';
export type CompanionSheetProps = ComposerSheetProps & { preventDismiss?: boolean };
/**
 * Android shell with the iOS dismissal contract (`interactiveDismissDisabled`): while a draft is
 * unsaved or a submit is in flight, the backdrop, the grabber and the system back key neither close
 * nor prompt. The system back key stays the in-page Back when a secondary page offers one.
 */
export function CompanionSheet({ visible, title, onClose, onClosed, onBack, children, footer, testID, preventDismiss }: CompanionSheetProps) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  // A blocked drag-dismiss remounts the surface so it springs back to its detent.
  const dismiss = () => { if (preventDismiss) setSurfaceEpoch(value => value + 1); else onClose(); };
  const requestClose = () => { if (onBack) onBack(); else if (!preventDismiss) onClose(); };
  const [snap, setSnap] = useState<ContextSheetSnap>('half');
  useEffect(() => { if (visible) setSnap('half'); }, [visible]);
  const heights = useMemo(() => computeContextSheetSnapHeights({ screenHeight: height, safeAreaTopInset: insets.top }), [height, insets.top]);
  return <SheetModal visible={visible} onBackdropPress={() => { if (!preventDismiss) onClose(); }} onRequestClose={requestClose} onClosed={onClosed} keyboardAvoiding keyboardAvoidingBehavior="height">
    <SheetSurface key={surfaceEpoch} title={title} heights={heights} snap={snap} onSnapChange={setSnap} bottomInset={insets.bottom} onClose={dismiss} onBack={onBack} footer={footer} testID={testID}>
      {children}
    </SheetSurface>
  </SheetModal>;
}
