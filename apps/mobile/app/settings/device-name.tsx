import Constants from 'expo-constants';
import { useNavigation, useRouter } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionGroup } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { buildMobileDeviceName } from '@/device-link/mobileDeviceIdentity';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import {
  publishSavedSelfDeviceName,
  selfDeviceNameKey,
  SETTINGS_DEVICE_TIMEOUT_MS,
  useSettingsDeviceDirectory,
} from '@/session/settingsDeviceDirectory';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';

const MAX_SELF_DEVICE_NAME_LENGTH = 64;
type PendingWrite = 'rename' | 'reset' | null;
type EditorMessage = { kind: 'info' | 'error'; text: string } | null;

/**
 * 本机名称编辑页(设置的二级页,独立 stack 路由)。
 *
 * - 明确的「保存」:只有名称有改动且不为空时可点;保存成功后返回设置。
 * - 返回即放弃:有未保存改动时,点返回、iOS 边缘右滑、Android 返回键都先确认放弃,
 *   不再在离开时静默保存。
 * - 「恢复默认名称」把服务端的手动名称清掉(name: null),由服务端给回默认名。
 */
export default function RenameSelfDeviceScreen() {
  const auth = useAuth();
  const router = useRouter();
  const navigation = useNavigation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { selfDeviceName } = useSettingsDeviceDirectory();
  const systemDeviceName = buildMobileDeviceName({
    constantsDeviceName: Constants.deviceName,
    platform: Platform.OS,
  });
  const currentName = (selfDeviceName ?? systemDeviceName).trim();
  const [draft, setDraft] = useState(currentName);
  const [pending, setPending] = useState<PendingWrite>(null);
  const [message, setMessage] = useState<EditorMessage>(null);
  const [leaveAfterSave, setLeaveAfterSave] = useState(false);
  const touchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // 服务端名称晚于页面到达时,用户还没动过输入框就跟上最新值。
  useEffect(() => {
    if (!touchedRef.current) setDraft(currentName);
  }, [currentName]);

  const trimmedDraft = draft.trim();
  const dirty = trimmedDraft !== currentName;
  const saving = pending !== null;
  const canSave = dirty && trimmedDraft.length > 0 && !saving;

  const changeDraft = useCallback((value: string) => {
    touchedRef.current = true;
    setMessage(null);
    setDraft(value);
  }, []);

  const writeName = useCallback(async (kind: 'rename' | 'reset') => {
    const deviceId = auth.deviceId;
    const accountGeneration = auth.accountGeneration;
    if (!deviceId) {
      setMessage({ kind: 'error', text: t('settings.deviceNameEditor.deviceInitializing') });
      return;
    }
    setPending(kind);
    setMessage(null);
    try {
      const res = await auth.apiFetch<{ deviceId: string; name: string }>(
        `/api/device-link/devices/${encodeURIComponent(deviceId)}`,
        {
          baseUrl: DEVICE_LINK_API_BASE_URL,
          body: kind === 'reset' ? { name: null } : { name: trimmedDraft },
          method: 'PATCH',
          timeoutMs: SETTINGS_DEVICE_TIMEOUT_MS,
        },
      );
      publishSavedSelfDeviceName(selfDeviceNameKey(accountGeneration, deviceId), res.name);
      if (!mountedRef.current) return;
      touchedRef.current = false;
      setDraft(res.name);
      if (kind === 'rename') setLeaveAfterSave(true);
      else setMessage({ kind: 'info', text: t('settings.deviceNameEditor.restoredDefault') });
    } catch (err) {
      if (mountedRef.current) setMessage({ kind: 'error', text: formatRemoteError(err) });
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }, [auth, t, trimmedDraft]);

  const save = useCallback(() => {
    if (!canSave) {
      if (trimmedDraft.length === 0) setMessage({ kind: 'error', text: t('settings.deviceNameEditor.emptyError') });
      return;
    }
    void writeName('rename');
  }, [canSave, t, trimmedDraft.length, writeName]);

  const back = useCallback(() => goBackGuarded(router, '/settings'), [router]);

  // 保存成功后:草稿已与新名称一致(不再 dirty),此时返回不会触发放弃确认。
  useEffect(() => {
    if (leaveAfterSave && !dirty) {
      setLeaveAfterSave(false);
      back();
    }
  }, [back, dirty, leaveAfterSave]);

  // 有未保存改动时拦截所有离开方式(顶栏返回、iOS 边缘右滑、Android 返回键)。
  // 写入进行中也不能离开:已发出的请求无法可靠撤回,此时「放弃」并不能真的放弃。
  usePreventRemove(saving || (dirty && !leaveAfterSave), ({ data }) => {
    if (saving) return;
    Alert.alert(
      t('settings.deviceNameEditor.discardTitle'),
      t('settings.deviceNameEditor.discardBody'),
      [
        { text: t('settings.deviceNameEditor.keepEditing'), style: 'cancel' },
        {
          text: t('settings.deviceNameEditor.discardConfirm'),
          style: 'destructive',
          onPress: () => navigation.dispatch(data.action),
        },
      ],
    );
  });

  return (
    <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.renameSelfDevice.screen">
      <SimpleStackHeader
        backTestID="settings.renameSelfDevice.backButton"
        onBack={back}
        title={t('settings.deviceNameEditor.screenTitle')}
      />
      <View style={styles.content}>
        <View style={styles.inputRow}>
          <TextInput
            autoFocus
            editable={!saving}
            maxLength={MAX_SELF_DEVICE_NAME_LENGTH}
            onChangeText={changeDraft}
            onSubmitEditing={save}
            placeholder={t('settings.deviceNameEditor.placeholder')}
            placeholderTextColor={colors.textPlaceholder}
            returnKeyType="done"
            selectTextOnFocus
            style={styles.input}
            testID="settings.renameSelfDevice.input"
            value={draft}
          />
          {draft.length > 0 && !saving ? (
            <Pressable
              accessibilityLabel={t('settings.deviceNameEditor.clearAccessibility')}
              accessibilityRole="button"
              hitSlop={spacing.md}
              onPress={() => changeDraft('')}
              style={({ pressed }) => [styles.clearButton, pressed && mobileInteractionStyles.pressed]}
              testID="settings.renameSelfDevice.clear"
            >
              <X color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.bold} />
            </Pressable>
          ) : null}
        </View>
        {message ? (
          <Text
            accessibilityRole={message.kind === 'error' ? 'alert' : undefined}
            style={[styles.message, message.kind === 'error' && styles.errorMessage]}
            testID="settings.renameSelfDevice.message"
          >
            {message.text}
          </Text>
        ) : (
          <Text style={styles.message}>{t('settings.about.deviceNameDetail')}</Text>
        )}
        <MainWindowActionGroup
          primaryActions={[{
            accessibilityLabel: t('devices.common.save'),
            busy: pending === 'rename',
            disabled: !canSave,
            label: t('devices.common.save'),
            onPress: save,
            testID: 'settings.renameSelfDevice.save',
            tone: 'primary',
          }]}
          secondaryActions={[{
            accessibilityLabel: t('settings.deviceNameEditor.resetAccessibility'),
            busy: pending === 'reset',
            disabled: saving,
            label: t('settings.deviceNameEditor.resetAction'),
            onPress: () => void writeName('reset'),
            testID: 'settings.renameSelfDevice.reset',
          }]}
          testID="settings.renameSelfDevice.actions"
        />
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  content: {
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  inputRow: {
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 52,
    paddingLeft: spacing.lg,
    paddingRight: spacing.md,
  },
  // 单行输入框不设行高:iOS 上会让占位字与光标偏位。
  input: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: typeScale.body,
    minWidth: 0,
    paddingVertical: spacing.md,
  },
  clearButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: iconSize.xl,
    justifyContent: 'center',
    width: iconSize.xl,
  },
  message: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.caption,
    paddingHorizontal: spacing.md,
  },
  errorMessage: { color: colors.errorText },
});
