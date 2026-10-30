import { useEffect, useState, type ComponentType } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/components/AppText";
import { useTranslation } from "react-i18next";
import {
  fontWeight,
  lineHeight,
  spacing,
  typeScale,
  useThemedStyles,
  type ThemeColors,
} from "@/theme";
import {
  mobilePluginSetupActions,
  type MobilePluginSetupAction,
} from "./pluginSetupActions";
type FormProps = {
  initialAction: MobilePluginSetupAction;
  requestRevision: unknown;
  requestIdentity: string;
  deviceId: string;
  disabled: boolean;
  onClosed(): void;
};
/** Loading a card never initializes native authorization or starts a connection. */
export function PluginSetupNativeActions({
  request,
  deviceId,
  disabled,
}: {
  request: unknown;
  deviceId: string;
  disabled: boolean;
}) {
  const { t } = useTranslation(),
    styles = useThemedStyles(makeStyles);
  const [pending, setPending] = useState<{
    action: MobilePluginSetupAction;
    identity: string;
  }>();
  const [Form, setForm] = useState<ComponentType<FormProps>>();
  const raw =
    request && typeof request === "object"
      ? (request as Record<string, unknown>)
      : {};
  const ghost =
    raw.ghost && typeof raw.ghost === "object"
      ? (raw.ghost as Record<string, unknown>)
      : {};
  const requestIdentity = JSON.stringify([deviceId, raw.requestId, ghost.id]);
  useEffect(() => {
    if (pending && pending.identity !== requestIdentity) setPending(undefined);
  }, [requestIdentity, pending]);
  const actions = mobilePluginSetupActions(request);
  return (
    <View>
      {actions.map((action) => (
        <Pressable
          key={action.action.actionId}
          accessibilityRole="button"
          disabled={disabled || !!pending}
          style={styles.row}
          onPress={() => {
            setPending({ action, identity: requestIdentity });
            void import("./PluginSetupNativeForm")
              .then((module) => setForm(() => module.default))
              .catch(() => {
                setPending(undefined);
                Alert.alert(t("plugins.actionFailed"));
              });
          }}
        >
          <Text style={styles.body}>{action.title}</Text>
        </Pressable>
      ))}
      {pending && pending.identity === requestIdentity && Form ? (
        <Form
          initialAction={pending.action}
          requestRevision={raw.revision}
          requestIdentity={requestIdentity}
          deviceId={deviceId}
          disabled={disabled}
          onClosed={() => setPending(undefined)}
        />
      ) : null}
    </View>
  );
}
const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    row: { minHeight: 44, paddingVertical: spacing.sm },
    body: {
      fontSize: typeScale.body,
      lineHeight: lineHeight.body,
      fontWeight: fontWeight.regular,
      color: colors.textPrimary,
    },
  });
