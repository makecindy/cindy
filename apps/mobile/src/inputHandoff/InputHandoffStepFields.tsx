import type { TextInputInstance } from 'react-native';
import { useRef, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import type { InputHandoffSnapshot, InputHandoffValues } from "@cindy/device-link";
import { Text, TextInput } from "@/components/AppText";
import { MainWindowActionButton } from "@/components/MobilePrimitives";
import { useTheme, useThemedStyles } from "@/theme";
import { makeInputHandoffStyles } from "./inputHandoffStyles";
import { inputHandoffTextFields, nativeTextInputProps } from "./inputHandoffNative";

/**
 * Only the fields the owner types into, in screen order, plus what the page
 * says is wrong with them. The keyboard's Next moves on; Go on the last field
 * answers like the sheet's Continue, and the computer confirms on the page.
 */
export function InputHandoffStepFields({
  snapshot,
  draft,
  disabled,
  onChange,
  onSubmit,
  onFieldFocus,
}: {
  snapshot: InputHandoffSnapshot;
  draft: InputHandoffValues;
  disabled: boolean;
  onChange(id: string, value: string): void;
  onSubmit(): void;
  onFieldFocus?(top: number | null): void;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeInputHandoffStyles);
  const { colors } = useTheme();
  const [focused, setFocused] = useState<string | null>(null);
  const inputs = useRef(new Map<string, TextInputInstance>());
  const fieldTops = useRef(new Map<string, number>());
  const contentTop = useRef(0);
  const fields = inputHandoffTextFields(snapshot);
  const nextField = (id: string) => fields[fields.findIndex((f) => f.id === id) + 1];

  return (
    <View style={styles.stack} onLayout={event => { contentTop.current = event.nativeEvent.layout.y; }}>
      {snapshot.controls.map((control) => {
        if (control.kind === "note")
          return (
            <Text key={control.id} style={styles.error}>
              {control.text}
            </Text>
          );
        const label = inputHandoffFieldLabel(control, t);
        const next = nextField(control.id);
        return (
          <View key={control.id} style={styles.field} onLayout={event => { fieldTops.current.set(control.id, event.nativeEvent.layout.y); }}>
            <Text style={styles.fieldLabel}>{label}</Text>
            <TextInput
              ref={(input) => {
                if (input) inputs.current.set(control.id, input);
                else inputs.current.delete(control.id);
              }}
              accessibilityLabel={label}
              onFocus={() => { setFocused(control.id); onFieldFocus?.(contentTop.current + (fieldTops.current.get(control.id) ?? 0)); }}
              onBlur={() => { setFocused(null); onFieldFocus?.(null); }}
              value={draft[control.id] ?? ""}
              onChangeText={(v) => onChange(control.id, v)}
              placeholder={control.placeholder}
              placeholderTextColor={colors.textPlaceholder}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              editable={!disabled}
              multiline={control.multiline === true}
              // Return always moves on, even in a multi-line field (pasted lines are kept).
              returnKeyType={next ? "next" : "go"}
              submitBehavior={next ? "submit" : "blurAndSubmit"}
              onSubmitEditing={() => (next ? inputs.current.get(next.id)?.focus() : !disabled && onSubmit())}
              underlineColorAndroid="transparent"
              style={[styles.input, focused === control.id && styles.inputFocused]}
              {...nativeTextInputProps(control.contentType)}
            />
            {control.filled ? <Text style={styles.note}>{t("interaction.inputHandoff.filledHint")}</Text> : null}
            {control.suggestions?.length ? (
              <View style={styles.wrap}>
                {control.suggestions.slice(0, 12).map((o) => (
                  <MainWindowActionButton
                    key={o.id}
                    density="compact"
                    action={{ label: o.label, disabled, tone: "secondary", onPress: () => onChange(control.id, o.label) }}
                  />
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function inputHandoffFieldLabel(
  control: { label?: string; contentType: string },
  t: (key: string) => string,
): string {
  if (control.label) return control.label;
  if (control.contentType === "password") return t("interaction.inputHandoff.passwordField");
  if (control.contentType === "one-time-code") return t("interaction.inputHandoff.codeField");
  return t("interaction.inputHandoff.unnamedField");
}
