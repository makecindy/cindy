import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useIsFocused } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import { pinMobilePluginIdentity } from "./pluginOauthPins";
import { accountVaultKey } from "@cindy/auth-client";
import {
  PLUGIN_OAUTH_CHANNEL,
  parsePluginOauthPeerIdentity,
} from "@cindy/device-link";
import { useTranslation } from "react-i18next";
import { Text, TextInput } from "@/components/AppText";
import { useAuth } from "@/auth/AuthContext";
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { SheetModal } from "@/session/SheetModal";
import {
  fontWeight,
  lineHeight,
  radius,
  spacing,
  typeScale,
  useTheme,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import { type MobilePluginSetupAction } from "./pluginSetupActions";
import { authenticateMobilePluginOauth } from "./pluginOauthClient";
import { pluginOauthPlatformCrypto } from "./pluginOauthPlatformCrypto";
import { runMobilePluginAuthorization } from "./pluginAuthorizationController";

export default function PluginSetupNativeForm({
  initialAction,
  requestRevision,
  requestIdentity,
  deviceId,
  disabled,
  onClosed,
}: {
  initialAction: MobilePluginSetupAction;
  requestRevision: unknown;
  requestIdentity: string;
  deviceId: string;
  disabled: boolean;
  onClosed(): void;
}) {
  const { t } = useTranslation(),
    { colors } = useTheme(),
    styles = useThemedStyles(makeStyles);
  const auth = useAuth(),
    link = useDeviceLink(),
    focused = useIsFocused();
  const initialIdentity = useRef(requestIdentity).current;
  const owner = useRef(getMobileAuthOwner()).current,
    alive = useRef(true),
    lock = useRef(false),
    operation = useRef(0),
    copiedCode = useRef<string | undefined>(undefined);
  const live = useRef({ focused, epoch: link.connectionEpoch });
  live.current = { focused, epoch: link.connectionEpoch };
  const [selected, setSelected] = useState<MobilePluginSetupAction | undefined>(
      initialAction,
    ),
    [secret, setSecret] = useState(""),
    [host, setHost] = useState("");
  const [busy, setBusy] = useState(false),
    [browser, setBrowser] = useState<{ url: string; code?: string }>();
  useEffect(
    () => () => {
      alive.current = false;
      operation.current++;
      void clearCopiedCode();
    },
    [],
  );
  const clearCopiedCode = async () => {
    const code = copiedCode.current;
    copiedCode.current = undefined;
    if (code && (await Clipboard.getStringAsync().catch(() => "")) === code)
      await Clipboard.setStringAsync("").catch(() => {});
  };
  const clear = () => {
    setSecret("");
    setHost("");
  };
  const close = () => {
    operation.current++;
    clear();
    setSelected(undefined);
    setBrowser(undefined);
    void clearCopiedCode();
    onClosed();
  };
  useEffect(() => {
    if (
      requestIdentity !== initialIdentity ||
      (!lock.current &&
        requestRevision !== initialAction.action.expectedRevision)
    )
      close();
  }, [requestIdentity, requestRevision]);
  const submit = async (action: MobilePluginSetupAction) => {
    if (
      lock.current ||
      disabled ||
      !auth.deviceId ||
      !live.current.focused ||
      AppState.currentState !== "active"
    )
      return;
    lock.current = true;
    setBusy(true);
    const generation = ++operation.current,
      epoch = link.connectionEpoch;
    const assertCurrent = () => {
      if (
        !alive.current ||
        generation !== operation.current ||
        !isMobileAuthOwnerCurrent(owner) ||
        !live.current.focused ||
        live.current.epoch !== epoch
      )
        throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
    };
    const invoke = (raw: unknown, cleanup = false) =>
      link.invoke(deviceId, PLUGIN_OAUTH_CHANNEL, [raw], {
        preSend: () => {
          if (cleanup) {
            if (
              !isMobileAuthOwnerCurrent(owner) ||
              live.current.epoch !== epoch
            )
              throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
          } else assertCurrent();
          if (!cleanup && AppState.currentState !== "active")
            throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
        },
      });
    let client:
      Awaited<ReturnType<typeof authenticateMobilePluginOauth>> | undefined;
    try {
      const target = parsePluginOauthPeerIdentity(
        await invoke({ op: "identity", version: 3 }),
      );
      assertCurrent();
      if (
        target.deviceId !== deviceId ||
        target.membershipId !== owner.accountId ||
        accountVaultKey(target.realm, target.membershipId) !== owner.accountKey
      )
        throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
      client = await authenticateMobilePluginOauth({
        crypto: pluginOauthPlatformCrypto,
        target,
        peer: auth.deviceId,
        ghostId: action.ghostId,
        action: action.action,
        assertCurrent,
        invoke,
        trustIdentity: (identity, check) =>
          pinMobilePluginIdentity(
            {
              get: (key) => SecureStore.getItemAsync(key),
              set: (key, value) =>
                SecureStore.setItemAsync(key, value, {
                  keychainAccessible:
                    SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
                }),
            },
            identity,
            auth.deviceId!,
            check,
          ),
      });
      await runMobilePluginAuthorization({
        crypto: pluginOauthPlatformCrypto,
        action: action.action,
        kind: action.kind,
        invoke: client.request,
        assertCurrent,
        secretPresentation: action.secret,
        connectionPresentation: action.connection,
        ...(action.kind === "secret" ? { inputSecret: secret } : {}),
        ...(action.kind === "connection"
          ? { inputConnection: { host, token: secret } }
          : {}),
        clearInput: clear,
        pause: async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          while (AppState.currentState !== "active") {
            assertCurrent();
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
        },
        showAuthorization: async (url, code, expiresAt) => {
          assertCurrent();
          if (Date.now() >= expiresAt)
            throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
          setBrowser({ url, code });
          // In-app system browser; it is never a plugin WebView. A device code is only copied on explicit touch.
          const accepted = await new Promise<boolean>((resolve) =>
            Alert.alert(
              t("plugins.connectAccount"),
              new URL(url).hostname + (code ? "\n" + code : ""),
              [
                {
                  text: t("plugins.cancel"),
                  style: "cancel",
                  onPress: () => resolve(false),
                },
                { text: t("plugins.open"), onPress: () => resolve(true) },
              ],
              { cancelable: false },
            ),
          );
          assertCurrent();
          if (!accepted) throw new Error("OAUTH_BRIDGE_UNAVAILABLE");
          await WebBrowser.openBrowserAsync(url, { showTitle: true });
          assertCurrent();
        },
      });
      assertCurrent();
      setSelected(undefined);
      setBrowser(undefined);
      onClosed();
    } catch (e) {
      clear();
      if (
        alive.current &&
        isMobileAuthOwnerCurrent(owner) &&
        generation === operation.current
      ) {
        const identityChanged =
          e instanceof Error &&
          e.message === "PLUGIN_AUTHORIZATION_IDENTITY_CHANGED";
        const computerCallback =
          e instanceof Error &&
          e.message === "PLUGIN_AUTHORIZATION_COMPUTER_CALLBACK";
        Alert.alert(
          identityChanged
            ? t("plugins.identityChanged")
            : computerCallback
              ? t("plugins.computerAuthorization")
              : t("plugins.actionFailed"),
          identityChanged
            ? t("plugins.identityChangedHint")
            : computerCallback
              ? t("plugins.computerAuthorizationHint")
              : t("plugins.authorizationCheckHint"),
        );
      }
    } finally {
      client?.dispose();
      void clearCopiedCode();
      lock.current = false;
      if (alive.current) {
        setBusy(false);
        setBrowser(undefined);
      }
    }
  };
  useEffect(() => {
    if (initialAction.kind === "oauth") void submit(initialAction);
  }, []);
  return (
    <View>
      <SheetModal
        visible={!!selected}
        onRequestClose={close}
        onBackdropPress={() => {}}
        keyboardAvoiding
      >
        <View style={styles.sheet}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
          >
            <Text style={styles.title}>
              {selected?.secret?.ghostName ??
                selected?.connection?.ghostName ??
                t("plugins.connectAccount")}
            </Text>
            <Text style={styles.body}>{selected?.title}</Text>
            {selected?.secret?.intro || selected?.connection?.intro ? (
              <Text style={styles.hint}>
                {selected.secret?.intro ?? selected.connection?.intro}
              </Text>
            ) : null}
            {selected?.kind === "secret" ? (
              <>
                <Text style={styles.hint}>{selected.secret?.description}</Text>
                <Text style={styles.body}>{selected.secret?.fieldLabel}</Text>
                <TextInput
                  accessibilityLabel={selected.secret?.fieldLabel}
                  value={secret}
                  onChangeText={setSecret}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="none"
                  autoComplete="off"
                  editable={!busy}
                  maxLength={selected.secret?.maxLength}
                  style={styles.input}
                />
                <Text style={styles.hint}>
                  {selected.secret?.fieldDescription}
                </Text>
              </>
            ) : null}
            {selected?.kind === "connection" ? (
              <>
                <Text style={styles.hint}>
                  {selected.connection?.description}
                </Text>
                <TextInput
                  accessibilityLabel={t("plugins.connectionHost")}
                  placeholder={t("plugins.connectionHost")}
                  placeholderTextColor={colors.textPlaceholder}
                  value={host}
                  onChangeText={setHost}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  maxLength={512}
                  style={styles.input}
                />
                <TextInput
                  accessibilityLabel={t("plugins.connectionToken")}
                  placeholder={t("plugins.connectionToken")}
                  placeholderTextColor={colors.textPlaceholder}
                  value={secret}
                  onChangeText={setSecret}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="none"
                  autoComplete="off"
                  editable={!busy}
                  maxLength={4096}
                  style={styles.input}
                />
              </>
            ) : null}
            {browser ? (
              <>
                <Text style={styles.hint}>{new URL(browser.url).hostname}</Text>
                {browser.code ? (
                  <Pressable
                    style={styles.row}
                    accessibilityRole="button"
                    onPress={() => {
                      const code = browser.code!;
                      void Clipboard.setStringAsync(code)
                        .then(() => {
                          copiedCode.current = code;
                          if (!alive.current) void clearCopiedCode();
                        })
                        .catch(() => {});
                    }}
                  >
                    <Text style={styles.body}>
                      {browser.code} · {t("plugins.copyCode")}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}
            {busy ? (
              <View style={styles.row}>
                <ActivityIndicator color={colors.textSecondary} />
                <Text style={styles.hint}>
                  {t("plugins.waitingAuthorization")}
                </Text>
              </View>
            ) : null}
            <View style={styles.buttons}>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={close}
              >
                <Text style={styles.body}>{t("plugins.cancel")}</Text>
              </Pressable>
              {selected?.kind !== "oauth" ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={
                    busy ||
                    !secret.trim() ||
                    (selected?.kind === "connection" && !host.trim())
                  }
                  style={[styles.button, styles.primary]}
                  onPress={() => {
                    if (selected) void submit(selected);
                  }}
                >
                  <Text style={styles.ctaText}>
                    {t("plugins.saveConfiguration")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </ScrollView>
        </View>
      </SheetModal>
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
    },
    sheet: {
      backgroundColor: colors.surfaceElevated,
      borderTopLeftRadius: radius.container,
      borderTopRightRadius: radius.container,
      maxHeight: "90%",
    },
    content: { padding: spacing.lg, gap: spacing.md },
    title: {
      fontSize: typeScale.title,
      lineHeight: lineHeight.title,
      fontWeight: fontWeight.semibold,
      color: colors.textPrimary,
    },
    body: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
    hint: {
      fontSize: typeScale.footnote,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textTertiary,
    },
    input: {
      fontSize: typeScale.bodySmall,
      lineHeight: lineHeight.bodySmall,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.control,
      paddingHorizontal: spacing.md,
      minHeight: 44,
    },
    buttons: { flexDirection: "row", gap: spacing.sm },
    button: {
      minHeight: 44,
      paddingHorizontal: spacing.md,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.control,
    },
    primary: { backgroundColor: colors.cta },
    ctaText: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.medium,
      color: colors.ctaText,
    },
  });
