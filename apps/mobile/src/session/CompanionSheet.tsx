import { useEffect, useMemo, useState } from 'react';
import { Pressable, useWindowDimensions } from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SheetModal } from './SheetModal';
import { SheetSurface } from './SheetSurface';
import { computeContextSheetSnapHeights, type ContextSheetSnap } from './contextSheetModel';
import type { ComposerSheetProps } from './ComposerSheet';
import { MainWindowActionButton, type MainWindowAction } from '@/components/MobilePrimitives';
import { iconSize, iconStroke, radius, useTheme } from '@/theme';
export type CompanionSheetProps = ComposerSheetProps & {
  leadingAction?: MainWindowAction;
  trailingAction?: MainWindowAction;
  onShow?(): void;
  initialSnap?: ContextSheetSnap;
  keyboardAvoidingBehavior?: 'height' | 'padding';
};
/**
 * Android shell with the iOS dismissal contract (`interactiveDismissDisabled`): while a draft is
 * unsaved or a submit is in flight, the backdrop, the grabber and the system back key neither close
 * nor prompt. The system back key stays the in-page Back when a secondary page offers one.
 */
export function CompanionSheet({ visible, title, onClose, onClosed, onShow, onBack, children, footer, testID, preventDismiss, leadingAction, trailingAction, initialSnap = 'half', keyboardAvoidingBehavior = 'height' }: CompanionSheetProps) {
  const { colors } = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  // A blocked drag-dismiss remounts the surface so it springs back to its detent.
  const dismiss = () => { if (preventDismiss) setSurfaceEpoch(value => value + 1); else onClose(); };
  const requestClose = () => { if (onBack) onBack(); else if (!preventDismiss) onClose(); };
  const [snap, setSnap] = useState<ContextSheetSnap>(initialSnap);
  useEffect(() => { if (visible) setSnap(initialSnap); }, [visible, initialSnap]);
  const heights = useMemo(() => computeContextSheetSnapHeights({ screenHeight: height, safeAreaTopInset: insets.top }), [height, insets.top]);
  return <SheetModal visible={visible} onBackdropPress={() => { if (!preventDismiss) onClose(); }} onRequestClose={requestClose} onClosed={onClosed} onShow={onShow} keyboardAvoiding keyboardAvoidingBehavior={keyboardAvoidingBehavior}>
    <SheetSurface key={surfaceEpoch} title={title} heights={heights} snap={snap} onSnapChange={setSnap} bottomInset={insets.bottom} onClose={dismiss} onBack={onBack} footer={footer} testID={testID}
      headerLeading={leadingAction ? <Pressable accessibilityRole="button"
        accessibilityLabel={leadingAction.accessibilityLabel ?? leadingAction.label}
        accessibilityState={{ disabled: !!leadingAction.disabled || !!leadingAction.busy }}
        disabled={leadingAction.disabled || leadingAction.busy} onPress={leadingAction.onPress}
        testID={leadingAction.testID} hitSlop={4}
        style={({ pressed }) => ({ width: 36, height: 36, borderRadius: radius.pill,
          alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceChip,
          opacity: leadingAction.disabled || leadingAction.busy ? 0.5 : pressed ? 0.7 : 1 })}>
        <X size={iconSize.action} strokeWidth={iconStroke.regular} color={colors.textPrimary} />
      </Pressable> : undefined}
      headerTrailing={trailingAction ? <MainWindowActionButton action={trailingAction} density="compact" /> : undefined}>
      {children}
    </SheetSurface>
  </SheetModal>;
}
