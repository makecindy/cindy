import { Modal, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import { MAX_DEVICE_NAME_LENGTH } from '@/device-link/deviceName';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
} from '@/theme/tokens';

export function RenameDeviceModal({
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
  const canSave = draft.trim().length > 0 && !saving;
  return (
    <Modal
      animationType="fade"
      transparent
      visible={visible}
      onRequestClose={onCancel}
    >
      <Pressable
        style={styles.renameDeviceBackdrop}
        onPress={onCancel}
        testID="home.renameDevice.backdrop"
      >
        <Pressable
          style={styles.renameDeviceCard}
          onPress={() => undefined}
          testID="home.renameDevice.modal"
        >
          <Text style={styles.renameDeviceTitle}>
            {t('devices.list.renameDevice.title')}
          </Text>
          <TextInput
            autoFocus
            editable={!saving}
            maxLength={MAX_DEVICE_NAME_LENGTH}
            onChangeText={onChangeDraft}
            onSubmitEditing={() => {
              if (canSave) onConfirm();
            }}
            placeholder={t('devices.list.renameDevice.placeholder')}
            placeholderTextColor={colors.textTertiary}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.renameDeviceInput}
            testID="home.renameDevice.input"
            value={draft}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {/* 确认对统一规则:共享满宽纵排组(保存在上/取消居底),置于卡片底部。 */}
          <MainWindowActionGroup
            primaryActions={[
              {
                accessibilityLabel: saving
                  ? t('devices.list.renameDevice.savingA11y')
                  : t('devices.list.renameDevice.saveA11y'),
                busy: saving,
                disabled: !canSave,
                label: saving
                  ? t('devices.common.saving')
                  : t('devices.common.save'),
                onPress: onConfirm,
                testID: 'home.renameDevice.save',
                tone: 'primary',
              },
            ]}
            cancelAction={{
              accessibilityLabel: t('devices.list.a11y.cancelRename'),
              disabled: saving,
              label: t('devices.common.cancel'),
              onPress: onCancel,
              testID: 'home.renameDevice.cancel',
            }}
            testID="home.renameDevice.actions"
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    error: { color: colors.destructive, fontSize: typeScale.body },
    renameDeviceBackdrop: {
      alignItems: 'center',
      backgroundColor: colors.overlay,
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    renameDeviceCard: {
      backgroundColor: colors.surfaceElevated,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      gap: spacing.md,
      maxWidth: 360,
      padding: spacing.lg,
      width: '100%',
    },
    renameDeviceTitle: {
      color: colors.textPrimary,
      fontSize: typeScale.title,
      fontWeight: fontWeight.medium,
      lineHeight: lineHeight.subtitle,
    },
    renameDeviceInput: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: radius.container,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.textPrimary,
      fontSize: typeScale.body,
      minHeight: 48,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
  });
