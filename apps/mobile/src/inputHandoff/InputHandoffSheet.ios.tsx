/**
 * The 代输入 form on iOS: a native SwiftUI sheet sized to its content, with
 * system text and secure fields. Their content types let AutoFill, Passwords
 * and 1Password offer the right item; the eye only swaps the field kind and
 * keeps the typed text in native state. Values reach this component through
 * change events and leave only through the card's sealed per-step channel.
 */
import { useRef, useState, type ReactNode } from "react";
import { View, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import { Host } from "@expo/ui";
import {
  BottomSheet,
  Button,
  Group,
  HStack,
  Image,
  RNHostView,
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  useNativeState,
  type SecureFieldRef,
  type TextFieldRef,
} from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  autocorrectionDisabled,
  background,
  buttonStyle,
  contentShape,
  disabled as disabledModifier,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  keyboardType,
  lineLimit,
  multilineTextAlignment,
  onSubmit,
  padding,
  presentationDragIndicator,
  shapes,
  strokeBorder,
  submitLabel,
  textContentType,
  textInputAutocapitalization,
} from "@expo/ui/swift-ui/modifiers";
import type { InputHandoffSnapshot } from "@cindy/device-link";
import { iconSize, radius, spacing, useTheme } from "@/theme";
import {
  inputHandoffSheetMode,
  inputHandoffWarnings,
  type InputHandoffQrSheet,
  type InputHandoffSheetProps,
} from "./inputHandoffSheetModel";
import { inputHandoffFieldLabel } from "./InputHandoffStepFields";
import {
  inputHandoffPlace,
  inputHandoffPlaceKind,
  inputHandoffTextFields,
  swiftFieldTraits,
  type InputHandoffTextControl,
} from "./inputHandoffNative";

const SIDE = 24;

/** Fields, the icon tile and the command sit on the sheet like its action rows: filled and outlined in both modes. */
const sheetRow = (colors: { sheetActionSurface: string; sheetActionBorder: string }, cornerRadius: number) => [
  background(colors.sheetActionSurface, shapes.roundedRectangle({ cornerRadius, roundedCornerStyle: "continuous" })),
  strokeBorder({ color: colors.sheetActionBorder, shape: "roundedRectangle", cornerRadius, style: { lineWidth: 1 } }),
];
const FIELD_HEIGHT = 50;
const BUTTON_HEIGHT = 52;

