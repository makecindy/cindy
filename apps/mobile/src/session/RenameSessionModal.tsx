import { Modal, StyleSheet, View } from 'react-native';
import { ModalContentArea } from '@/platform/ModalContentArea';
import { useTranslation } from 'react-i18next';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

/** 任务行选项菜单里的重命名弹窗。首页与设备详情共用。 */
export function RenameSessionModal({
  draft,
  onCancel,
  onChangeDraft,
  onConfirm,
  saving,
  visible,
}: {
  draft: string;
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
    <Modal supportedOrientations={["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]} animationType="fade" transparent visible={visible}
      // 带取消按钮的对话框:点背景不关闭;保存中连 Android 返回键也不关闭。
      onRequestClose={() => {
        if (!saving) onCancel();
      }}>
      <View style={styles.backdrop} testID="home.renameSession.backdrop">
        <ModalContentArea>
        <View style={styles.card} testID="home.renameSession.modal">
          <Text style={styles.title}>{t('devices.list.renameSession.title')}</Text>
          <TextInput
            autoFocus
            editable={!saving}
            maxLength={128}
            onChangeText={onChangeDraft}
            onSubmitEditing={() => {
              if (canSave) onConfirm();
            }}
            placeholder={t('devices.list.renameSession.placeholder')}
            placeholderTextColor={colors.textPlaceholder}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.input}
            testID="home.renameSession.input"
            value={draft}
          />
          <MainWindowActionGroup
            cancelAction={{
              accessibilityLabel: t('devices.list.a11y.cancelRename'),
              disabled: saving,
              label: t('devices.common.cancel'),
              onPress: onCancel,
              testID: 'home.renameSession.cancel',
            }}
            primaryActions={[{
              accessibilityLabel: saving ? t('devices.list.renameSession.savingA11y') : t('devices.list.renameSession.saveA11y'),
              busy: saving,
              disabled: !canSave,
              label: t('devices.common.save'),
              onPress: onConfirm,
              testID: 'home.renameSession.save',
              tone: 'primary',
            }]}
            testID="home.renameSession.actions"
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
  title: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.title,
  },
  // 单行输入统一胶囊形(与登录、设置的单行输入一致)。
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
});
