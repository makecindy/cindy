import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  View,
} from "react-native";
import { LockKeyhole, ScanFace } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { NativeSwitch } from "@/platform/chrome/NativeSwitch";
import { supportsAutoUnlock } from "./autoUnlockSupport";
import {
  iconSize,
  iconStroke,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
} from "@/theme";

export interface RemoteDesktopSecuritySettingsProps {
  hostPlatform?: string;
  autoUnlock: boolean;
  biometricVerification: boolean;
  biometricAvailable?: boolean;
  busy: boolean;
  available: boolean;
  notice?: string | null;
  onAutoUnlock(value: boolean): void;
  onBiometricVerification(value: boolean): void;
  lockOnExit?: boolean;
  lockOnExitAvailable?: boolean;
  onLockOnExit?(value: boolean): void;
  privacy?: boolean;
  privacyActive?: boolean;
  privacyAvailable?: boolean;
  onPrivacy?(value: boolean): void;
  clipboardSync?: boolean;
  clipboardSyncAvailable?: boolean;
  onClipboardSync?(value: boolean): void;
  onClipboardSyncRetry?(): void;
  hostMute?: boolean;
  hostMuteAvailable?: boolean;
  onHostMute?(value: boolean): void;
  safetyNotice?: string | null;
}

/** Values are confirmed native vault state, never optimistic password-save state. */
export function RemoteDesktopSecuritySettings(
  props: RemoteDesktopSecuritySettingsProps,
) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // 说明档(13/18,二级字色);报错说明同字号改用 errorText。
  const hint = { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption };
  const alertText = { ...hint, color: colors.errorText };
  const switchSlot = {
    width: 56,
    minHeight: 44,
    alignItems: "flex-end" as const,
    justifyContent: "center" as const,
  };
  const iconSlot = {
    width: 24,
    height: 24,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  const row = {
    minHeight: 64,
    padding: spacing.md,
    gap: spacing.md,
    flexDirection: "row" as const,
    alignItems: "center" as const,
  };
  const biometricLabel = t(
    `remoteDesktop.${Platform.OS === "ios" ? "faceIdVerification" : "biometricVerification"}`,
  );
  return (
    <View style={{ gap: spacing.sm }}>
      {supportsAutoUnlock(props.hostPlatform) && (
        <>
          <View
            style={{
              backgroundColor: colors.surfaceTranslucent,
              borderColor: colors.sheetActionBorder,
              borderWidth: StyleSheet.hairlineWidth,
              borderRadius: radius.container,
              overflow: "hidden",
            }}
          >
            <View style={row}>
              <View
                testID="remoteDesktop.securityProgressSlot"
                style={iconSlot}
              >
                {props.busy ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.textSecondary}
                    accessibilityLabel={t("remoteDesktop.loadingSettings")}
                  />
                ) : (
                  <LockKeyhole
                    size={iconSize.lg}
                    strokeWidth={iconStroke.regular}
                    color={colors.textPrimary}
                  />
                )}
              </View>
              <View style={{ flex: 1, gap: spacing.xs }}>
                <Text
                  style={{
                    color: colors.textPrimary,
                    fontSize: typeScale.body,
                    lineHeight: lineHeight.body,
                  }}
                >
                  {t("remoteDesktop.autoUnlock")}
                </Text>
                <Text style={hint}>{t("remoteDesktop.autoUnlockHint")}</Text>
              </View>
              <View style={switchSlot}>
                <NativeSwitch
                  seedColor={colors.inputCaret}
                  testID="remoteDesktop.autoUnlock"
                  accessibilityLabel={t("remoteDesktop.autoUnlock")}
                  value={props.autoUnlock}
                  disabled={
                    props.busy || (!props.available && !props.autoUnlock)
                  }
                  onValueChange={props.onAutoUnlock}
                />
              </View>
            </View>
            {props.autoUnlock && (
              <>
                <View
                  style={{
                    height: StyleSheet.hairlineWidth,
                    marginHorizontal: spacing.md,
                    backgroundColor: colors.sheetActionBorder,
                  }}
                />
                <View style={row}>
                  <View style={iconSlot}>
                    <ScanFace
                      size={iconSize.lg}
                      strokeWidth={iconStroke.regular}
                      color={colors.textPrimary}
                    />
                  </View>
                  <View style={{ flex: 1, gap: spacing.xs }}>
                    <Text
                      style={{
                        color: colors.textPrimary,
                        fontSize: typeScale.body,
                        lineHeight: lineHeight.body,
                      }}
                    >
                      {biometricLabel}
                    </Text>
                    <Text style={hint}>
                      {t("remoteDesktop.biometricVerificationHint")}
                    </Text>
                  </View>
                  <View style={switchSlot}>
                    <NativeSwitch
                      seedColor={colors.inputCaret}
                      testID="remoteDesktop.biometricVerification"
                      accessibilityLabel={biometricLabel}
                      value={props.biometricVerification}
                      disabled={
                        props.busy ||
                        !props.autoUnlock ||
                        props.biometricAvailable === false
                      }
                      onValueChange={props.onBiometricVerification}
                    />
                  </View>
                </View>
              </>
            )}
          </View>
          <Text style={hint}>{t("remoteDesktop.autoUnlockStorageHint")}</Text>
        </>
      )}
      <View
        style={{
          ...row,
          backgroundColor: colors.surfaceTranslucent,
          borderColor: colors.sheetActionBorder,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: radius.container,
        }}
      >
        <View style={iconSlot}>
          <LockKeyhole
            size={iconSize.lg}
            strokeWidth={iconStroke.regular}
            color={colors.textPrimary}
          />
        </View>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}>
            {t("remoteDesktop.lockOnExit")}
          </Text>
          <Text style={hint}>
            {t(
              props.lockOnExitAvailable
                ? "remoteDesktop.lockOnExitHint"
                : "remoteDesktop.settingUnsupported",
            )}
          </Text>
        </View>
        <View style={switchSlot}>
          <NativeSwitch
            seedColor={colors.inputCaret}
            testID="remoteDesktop.lockOnExit"
            accessibilityLabel={t("remoteDesktop.lockOnExit")}
            value={props.lockOnExit === true}
            disabled={!props.lockOnExitAvailable && !props.lockOnExit}
            onValueChange={(value) => props.onLockOnExit?.(value)}
          />
        </View>
      </View>
      {supportsAutoUnlock(props.hostPlatform) &&
        (props.notice || (!props.available && !props.busy)) && (
          <Text style={alertText} accessibilityRole="alert">
            {props.notice || t("remoteDesktop.autoUnlockUnavailable")}
          </Text>
        )}
      {(
        [
          {
            key: "privacyScreen",
            value: props.privacy,
            available: props.privacyAvailable,
            change: props.onPrivacy,
            hint: props.privacyActive ? "privacyActive" : "privacyScreenHint",
          },
          {
            key: "clipboardSync",
            value: props.clipboardSync,
            available: props.clipboardSyncAvailable,
            change: props.onClipboardSync,
            hint: "clipboardSyncHint",
          },
          {
            key: "hostMute",
            value: props.hostMute,
            available: props.hostMuteAvailable,
            change: props.onHostMute,
            hint: "hostMuteHint",
          },
        ] as const
      ).map((item) => (
        <View
          key={item.key}
          style={{
            ...row,
            backgroundColor: colors.sheetActionSurface,
            borderColor: colors.sheetActionBorder,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: radius.container,
          }}
        >
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text
              style={{ color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body }}
            >
              {t(`remoteDesktop.${item.key}`)}
            </Text>
            <Text style={hint}>
              {t(
                `remoteDesktop.${item.available ? item.hint : "settingUnsupported"}`,
              )}
            </Text>
          </View>
          <View style={switchSlot}>
            <NativeSwitch
              seedColor={colors.inputCaret}
              accessibilityLabel={t(`remoteDesktop.${item.key}`)}
              testID={`remoteDesktop.${item.key}`}
              value={item.value === true}
              disabled={!item.available && !item.value}
              onValueChange={(value) => item.change?.(value)}
            />
          </View>
        </View>
      ))}
      {props.safetyNotice && (
        <Text style={alertText} accessibilityRole="alert">
          {t(`remoteDesktop.${props.safetyNotice}`)}
        </Text>
      )}
      {props.clipboardSync &&
        props.safetyNotice?.startsWith("clipboardSync") && (
          <MainWindowActionButton
            action={{
              label: t("remoteDesktop.clipboardSyncRetry"),
              onPress: props.onClipboardSyncRetry,
            }}
          />
        )}
    </View>
  );
}
