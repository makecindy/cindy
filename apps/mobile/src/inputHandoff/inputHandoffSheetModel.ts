/** What the 代输入 sheet shows, shared by the iOS sheet and the bottom panel used elsewhere. */
import type { ReactNode } from "react";
import {
  isInputHandoffDeviceCode,
  type InputHandoffSnapshot,
  type InputHandoffValues,
} from "@cindy/device-link";
import { inputHandoffTextFields } from "./inputHandoffNative";
import type { InputHandoffQrView } from "./useInputHandoffQr";

/** Scan-to-sign-in on the sheet: the code, and what can be done with it on this phone. */
export interface InputHandoffQrSheet {
  view: InputHandoffQrView;
  onOpen(): void;
  onShare(): void;
  onCopy(): void;
  /** Result of the last open, share or copy. */
  notice: string | null;
}

export interface InputHandoffSheetProps {
  visible: boolean;
  snapshot: InputHandoffSnapshot;
  /** Changes with every new screen: fields start empty on each. */
  stepKey: string;
  draft: InputHandoffValues;
  busy: boolean;
  error: string | null;
  /** The screenshot step or the device-code panel, shown as they are. */
  embedded: ReactNode;
  onChange(id: string, value: string): void;
  /** Hands the typed values to the computer, which confirms on the page. */
  onSubmit(): void;
  /** Sign-in code steps: the owner finished elsewhere and hands back. */
  onDone(): void;
  onPicture(): void;
  onLiveView?(): void;
  /** Scan-to-sign-in steps only. */
  qr: InputHandoffQrSheet | null;
  /** Closes the sheet only; the handoff stays open in the strip. */
  onClose(): void;
}

/** What the sheet asks for: typing, a QR code to scan, a sign-in code to use elsewhere, or a picture of the screen. */
export function inputHandoffSheetMode(snapshot: InputHandoffSnapshot): "qr" | "picture" | "code" | "fields" {
  if (snapshot.picture && snapshot.qr === "scan") return "qr";
  if (snapshot.picture) return "picture";
  if (isInputHandoffDeviceCode(snapshot.deviceCode) && inputHandoffTextFields(snapshot).length === 0) return "code";
  return "fields";
}

/** What the owner should check before typing: the page's origin, an agent-opened browser, a computer that can't take input. */
export function inputHandoffWarnings(snapshot: InputHandoffSnapshot, t: (key: string) => string): string[] {
  const out: string[] = [];
  if (snapshot.source.warning) out.push(t(`interaction.inputHandoff.originWarning.${snapshot.source.warning}`));
  if (snapshot.agentControlled) out.push(t("interaction.inputHandoff.agentControlled"));
  if (snapshot.remoteInput !== true) out.push(t("interaction.inputHandoff.remoteUnavailable"));
  if (snapshot.failure && !snapshot.terminal) out.push(t(`interaction.inputHandoff.failure.${snapshot.failure}`));
  return out;
}
