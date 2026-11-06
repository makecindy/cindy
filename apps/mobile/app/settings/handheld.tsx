import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react-native';

import { Text } from '@/components/AppText';
import { NativeSwitch, SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import { pickSecondaryDisplay } from '@/handheld/HandheldModeBridge';
import {
  HANDHELD_VOICE_KEY_OPTIONS,
  handheldKeyLabel,
  isHandheldModeSupported,
  resetHandheldSettings,
  updateHandheldSettings,
  useHandheldSettings,
  type HandheldModeSettings,
} from '@/handheld/handheldMode';
import { ActionInfoRow, InfoRow, SettingsGroup, useSettingsRowStyles } from '@/session/SettingsGroupRows';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, spacing } from '@/theme/tokens';
import { goBackGuarded } from '@/utils/backGuard';
import { cindyHandheld } from '../../modules/cindy-handheld/src';

const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * 掌机模式设置页(仅 Android 新原生包)。开关、语音键与副屏都即时生效;
 * 整页可以只用手柄完成:每一行都是可聚焦的按钮,A 确认,B 返回。
 */
export default function HandheldSettingsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { hydrated, settings } = useHandheldSettings();
  const supported = isHandheldModeSupported();
  const [capturing, setCapturing] = useState(false);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const secondaryDisplay = useMemo(
    () => (supported ? pickSecondaryDisplay(cindyHandheld!.getDisplays()) : null),
    [supported],
  );
  const gamepads = useMemo(() => (supported ? cindyHandheld!.getGamepads() : []), [supported]);

  const save = useCallback((patch: Partial<HandheldModeSettings>) => {
    void updateHandheldSettings(patch).catch(() => {
      Alert.alert(t('settings.handheld.saveFailed'));
    });
  }, [t]);

  const stopCapture = useCallback(() => {
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = null;
    setCapturing(false);
    if (supported) void cindyHandheld!.setCapturing(false).catch(() => undefined);
  }, [supported]);

  useEffect(() => {
    if (!supported) return undefined;
    const subscription = cindyHandheld!.addListener('onKeyCaptured', (event) => {
      stopCapture();
      save({ voiceKeyCode: event.keyCode, voiceKeyName: handheldKeyLabel(event.keyCode, event.name) });
    });
    return () => {
      subscription.remove();
      stopCapture();
    };
  }, [save, stopCapture, supported]);

  const startCapture = useCallback(() => {
    if (!supported || capturing) return;
    setCapturing(true);
    void cindyHandheld!.setCapturing(true).catch(() => setCapturing(false));
    captureTimerRef.current = setTimeout(stopCapture, CAPTURE_TIMEOUT_MS);
  }, [capturing, stopCapture, supported]);

  const voiceKeyLabel = settings.voiceKeyName ?? handheldKeyLabel(settings.voiceKeyCode);
  const customKey = !HANDHELD_VOICE_KEY_OPTIONS.includes(settings.voiceKeyCode);

  return (
    <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="settings.handheld.screen">
      <SimpleStackHeader
        scrollEdge
        backTestID="settings.handheld.backButton"
        onBack={() => goBackGuarded(router, '/settings')}
        title={t('settings.handheld.title')}
      />
      <ScrollView {...simpleScrollInsetProps} contentContainerStyle={styles.content} testID="settings.handheld.scroll">
        <SettingsGroup footer={t('settings.handheld.hint')}>
          <ToggleRow
            disabled={!supported || !hydrated}
            label={t('settings.handheld.label')}
            onValueChange={(enabled) => save({ enabled })}
            testID="settings.handheld.toggle"
            value={settings.enabled}
          />
        </SettingsGroup>

        {settings.enabled ? (
          <SettingsGroup footer={t('settings.handheld.voiceKey.hint')} title={t('settings.handheld.voiceKey.title')}>
            {[
              <ActionInfoRow
                accessibilityLabel={t('settings.handheld.voiceKey.capture')}
                chevron={false}
                key="capture"
                label={capturing ? t('settings.handheld.voiceKey.capturing') : t('settings.handheld.voiceKey.capture')}
                onPress={capturing ? stopCapture : startCapture}
                testID="settings.handheld.voiceKey.capture"
                value={capturing ? '' : voiceKeyLabel}
              />,
              ...(customKey ? [
                <KeyOptionRow key={`custom-${settings.voiceKeyCode}`} label={voiceKeyLabel} onPress={() => undefined} selected />,
              ] : []),
              ...HANDHELD_VOICE_KEY_OPTIONS.map((keyCode) => (
                <KeyOptionRow
                  key={keyCode}
                  label={handheldKeyLabel(keyCode)}
                  onPress={() => save({ voiceKeyCode: keyCode })}
                  selected={settings.voiceKeyCode === keyCode}
                />
              )),
            ]}
          </SettingsGroup>
        ) : null}

        {settings.enabled ? (
          <SettingsGroup
            footer={secondaryDisplay ? t('settings.handheld.display.hint') : t('settings.handheld.display.none')}
            title={t('settings.handheld.display.title')}
          >
            {secondaryDisplay ? (
              <ToggleRow
                label={t('settings.handheld.display.secondary')}
                onValueChange={(useSecondaryDisplay) => save({ useSecondaryDisplay })}
                testID="settings.handheld.display.toggle"
                value={settings.useSecondaryDisplay}
              />
            ) : (
              <InfoRow label={t('settings.handheld.display.current')} value={t('settings.handheld.display.single')} />
            )}
          </SettingsGroup>
        ) : null}

        <SettingsGroup title={t('settings.handheld.controls.title')}>
          {[
            <InfoRow key="gamepad" label={t('settings.handheld.controls.gamepad')} value={gamepads[0] ?? t('settings.handheld.controls.noGamepad')} />,
            <InfoRow key="move" label={t('settings.handheld.controls.moveKeys')} value={t('settings.handheld.controls.move')} />,
            <InfoRow key="confirm" label="A" value={t('settings.handheld.controls.confirm')} />,
            <InfoRow key="back" label="B" value={t('settings.handheld.controls.back')} />,
            <InfoRow key="voice" label={voiceKeyLabel} value={t('settings.handheld.controls.voice')} />,
            <InfoRow key="scroll" label={t('settings.handheld.controls.scrollKeys')} value={t('settings.handheld.controls.scroll')} />,
            <InfoRow key="page" label="L1 / R1" value={t('settings.handheld.controls.page')} />,
          ]}
        </SettingsGroup>
        <SettingsGroup>
          <ActionInfoRow
            accessibilityLabel={t('settings.handheld.reset')}
            chevron={false}
            disabled={!supported || !hydrated}
            label={t('settings.handheld.reset')}
            onPress={() => {
              stopCapture();
              void resetHandheldSettings().catch(() => Alert.alert(t('settings.handheld.saveFailed')));
            }}
            testID="settings.handheld.reset"
          />
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

/** 整行可聚焦、可点的开关:手柄焦点落在行上,A 一次就切换。 */
function ToggleRow({
  disabled,
  label,
  onValueChange,
  testID,
  value,
}: {
  disabled?: boolean;
  label: string;
  onValueChange(value: boolean): void;
  testID: string;
  value: boolean;
}) {
  const rowStyles = useSettingsRowStyles();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => [rowStyles.switchRow, (pressed || disabled) && rowStyles.pressed]}
      testID={`${testID}Row`}
    >
      <Text style={rowStyles.rowLabel}>{label}</Text>
      <View focusable={false} pointerEvents="none">
        <NativeSwitch disabled={disabled} onValueChange={onValueChange} testID={testID} value={value} />
      </View>
    </Pressable>
  );
}

function KeyOptionRow({ label, onPress, selected }: { label: string; onPress(): void; selected: boolean }) {
  const rowStyles = useSettingsRowStyles();
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={({ pressed }) => [rowStyles.row, pressed && rowStyles.pressed]}
      testID={`settings.handheld.voiceKey.${label}`}
    >
      <View style={rowStyles.rowLine}>
        <Text style={rowStyles.rowLabel}>{label}</Text>
        {selected ? <Check color={colors.textPrimary} size={iconSize.md} strokeWidth={iconStroke.regular} /> : null}
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  // 与设置主页同一组间距:footer 与下一组标题之间留出分组间隔。
  content: { gap: spacing.xl, paddingBottom: spacing.xxl, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
});
