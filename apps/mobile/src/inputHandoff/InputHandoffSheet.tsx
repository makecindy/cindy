/**
 * The 代输入 form, opened from the strip above the composer. iOS uses the
 * native SwiftUI sheet (InputHandoffSheet.ios.tsx); elsewhere a bottom panel
 * with the platform's own text fields. Both read the same props.
 */
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { AppWindow, Globe, Lock, QrCode, SquareTerminal } from "lucide-react-native";
import type { InputHandoffSnapshot } from "@cindy/device-link";
import { Text } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { iconSize, iconStroke, spacing, useTheme, useThemedStyles } from "@/theme";
import { InputHandoffStepFields } from "./InputHandoffStepFields";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import { inputHandoffPlace, inputHandoffPlaceKind } from "./inputHandoffNative";
import {
  inputHandoffSheetMode,
  inputHandoffWarnings,
  type InputHandoffQrSheet,
  type InputHandoffSheetProps,
} from "./inputHandoffSheetModel";

export function InputHandoffSheet(props: InputHandoffSheetProps) {
  const { visible, snapshot, busy, error, embedded, onClose } = props;
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const insets = useSafeAreaInsets();
  const mode = inputHandoffSheetMode(snapshot);
  const remote = snapshot.remoteInput === true;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.sheetBackdrop}
      >
        <Pressable accessibilityRole="button" accessibilityLabel={t("interaction.inputHandoff.action.close")} style={{ flex: 1 }} onPress={onClose} />
        <View style={[styles.sheetPanel, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]} testID="interaction.inputHandoff.sheet">
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.lg }}>
            <InputHandoffSheetHeader snapshot={snapshot} />
            {mode === "fields" ? (
              <>
                {embedded}
                <InputHandoffStepFields
                  key={props.stepKey}
                  snapshot={snapshot}
                  draft={props.draft}
                  disabled={busy || !remote}
                  onChange={props.onChange}
                  onSubmit={props.onSubmit}
                />
              </>
            ) : (
              embedded
            )}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {mode === "qr" && props.qr ? (
              <InputHandoffQrActions {...props} qr={props.qr} />
            ) : mode === "picture" || mode === "qr" ? null : (
              <>
                <Text style={styles.sheetNote}>{t("interaction.inputHandoff.sheetNote")}</Text>
                <View style={styles.sheetButtons}>
                  <MainWindowActionButton
                    grow
                    action={{
                      label: t(mode === "code" ? "interaction.inputHandoff.action.done" : "interaction.inputHandoff.action.continue"),
                      tone: "primary",
                      busy,
                      disabled: mode === "fields" && !remote,
                      testID: "interaction.inputHandoff.continue",
                      onPress: mode === "code" ? props.onDone : props.onSubmit,
                    }}
                  />
                  <MainWindowActionButton
                    grow
                    action={{ label: t("interaction.inputHandoff.action.close"), tone: "secondary", onPress: onClose }}
                  />
                </View>
              </>
            )}
            <InputHandoffQuietLinks {...props} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function InputHandoffSheetHeader({ snapshot }: { snapshot: InputHandoffSnapshot }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const place = inputHandoffPlace(snapshot.source);
  const kind = inputHandoffPlaceKind(snapshot);
  const Icon = snapshot.qr === "scan" ? QrCode : kind === "web" ? Globe : kind === "terminal" ? SquareTerminal : AppWindow;
  return (
    <View style={styles.sheetHeader}>
      <View style={styles.sheetIcon}>
        <Icon color={colors.textPrimary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
      </View>
      <Text style={styles.sheetTitle}>{snapshot.purpose}</Text>
      <View style={styles.place}>
        {place.secure ? <Lock color={colors.textSecondary} size={iconSize.xs} strokeWidth={iconStroke.regular} /> : null}
        <Text numberOfLines={1} style={styles.placeText}>{place.label}</Text>
      </View>
      {snapshot.note ? (
        <Text style={styles.sheetNote}>{t("interaction.inputHandoff.agentNote", { note: snapshot.note })}</Text>
      ) : null}
      {snapshot.command ? <Text style={styles.mono}>{snapshot.command}</Text> : null}
      {inputHandoffWarnings(snapshot, t).map((warning) => (
        <Text key={warning} style={styles.warning}>{warning}</Text>
      ))}
    </View>
  );
}

/** Scan-to-sign-in: open the link here (the app that handles it takes over), or save or share the code. */
function InputHandoffQrActions({ qr, busy, onClose }: InputHandoffSheetProps & { qr: InputHandoffQrSheet }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const link = qr.view.link;
  const disabled = busy || qr.view.state !== "shown";
  const share = { label: t("interaction.inputHandoff.qr.share"), disabled, onPress: qr.onShare };
  return (
    <>
      <Text style={styles.sheetNote}>
        {t(link ? "interaction.inputHandoff.qr.hintLink" : "interaction.inputHandoff.qr.hint")}
      </Text>
      <View style={styles.sheetButtons}>
        <MainWindowActionButton
          grow
          action={
            link
              ? {
                  label: t(link.web ? "interaction.inputHandoff.qr.open" : "interaction.inputHandoff.qr.openApp", { site: link.site }),
                  tone: "primary",
                  disabled,
                  testID: "interaction.inputHandoff.qr.open",
                  onPress: qr.onOpen,
                }
              : { ...share, tone: "primary", testID: "interaction.inputHandoff.qr.share" }
          }
        />
        {link ? (
          <MainWindowActionButton grow action={{ ...share, tone: "secondary", testID: "interaction.inputHandoff.qr.share" }} />
        ) : null}
        {qr.notice ? <Text style={[styles.sheetNote]}>{qr.notice}</Text> : null}
        <MainWindowActionButton
          grow
          action={{ label: t("interaction.inputHandoff.action.close"), tone: "secondary", onPress: onClose }}
        />
      </View>
    </>
  );
}

function InputHandoffQuietLinks({ snapshot, busy, onPicture, onLiveView, qr }: InputHandoffSheetProps) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  // A terminal prompt has no screen to look at; a picture step is already one, except a QR code cut out of it.
  const picture = !snapshot.command && (!snapshot.picture || snapshot.qr === "scan");
  const copy = snapshot.qr === "scan" && qr?.view.text ? qr : null;
  if (!picture && !onLiveView && !copy) return null;
  return (
    <View style={styles.quietRow}>
      {copy ? (
        <Pressable accessibilityRole="button" onPress={copy.onCopy} style={styles.quietLink} testID="interaction.inputHandoff.qr.copy">
          <Text style={styles.meta}>
            {t(copy.view.link ? "interaction.inputHandoff.qr.copyLink" : "interaction.inputHandoff.qr.copyText")}
          </Text>
        </Pressable>
      ) : null}
      {picture ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={onPicture} style={styles.quietLink}>
          <Text style={styles.meta}>{t("interaction.inputHandoff.action.picture")}</Text>
        </Pressable>
      ) : null}
      {onLiveView ? (
        <Pressable accessibilityRole="button" onPress={onLiveView} style={styles.quietLink} testID="interaction.inputHandoff.liveView">
          <Text style={styles.meta}>{t("interaction.inputHandoff.action.liveView")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