export function InputHandoffSheet(props: InputHandoffSheetProps) {
  const { visible, snapshot, busy, error, embedded, onClose } = props;
  const { t } = useTranslation();
  const { mode: scheme, colors } = useTheme();
  const mode = inputHandoffSheetMode(snapshot);
  const remote = snapshot.remoteInput === true;
  const fieldsDisabled = busy || !remote;
  const fields = inputHandoffTextFields(snapshot);
  const focusers = useRef(new Map<string, () => void>());
  const focusAfter = (id: string) => {
    const next = fields[fields.findIndex((f) => f.id === id) + 1];
    if (next) focusers.current.get(next.id)?.();
    else if (!fieldsDisabled) props.onSubmit();
  };
  const primary =
    mode === "picture" || mode === "qr"
      ? null
      : {
          label: t(mode === "code" ? "interaction.inputHandoff.action.done" : "interaction.inputHandoff.action.continue"),
          disabled: busy || (mode === "fields" && !remote),
          onPress: mode === "code" ? props.onDone : props.onSubmit,
        };
  // A QR step shows just the code; the whole window stays one tap away.
  const quietPicture = !snapshot.command && !snapshot.agentPicture && (!snapshot.picture || mode === "qr");
  return (
    <Host colorScheme={scheme} seedColor={colors.textPrimary} pointerEvents="none" style={{ position: "absolute" }}>
      <BottomSheet
        isPresented={visible}
        fitToContents
        onIsPresentedChange={(open) => {
          if (!open && visible) onClose();
        }}
      >
        <Group modifiers={[presentationDragIndicator("visible")]}>
          <VStack spacing={spacing.lg} modifiers={[padding({ top: 28, leading: SIDE, trailing: SIDE, bottom: spacing.md })]}>
            <SheetHeader snapshot={snapshot} />
            {mode !== "fields" ? (
              <Embedded>{embedded}</Embedded>
            ) : (
              <>
                {embedded ? <Embedded>{embedded}</Embedded> : null}
                <VStack spacing={spacing.md} alignment="leading">
                  {snapshot.controls.map((control) =>
                    control.kind === "note" ? (
                      <HStack key={control.id} spacing={6} alignment="top">
                        <Image systemName="exclamationmark.circle.fill" size={iconSize.sm} color={colors.statusError} />
                        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.errorText), frame({ maxWidth: Infinity, alignment: "leading" })]}>
                          {control.text}
                        </Text>
                      </HStack>
                    ) : (
                      <SheetField
                        key={`${props.stepKey}:${control.id}`}
                        control={control}
                        label={inputHandoffFieldLabel(control, t)}
                        last={fields[fields.length - 1]?.id === control.id}
                        disabled={fieldsDisabled}
                        onChange={(value) => props.onChange(control.id, value)}
                        onReturn={() => focusAfter(control.id)}
                        registerFocus={(focus) => {
                          if (focus) focusers.current.set(control.id, focus);
                          else focusers.current.delete(control.id);
                        }}
                      />
                    ),
                  )}
                </VStack>
              </>
            )}
            {error ? (
              <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.errorText), multilineTextAlignment("center"), frame({ maxWidth: Infinity })]}>
                {error}
              </Text>
            ) : null}
            {mode === "qr" && props.qr ? (
              <QrActions qr={props.qr} busy={busy} onClose={onClose} onDone={snapshot.agentPicture ? props.onDone : undefined} />
            ) : null}
            {primary ? (
              <VStack spacing={spacing.xs}>
                <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), multilineTextAlignment("center"), frame({ maxWidth: Infinity })]}>
                  {t("interaction.inputHandoff.sheetNote")}
                </Text>
                <Button
                  onPress={primary.onPress}
                  modifiers={[buttonStyle("plain"), disabledModifier(primary.disabled), padding({ top: spacing.sm }), accessibilityLabel(primary.label)]}
                >
                  <Text
                    modifiers={[
                      font({ textStyle: "body", weight: "semibold" }),
                      foregroundStyle(colors.ctaText),
                      frame({ maxWidth: Infinity, minHeight: BUTTON_HEIGHT }),
                      background(primary.disabled ? colors.textTertiary : colors.cta, shapes.capsule()),
                      contentShape(shapes.capsule()),
                    ]}
                  >
                    {busy ? t("interaction.inputHandoff.phase.working") : primary.label}
                  </Text>
                </Button>
                <Button onPress={onClose} modifiers={[buttonStyle("plain")]}>
                  <Text
                    modifiers={[
                      font({ textStyle: "body", weight: "medium" }),
                      foregroundStyle(colors.textPrimary),
                      frame({ maxWidth: Infinity, minHeight: BUTTON_HEIGHT - 8 }),
                      contentShape(shapes.rectangle()),
                    ]}
                  >
                    {t("interaction.inputHandoff.action.close")}
                  </Text>
                </Button>
              </VStack>
            ) : null}
            {quietPicture || props.onLiveView ? (
              <HStack spacing={spacing.xl}>
                <Spacer />
                {mode === "qr" && props.qr?.view.text ? (
                  <QuietLink
                    label={t(props.qr.view.link ? "interaction.inputHandoff.qr.copyLink" : "interaction.inputHandoff.qr.copyText")}
                    onPress={props.qr.onCopy}
                  />
                ) : null}
                {quietPicture ? <QuietLink label={t("interaction.inputHandoff.action.picture")} disabled={busy} onPress={props.onPicture} /> : null}
                {props.onLiveView ? <QuietLink label={t("interaction.inputHandoff.action.liveView")} onPress={props.onLiveView} /> : null}
                <Spacer />
              </HStack>
            ) : null}
          </VStack>
        </Group>
      </BottomSheet>
    </Host>
  );
}

function SheetHeader({ snapshot }: { snapshot: InputHandoffSnapshot }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const place = inputHandoffPlace(snapshot.source);
  const kind = inputHandoffPlaceKind(snapshot);
  return (
    <VStack spacing={spacing.sm}>
      <Image
        systemName={snapshot.qr === "scan" ? "qrcode" : kind === "web" ? "globe" : kind === "terminal" ? "terminal" : "macwindow"}
        size={iconSize.xl}
        color={colors.textPrimary}
        modifiers={[frame({ width: 60, height: 60 }), ...sheetRow(colors, radius.container)]}
      />
      <Text modifiers={[font({ textStyle: "title3", weight: "semibold" }), multilineTextAlignment("center"), padding({ top: spacing.xs })]}>
        {snapshot.purpose}
      </Text>
      <HStack spacing={4}>
        {place.secure ? <Image systemName="lock.fill" size={iconSize.xs} color={colors.textSecondary} /> : null}
        <Text modifiers={[font({ textStyle: "subheadline" }), foregroundStyle(colors.textSecondary), lineLimit(1)]}>{place.label}</Text>
      </HStack>
      {snapshot.note ? (
        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), multilineTextAlignment("center")]}>
          {t("interaction.inputHandoff.agentNote", { note: snapshot.note })}
        </Text>
      ) : null}
      {snapshot.command ? (
        <Text
          modifiers={[
            font({ textStyle: "footnote", design: "monospaced" }),
            foregroundStyle(colors.textSecondary),
            frame({ maxWidth: Infinity }),
            padding({ all: spacing.sm }),
            ...sheetRow(colors, radius.control),
          ]}
        >
          {snapshot.command}
        </Text>
      ) : null}
      {inputHandoffWarnings(snapshot, t).map((warning) => (
        <HStack key={warning} spacing={6} alignment="top">
          <Image systemName="exclamationmark.triangle.fill" size={iconSize.sm} color={colors.warningFg} />
          {/* Wraps in full: the AI-screenshot warning carries the check-the-site instruction. */}
          <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textPrimary), frame({ maxWidth: Infinity, alignment: "leading" }), fixedSize({ horizontal: false, vertical: true })]}>{warning}</Text>
        </HStack>
      ))}
    </VStack>
  );
}

