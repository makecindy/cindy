import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, radius, spacing } from '@/theme';
import { TaskTagsPanel } from './TaskTags';
import { ComposerSheet } from './ComposerSheet';
import { NativeTaskTagsExpanded } from './TaskTagsNative';
import { taskTagsPageTitle, useTaskTagsNativePage } from './taskTagsNativePage';
import { SheetModal } from './SheetModal';
import type { RemoteSession } from './types';

// Present only after the previous sheet has fully dismissed. In particular, do
// not forward the parent's onClosed while temporarily handing off to tags.
export function useTaskTagsSheet(visible: boolean, onClosed?: () => void) {
  const [phase, setPhase] = useState<'idle' | 'opening' | 'open' | 'closing'>('idle');
  useEffect(() => {
    if (!visible) setPhase('idle');
  }, [visible]);
  return {
    parentVisible: visible && phase === 'idle',
    mounted: phase === 'open' || phase === 'closing',
    visible: visible && phase === 'open',
    open: () => setPhase('opening'),
    close: () => setPhase('closing'),
    parentClosed: () => {
      if (visible && phase === 'opening') setPhase('open');
      else onClosed?.();
    },
    closed: () => setPhase('idle'),
  };
}

export function TaskTagsSheet({
  session,
  deviceId,
  disabled,
  visible,
  onClose,
  onClosed,
}: {
  session: RemoteSession;
  deviceId?: string;
  disabled?: boolean;
  visible: boolean;
  onClose(): void;
  onClosed(): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const tagPage = useTaskTagsNativePage();
  const ios = Platform.OS === 'ios';
  const panel = (
    <TaskTagsPanel
      key={`${deviceId ?? session.canonicalDeviceId ?? session.deviceLinkDeviceId}:${session.id}`}
      session={session}
      deviceId={deviceId}
      disabled={disabled}
      expanded
      showDone={false}
      onExpandedChange={() => {}}
      renderExpanded={ios ? (state) => <NativeTaskTagsExpanded state={state} /> : undefined}
      onPageChange={ios ? tagPage.onPageChange : undefined}
    />
  );
  if (ios) {
    const page = tagPage.page ?? 'list';
    return (
      <ComposerSheet
        visible={visible}
        title={taskTagsPageTitle(page, t)}
        // This sheet opens from task details, so the list's back arrow closes it and lets
        // the parent reopen; the editor pages step back within the sheet.
        onBack={page === 'list' ? onClose : tagPage.back}
        backDisabled={page === 'list' ? false : tagPage.backDisabled}
        backLabel={t('taskTags.back')}
        onClose={onClose}
        onClosed={onClosed}
        nativeContent
        testID="taskTags.sheet"
      >
        {panel}
      </ComposerSheet>
    );
  }
  return (
    <SheetModal
      nativePresentation
      visible={visible}
      onRequestClose={onClose}
      onBackdropPress={onClose}
      onClosed={onClosed}
      keyboardAvoiding
    >
      <View
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: radius.container,
          borderTopRightRadius: radius.container,
          padding: spacing.lg,
          paddingBottom: spacing.lg + insets.bottom,
          maxHeight: '90%',
        }}
      >
        {panel}
      </View>
    </SheetModal>
  );
}
