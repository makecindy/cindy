import { Modal, StyleSheet, View } from 'react-native';
import { ModalContentArea } from '@/platform/ModalContentArea';
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
      supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}
      animationType="fade"
      transparent
      visible={visible}
      // 带取消按钮的对话框:点背景不关闭;保存中连 Android 返回键也不关闭。
      onRequestClose={() => {
        if (!saving) onCancel();
      }}
    >
      <View
        style={styles.renameDeviceBackdrop}
        testID="home.renameDevice.backdrop"
      >
        <ModalContentArea>
        <View
          style={styles.renameDeviceCard}
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
            placeholderTextColor={colors.textPlaceholder}
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
                label: t('devices.common.save'),
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
        </View>
        </ModalContentArea>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // 报错说明:13/18 errorText(黑白系),红色只留给状态点与破坏性按钮。
    error: { color: colors.errorText, fontSize: typeScale.footnote, fontWeight: fontWeight.regular, lineHeight: lineHeight.caption },
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
      fontWeight: fontWeight.semibold,
      lineHeight: lineHeight.title,
    },
    // 单行输入统一胶囊形(与登录、设置的单行输入一致)。
    renameDeviceInput: {
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
  });