function SheetField({
  control,
  label,
  last,
  disabled,
  onChange,
  onReturn,
  registerFocus,
}: {
  control: InputHandoffTextControl;
  label: string;
  last: boolean;
  disabled: boolean;
  onChange(value: string): void;
  onReturn(): void;
  registerFocus(focus: (() => void) | null): void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // Shared by both field kinds, so revealing a password keeps what was typed.
  const text = useNativeState("");
  const [revealed, setRevealed] = useState(false);
  const secure = control.contentType === "password";
  const traits = swiftFieldTraits(control.contentType);
  const ref = (field: TextFieldRef | SecureFieldRef | null) => registerFocus(field ? () => void field.focus() : null);
  const modifiers = [
    ...(traits.textContentType ? [textContentType(traits.textContentType)] : []),
    keyboardType(traits.keyboardType),
    textInputAutocapitalization("never"),
    autocorrectionDisabled(true),
    submitLabel(last ? "go" : "next"),
    onSubmit(onReturn),
    disabledModifier(disabled),
    font({ textStyle: "body" }),
    frame({ maxWidth: Infinity, minHeight: FIELD_HEIGHT }),
    accessibilityLabel(label),
  ];
  const placeholder = control.placeholder ?? "";
  return (
    <VStack spacing={6} alignment="leading">
      <Text modifiers={[font({ textStyle: "subheadline", weight: "medium" }), foregroundStyle(colors.textSecondary)]}>{label}</Text>
      <HStack
        spacing={spacing.sm}
        modifiers={[
          padding({ horizontal: 14 }),
          frame({ minHeight: FIELD_HEIGHT }),
          ...sheetRow(colors, radius.container),
        ]}
      >
        {secure && !revealed ? (
          <SecureField ref={ref} text={text} placeholder={placeholder} onTextChange={onChange} modifiers={modifiers} />
        ) : (
          <TextField
            ref={ref}
            text={text}
            placeholder={placeholder}
            axis={control.multiline ? "vertical" : "horizontal"}
            onTextChange={onChange}
            modifiers={control.multiline ? [...modifiers, lineLimit(4)] : modifiers}
          />
        )}
        {secure ? (
          <Button
            onPress={() => setRevealed((shown) => !shown)}
            modifiers={[
              buttonStyle("plain"),
              accessibilityLabel(t(revealed ? "interaction.inputHandoff.action.hidePassword" : "interaction.inputHandoff.action.showPassword")),
            ]}
          >
            <Image
              systemName={revealed ? "eye.slash" : "eye"}
              size={iconSize.lg}
              color={colors.textSecondary}
              modifiers={[frame({ width: 32, height: 44 }), contentShape(shapes.rectangle())]}
            />
          </Button>
        ) : null}
      </HStack>
      {control.filled ? (
        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary)]}>{t("interaction.inputHandoff.filledHint")}</Text>
      ) : null}
      {control.suggestions?.length ? (
        <HStack spacing={spacing.sm}>
          {control.suggestions.slice(0, 4).map((option) => (
            <Button
              key={option.id}
              label={option.label}
              onPress={() => {
                text.set(option.label);
                onChange(option.label);
              }}
              modifiers={[buttonStyle("bordered"), disabledModifier(disabled)]}
            />
          ))}
        </HStack>
      ) : null}
    </VStack>
  );
}

