import { Modal, StyleSheet, View } from 'react-native';
import { ModalContentArea } from '@/platform/ModalContentArea';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import { useTranslation } from 'react-i18next';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

export function CreateFolderModal({
  draft,
  error,
  onCancel,
  onChangeDraft,
  onConfirm,
  saving,
  visible,
}: {
  draft: string;
  error: string | null;
  onCancel(): void;
  onChangeDraft(value: string): void;
  onConfirm(): void;
  saving: boolean;
  visible: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const canCreate = draft.trim().length > 0 && !saving;

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!saving) onCancel();
      }}
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      transparent
      visible={visible}
    >
      <View style={styles.backdrop} testID="files.createFolder.backdrop">
        <ModalContentArea>
          <View style={styles.card} testID="files.createFolder.modal">
            <Text style={styles.title}>{t('files.browser.createFolderTitle')}</Text>
            <TextInput
              autoFocus
              editable={!saving}
              maxLength={255}
              onChangeText={onChangeDraft}
              onSubmitEditing={() => {
                if (canCreate) onConfirm();
              }}
              placeholder={t('files.browser.createFolderPlaceholder')}
              placeholderTextColor={colors.textPlaceholder}
              returnKeyType="done"
              style={styles.input}
              testID="files.createFolder.input"
              value={draft}
            />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <MainWindowActionGroup
              primaryActions={[{
                accessibilityLabel: t('files.browser.createFolder'),
                busy: saving,
                disabled: !canCreate,
                label: t('files.browser.createFolder'),
                onPress: onConfirm,
                testID: 'files.createFolder.confirm',
                tone: 'primary',
              }]}
              cancelAction={{
                accessibilityLabel: t('files.browser.cancelCreateFolder'),
                disabled: saving,
                label: t('files.browser.cancel'),
                onPress: onCancel,
                testID: 'files.createFolder.cancel',
              }}
              testID="files.createFolder.actions"
            />
          </View>
        </ModalContentArea>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: colors.overlay,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    maxWidth: 360,
    padding: spacing.lg,
    width: '100%',
  },
  error: {
    color: colors.errorText,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.title,
  },
});
