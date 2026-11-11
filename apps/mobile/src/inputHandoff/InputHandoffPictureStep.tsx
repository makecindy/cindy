/**
 * 代输入 step answered on a screenshot of the target window. The picture
 * arrives only inside the sealed per-step offer and lives in this component's
 * state for one revision; the owner's tap (as a fraction of the picture) or
 * typing goes back on the same exchange.
 */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import {
  INPUT_HANDOFF_PICTURE_TEXT_ID,
  type InputHandoffAction,
  type InputHandoffControl,
  type InputHandoffPicture,
  type InputHandoffSnapshot,
  type InputHandoffSubmission,
} from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
import { MainWindowActionGroup } from "@/components/MobilePrimitives";
import { useTheme, useThemedStyles } from "@/theme";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import { nativeTextInputProps } from "./inputHandoffNative";

/** Requests whose picture the owner opened on this phone; later steps open by themselves. Ids only. */
const openedHere = new Set<string>();

/** The owner asked for the picture on this phone: show it without another tap. */
export function rememberInputHandoffPictureOpened(requestId: string): void {
  if (openedHere.size > 64) openedHere.clear();
  openedHere.add(requestId);
}

type Decision = "done" | "cancel" | "refresh";

export function InputHandoffPictureStep({
  snapshot,
  busy,
  openPicture,
  onDecide,
  onError,
}: {
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  openPicture(
    snapshot: InputHandoffSnapshot,
    answer: (picture: InputHandoffPicture) => Promise<InputHandoffSubmission>,
  ): Promise<void>;
  onDecide(action: Decision): void;
  onError(message: string | null): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const [state, setState] = useState<"idle" | "loading" | "shown" | "sending" | "failed">("idle");
  const [picture, setPicture] = useState<InputHandoffPicture | null>(null);
  const [typed, setTyped] = useState("");
  const size = useRef({ width: 0, height: 0 });
  const mounted = useRef(true);
  const pending = useRef<{
    resolve(submission: InputHandoffSubmission): void;
    reject(error: Error): void;
  } | null>(null);
  const field = snapshot.controls.find(
    (c): c is Extract<InputHandoffControl, { kind: "text" }> =>
      c.kind === "text" && c.id === INPUT_HANDOFF_PICTURE_TEXT_ID,
  );
  const blocked = snapshot.remoteInput !== true;
  const disabled = busy || blocked || state !== "shown";

  const load = () => {
    setState("loading");
    onError(null);
    let answered = false;
    openPicture(snapshot, (p) =>
      new Promise<InputHandoffSubmission>((resolve, reject) => {
        pending.current = {
          resolve: (submission) => {
            answered = true;
            resolve(submission);
          },
          reject,
        };
        setPicture(p);
        setState("shown");
      }),
    )
      .then(() => {
        if (!mounted.current) return;
        setTyped("");
        setState("sending");
      })
      .catch((e: unknown) => {
        if (!mounted.current) return;
        pending.current = null;
        setPicture(null);
        if (answered)
          onError(
            e instanceof Error && e.message === "INPUT_HANDOFF_STALE"
              ? t("interaction.inputHandoff.error.stale")
              : t("interaction.inputHandoff.error.submit"),
          );
        setState(answered ? "idle" : "failed");
      });
  };

  // One picture per revision: the card remounts this step for every new one.
  useEffect(() => {
    mounted.current = true;
    if (!blocked && openedHere.has(snapshot.requestId)) load();
    return () => {
      mounted.current = false;
      pending.current?.reject(new Error("INPUT_HANDOFF_CLOSED"));
      pending.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounted once per revision
  }, []);

  const answer = (action: InputHandoffAction, values: Record<string, string> = {}) => {
    const reply = pending.current;
    if (!reply || disabled) return;
    pending.current = null;
    setState("sending");
    reply.resolve({ expectedRevision: snapshot.revision, values, action });
  };

  const tap = (event: GestureResponderEvent) => {
    const { width, height } = size.current;
    if (width <= 0 || height <= 0) return;
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    answer({
      kind: "tap",
      x: clamp(event.nativeEvent.locationX / width),
      y: clamp(event.nativeEvent.locationY / height),
    });
  };

  const type = (submit: boolean) => {
    if (!field || (!submit && !typed)) return;
    answer({ kind: submit ? "submit" : "fill" }, typed ? { [field.id]: typed } : {});
  };

  const fieldLabel =
    field?.contentType === "password"
      ? t("interaction.inputHandoff.passwordField")
      : t("interaction.inputHandoff.picture.field");

  return (
    <View style={styles.stack}>
      {blocked ? (
        <Text style={styles.note}>{t("interaction.inputHandoff.remoteUnavailable")}</Text>
      ) : null}
      {picture && (state === "shown" || state === "sending") ? (
        <>
          <Text style={styles.note}>{t("interaction.inputHandoff.picture.hint")}</Text>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={t("interaction.inputHandoff.picture.alt")}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={tap}
            onLayout={(e: LayoutChangeEvent) => {
              size.current = e.nativeEvent.layout;
            }}
            style={[styles.picture, { aspectRatio: picture.width / picture.height }, disabled && styles.pictureDisabled]}
          >
            <Image
              source={{ uri: `data:${picture.mime};base64,${picture.data}` }}
              resizeMode="stretch"
              style={styles.pictureImage}
              accessibilityIgnoresInvertColors
            />
          </Pressable>
          {field ? (
            <View style={styles.field}>
              <Text style={styles.label}>{fieldLabel}</Text>
              <TextInput
                accessibilityLabel={fieldLabel}
                value={typed}
                onChangeText={setTyped}
                placeholderTextColor={colors.textPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                editable={!disabled}
                returnKeyType="done"
                onSubmitEditing={() => type(true)}
                style={styles.input}
                {...nativeTextInputProps(field.contentType)}
              />
            </View>
          ) : null}
        </>
      ) : state === "loading" || state === "sending" ? (
        <View style={styles.row}>
          <ActivityIndicator color={colors.textSecondary} />
          <Text style={styles.body}>
            {t(state === "loading" ? "interaction.inputHandoff.picture.loading" : "interaction.inputHandoff.phase.working")}
          </Text>
        </View>
      ) : (
        <Text style={styles.body}>
          {t(state === "failed" ? "interaction.inputHandoff.picture.error" : "interaction.inputHandoff.picture.openHint")}
        </Text>
      )}
      <MainWindowActionGroup
        density="compact"
        cancelAction={{ label: t("interaction.inputHandoff.action.cancel"), disabled: busy, onPress: () => onDecide("cancel") }}
        secondaryActions={[
          { label: t("interaction.inputHandoff.action.backToForm"), disabled: busy, tone: "secondary", onPress: () => onDecide("refresh") },
          { label: t("interaction.inputHandoff.action.done"), disabled: busy, tone: "secondary", onPress: () => onDecide("done") },
        ]}
        primaryActions={
          picture && state === "shown"
            ? field
              ? [
                  { label: t("interaction.inputHandoff.picture.type"), disabled: disabled || !typed, tone: "secondary", onPress: () => type(false) },
                  { label: t("interaction.inputHandoff.picture.typeEnter"), disabled, tone: "primary", onPress: () => type(true) },
                ]
              : []
            : state === "idle" || state === "failed"
              ? [
                  {
                    label: t("interaction.inputHandoff.picture.open"),
                    disabled: busy || blocked,
                    tone: "primary",
                    onPress: () => {
                      rememberInputHandoffPictureOpened(snapshot.requestId);
                      load();
                    },
                  },
                ]
              : []
        }
      />
    </View>
  );
}