/** Scan-to-sign-in: open the link here (the app that handles it takes over), or save or share the code. */
/** `onDone`: an agent's screenshot, where Cindy cannot see the scan finish; the owner hands back. */
function QrActions({ qr, busy, onClose, onDone }: { qr: InputHandoffQrSheet; busy: boolean; onClose(): void; onDone?: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const shown = qr.view.state === "shown";
  const link = qr.view.link;
  const primary = link
    ? { label: t(link.web ? "interaction.inputHandoff.qr.open" : "interaction.inputHandoff.qr.openApp", { site: link.site }), onPress: qr.onOpen }
    : { label: t("interaction.inputHandoff.qr.share"), onPress: qr.onShare };
  const disabled = busy || !shown;
  return (
    <VStack spacing={spacing.xs}>
      {onDone ? null : (
        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), multilineTextAlignment("center"), frame({ maxWidth: Infinity }), fixedSize({ horizontal: false, vertical: true })]}>
          {t(link ? "interaction.inputHandoff.qr.hintLink" : "interaction.inputHandoff.qr.hint")}
        </Text>
      )}
      <Button
        onPress={primary.onPress}
        modifiers={[buttonStyle("plain"), disabledModifier(disabled), padding({ top: spacing.sm }), accessibilityLabel(primary.label)]}
      >
        <Text
          modifiers={[
            font({ textStyle: "body", weight: "semibold" }),
            foregroundStyle(colors.ctaText),
            lineLimit(1),
            padding({ horizontal: spacing.lg }),
            frame({ maxWidth: Infinity, minHeight: BUTTON_HEIGHT }),
            background(disabled ? colors.textTertiary : colors.cta, shapes.capsule()),
            contentShape(shapes.capsule()),
          ]}
        >
          {primary.label}
        </Text>
      </Button>
      {link ? (
        <Button onPress={qr.onShare} modifiers={[buttonStyle("plain"), disabledModifier(disabled), padding({ top: spacing.xs })]}>
          <Text
            modifiers={[
              font({ textStyle: "body", weight: "medium" }),
              foregroundStyle(colors.textPrimary),
              frame({ maxWidth: Infinity, minHeight: BUTTON_HEIGHT }),
              background(colors.sheetActionSurface, shapes.capsule()),
              strokeBorder({ color: colors.sheetActionBorder, shape: "capsule", style: { lineWidth: 1 } }),
              contentShape(shapes.capsule()),
            ]}
          >
            {t("interaction.inputHandoff.qr.share")}
          </Text>
        </Button>
      ) : null}
      {qr.notice ? (
        <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), multilineTextAlignment("center"), frame({ maxWidth: Infinity }), fixedSize({ horizontal: false, vertical: true })]}>
          {qr.notice}
        </Text>
      ) : null}
      {onDone ? (
        <Button onPress={onDone} modifiers={[buttonStyle("plain"), disabledModifier(busy), padding({ top: spacing.xs }), accessibilityLabel(t("interaction.inputHandoff.action.done"))]}>
          <Text
            modifiers={[
              font({ textStyle: "body", weight: "medium" }),
              foregroundStyle(colors.textPrimary),
              frame({ maxWidth: Infinity, minHeight: BUTTON_HEIGHT }),
              background(colors.sheetActionSurface, shapes.capsule()),
              strokeBorder({ color: colors.sheetActionBorder, shape: "capsule", style: { lineWidth: 1 } }),
              contentShape(shapes.capsule()),
            ]}
          >
            {t("interaction.inputHandoff.action.done")}
          </Text>
        </Button>
      ) : null}
      <Button onPress={onClose} modifiers={[buttonStyle("plain")]}>
        <Text
          modifiers={[
            font({ textStyle: "body", weight: "medium" }),
            foregroundStyle(colors.textPrimary),
            frame({ maxWidth: Infinity, minHeight: BUTTON_HEIGHT - 8 }),
            contentShape(shapes.rectangle()),
          ]}
        >
          {t("interaction.inputHandoff.action.close")}
        </Text>
      </Button>
    </VStack>
  );
}

function QuietLink({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  const { colors } = useTheme();
  return (
    <Button onPress={onPress} modifiers={[buttonStyle("plain"), disabledModifier(disabled)]}>
      <Text modifiers={[font({ textStyle: "footnote" }), foregroundStyle(colors.textSecondary), frame({ minHeight: 44 })]}>{label}</Text>
    </Button>
  );
}

/** React Native content (screenshot step, sign-in code) inside the native sheet. */
function Embedded({ children }: { children: ReactNode }) {
  // The hosted view sizes to its content, so the width is given outright.
  const { width } = useWindowDimensions();
  return (
    <RNHostView matchContents>
      <View style={{ width: width - SIDE * 2 }}>{children}</View>
    </RNHostView>
  );
}
