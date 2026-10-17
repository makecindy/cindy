import type {
  InputHandoffContentType,
  InputHandoffControl,
  InputHandoffSnapshot,
  InputHandoffValues,
} from "@cindy/device-link";
import { isInputHandoffDeviceCode } from "@cindy/device-link";
import { Platform, type TextInputProps } from "react-native";

/**
 * Return moves field to field and answers on the last one. The iOS number
 * and phone pads have no Return key, so iOS uses the numeric keyboard that
 * keeps one.
 */
const numericKeyboard = (pad: "number-pad" | "phone-pad"): TextInputProps["keyboardType"] =>
  Platform.OS === "ios" ? "numbers-and-punctuation" : pad;

/**
 * Standard platform hints per field so iOS AutoFill / Android Autofill and
 * password managers (1Password) offer the right item. Password fields are
 * the plain system secure field — no custom reveal.
 */
export function nativeTextInputProps(
  contentType: InputHandoffContentType,
): Pick<
  TextInputProps,
  "secureTextEntry" | "textContentType" | "autoComplete" | "keyboardType"
> {
  switch (contentType) {
    case "password":
      return {
        secureTextEntry: true,
        textContentType: "password",
        autoComplete: "password",
      };
    case "one-time-code":
      return {
        textContentType: "oneTimeCode",
        autoComplete: "sms-otp",
        keyboardType: numericKeyboard("number-pad"),
      };
    case "username":
      return { textContentType: "username", autoComplete: "username" };
    case "email":
      return {
        textContentType: "emailAddress",
        autoComplete: "email",
        keyboardType: "email-address",
      };
    case "tel":
      return {
        textContentType: "telephoneNumber",
        autoComplete: "tel",
        keyboardType: numericKeyboard("phone-pad"),
      };
    case "url":
      return { textContentType: "URL", autoComplete: "url", keyboardType: "url" };
    case "number":
      return { textContentType: "none", autoComplete: "off", keyboardType: numericKeyboard("number-pad") };
    default:
      return { textContentType: "none", autoComplete: "off" };
  }
}

export type InputHandoffTextControl = Extract<InputHandoffControl, { kind: "text" }>;

/** The fields the owner types into, in screen order. */
export const inputHandoffTextFields = (snapshot: InputHandoffSnapshot): InputHandoffTextControl[] =>
  snapshot.controls.filter((c): c is InputHandoffTextControl => c.kind === "text");

/**
 * The same hints for the SwiftUI fields of the iOS sheet (system AutoFill,
 * Passwords and 1Password read the content type).
 */
export function swiftFieldTraits(contentType: InputHandoffContentType): {
  textContentType?: "username" | "password" | "oneTimeCode" | "emailAddress" | "telephoneNumber" | "URL";
  keyboardType: "default" | "email-address" | "numbers-and-punctuation" | "url";
} {
  switch (contentType) {
    case "password":
      return { textContentType: "password", keyboardType: "default" };
    case "one-time-code":
      return { textContentType: "oneTimeCode", keyboardType: "numbers-and-punctuation" };
    case "username":
      return { textContentType: "username", keyboardType: "default" };
    case "email":
      return { textContentType: "emailAddress", keyboardType: "email-address" };
    case "tel":
      return { textContentType: "telephoneNumber", keyboardType: "numbers-and-punctuation" };
    case "url":
      return { textContentType: "URL", keyboardType: "url" };
    case "number":
      return { keyboardType: "numbers-and-punctuation" };
    default:
      return { keyboardType: "default" };
  }
}

/**
 * Where the fields are, as the owner reads it: just the site for a plain
 * https page (with a lock), the full origin when something about it needs a
 * second look, otherwise the app.
 */
export function inputHandoffPlace(source: InputHandoffSnapshot["source"]): { label: string; secure: boolean } {
  const origin = source.origin;
  if (!origin) return { label: source.app, secure: false };
  if (origin.startsWith("https://") && !source.warning) return { label: origin.slice("https://".length), secure: true };
  return { label: origin, secure: false };
}

export type InputHandoffPlaceKind = "web" | "terminal" | "app";

export const inputHandoffPlaceKind = (snapshot: InputHandoffSnapshot): InputHandoffPlaceKind =>
  snapshot.command ? "terminal" : snapshot.source.origin ? "web" : "app";

/** The sheet opens only on a screen with something for the owner: fields, a picture or a sign-in code. */
export function inputHandoffSheetHasContent(snapshot: InputHandoffSnapshot, heldElsewhere: boolean): boolean {
  if (snapshot.terminal || snapshot.phase !== "ready" || heldElsewhere) return false;
  return (
    Boolean(snapshot.picture) ||
    isInputHandoffDeviceCode(snapshot.deviceCode) ||
    inputHandoffTextFields(snapshot).length > 0
  );
}

/** Only fields the owner typed into are applied; text already on the screen stays. */
export function changedInputHandoffValues(
  snapshot: InputHandoffSnapshot,
  draft: InputHandoffValues,
): InputHandoffValues {
  const out: InputHandoffValues = {};
  for (const control of inputHandoffTextFields(snapshot)) {
    const value = draft[control.id];
    if (value) out[control.id] = value;
  }
  return out;
}

export function parseInputHandoffSnapshotLike(
  raw: Record<string, unknown>,
): InputHandoffSnapshot | null {
  const source = raw.source as Record<string, unknown> | undefined;
  if (
    raw.kind !== "input_handoff" ||
    typeof raw.requestId !== "string" ||
    !Number.isSafeInteger(raw.revision) ||
    typeof raw.purpose !== "string" ||
    !Array.isArray(raw.controls) ||
    !source ||
    typeof source.app !== "string"
  )
    return null;
  return raw as unknown as InputHandoffSnapshot;
}
