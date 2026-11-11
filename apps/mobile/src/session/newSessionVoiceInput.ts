import type { RefObject } from "react";
import type { MobileComposerInputRowProps } from "./MobileComposerInputRow";
import type { MobileVoiceControllerSession } from "./mobileVoiceController";
import type { MobileVoiceState } from "./mobileVoiceInput";

type Selection = { start: number; end: number };

const hiddenVoiceInputStyle = { color: "transparent" };
// Android Fabric can treat transparent as unset; keep layout and presses.
const hiddenAndroidVoiceInputStyle = { ...hiddenVoiceInputStyle, opacity: 0 };

export interface NewSessionVoiceSelectionInput {
  voiceSelectionUserOwnedRef: RefObject<boolean>;
  voiceRecordingActiveRef: RefObject<boolean>;
  voiceStopInFlightRef: RefObject<boolean>;
  voiceStopGestureSelectionGuardRef: RefObject<boolean>;
  voicePendingSelectionEchoesRef: RefObject<Selection[]>;
  firstMessageRef: RefObject<string>;
  firstMessageSelectionRef: RefObject<Selection>;
  setFirstMessageSelection(selection: Selection): void;
  setFirstMessageDraft(text: string): void;
}

/** Follow ASR until a native edit claims the caret, then rebase it with the voice range. */
export function publishNewSessionVoiceDraft(
  input: NewSessionVoiceSelectionInput,
  text: string,
  selection?: Selection,
  replacement?: Selection & { text: string },
): void {
  let nextSelection = input.voiceSelectionUserOwnedRef.current
    ? undefined
    : selection;
  if (input.voiceSelectionUserOwnedRef.current && replacement) {
    const replacementEnd = replacement.start + replacement.text.length;
    const rebaseOffset = (offset: number) => {
      if (offset <= replacement.start) return offset;
      if (offset >= replacement.end)
        return offset + replacementEnd - replacement.end;
      return Math.min(offset, replacementEnd);
    };
    const current = input.firstMessageSelectionRef.current;
    nextSelection = {
      start: rebaseOffset(current.start),
      end: rebaseOffset(current.end),
    };
  }
  if (nextSelection) {
    const previous = input.firstMessageSelectionRef.current;
    if (
      nextSelection.start !== previous.start ||
      nextSelection.end !== previous.end
    ) {
      input.voicePendingSelectionEchoesRef.current.push(nextSelection);
    }
    input.firstMessageSelectionRef.current = nextSelection;
    input.setFirstMessageSelection(nextSelection);
  }
  input.setFirstMessageDraft(text);
}

export function changeNewSessionVoiceText(
  input: NewSessionVoiceSelectionInput,
  text: string,
): void {
  if (text !== input.firstMessageRef.current) {
    input.voicePendingSelectionEchoesRef.current = [];
    if (input.voiceStopInFlightRef.current)
      input.voiceSelectionUserOwnedRef.current = true;
  }
  input.setFirstMessageDraft(text);
}

export function changeNewSessionVoiceSelection(
  input: NewSessionVoiceSelectionInput,
  selection: Selection,
): void {
  if (
    !input.voiceRecordingActiveRef.current &&
    input.voiceStopGestureSelectionGuardRef.current
  ) {
    input.voiceStopGestureSelectionGuardRef.current = false;
    return;
  }
  // Native may echo an earlier controlled update after JS publishes the next one,
  // even after stop resolves. A newer acknowledgement retires coalesced old echoes.
  const pending = input.voicePendingSelectionEchoesRef.current;
  const echoIndex = pending.findIndex(
    (value) => value.start === selection.start && value.end === selection.end,
  );
  if (echoIndex >= 0) {
    pending.splice(0, echoIndex + 1);
    return;
  }
  // Stop marks recording inactive before awaiting ASR/refinement teardown.
  if (!input.voiceRecordingActiveRef.current) {
    input.voicePendingSelectionEchoesRef.current = [];
    const previous = input.firstMessageSelectionRef.current;
    if (
      input.voiceStopInFlightRef.current &&
      (selection.start !== previous.start || selection.end !== previous.end)
    ) {
      input.voiceSelectionUserOwnedRef.current = true;
    }
    input.firstMessageSelectionRef.current = selection;
    input.setFirstMessageSelection(selection);
  }
}

export interface NewSessionVoiceStopInput {
  voiceStopInFlightRef: RefObject<boolean>;
  voiceControllerSessionRef: RefObject<Pick<
    MobileVoiceControllerSession,
    "stop"
  > | null>;
  voiceRecordingActiveRef: RefObject<boolean>;
  voiceState: MobileVoiceState;
  voiceStartupSeqRef: RefObject<number>;
  voiceStartupInFlightRef: RefObject<boolean>;
  firstMessageSelectionRef: RefObject<Selection>;
  firstMessageInputRef: RefObject<{
    setNativeProps(props: { selection: Selection }): void;
  } | null>;
  setVoiceState(state: MobileVoiceState): void;
  setVoiceError(message: string | null): void;
  requestAnimationFrame(callback: () => void): unknown;
  formatRemoteError(error: unknown): string;
}

/** Preserve the existing stop ownership and final native caret handoff. */
export async function finishNewSessionVoiceRecording(
  input: NewSessionVoiceStopInput,
): Promise<string | null> {
  if (input.voiceStopInFlightRef.current) return null;
  const controller = input.voiceControllerSessionRef.current;
  if (!controller) return null;
  if (
    !input.voiceRecordingActiveRef.current &&
    input.voiceState !== "listening"
  )
    return null;
  input.voiceStartupSeqRef.current += 1;
  input.voiceStartupInFlightRef.current = false;
  input.voiceStopInFlightRef.current = true;
  input.voiceControllerSessionRef.current = null;
  input.voiceRecordingActiveRef.current = false;
  input.setVoiceState("submitting");
  input.setVoiceError(null);
  try {
    const latestDraft = await controller.stop();
    input.setVoiceState("done");
    input.requestAnimationFrame(() => {
      input.firstMessageInputRef.current?.setNativeProps({
        selection: input.firstMessageSelectionRef.current,
      });
    });
    return latestDraft;
  } catch (err) {
    input.voiceControllerSessionRef.current = null;
    input.voiceRecordingActiveRef.current = false;
    input.setVoiceState("error");
    input.setVoiceError(input.formatRemoteError(err));
    return null;
  } finally {
    input.voiceStopInFlightRef.current = false;
  }
}

export interface NewSessionVoiceComposerInput {
  platform: string;
  voiceIsListening: boolean;
  firstMessage: string;
  firstMessageSelection: Selection;
  composerPlaceholder: string;
  voiceStopGestureSelectionGuardRef: RefObject<boolean>;
  voicePendingSelectionEchoesRef: RefObject<Selection[]>;
  finishVoiceRecording(): unknown;
}

/** Keep the same native input mounted while Android draws the streamed overlay. */
export function newSessionVoiceComposerProps(
  input: NewSessionVoiceComposerInput,
) {
  return {
    inputStyle:
      input.voiceIsListening && input.platform !== "ios"
        ? input.platform === "android"
          ? hiddenAndroidVoiceInputStyle
          : hiddenVoiceInputStyle
        : undefined,
    caretHidden: input.voiceIsListening,
    value: input.firstMessage,
    placeholder: input.voiceIsListening ? "" : input.composerPlaceholder,
    selection: input.firstMessageSelection,
    onKeyPress: () => {
      input.voicePendingSelectionEchoesRef.current = [];
    },
    onPressIn: () => {
      if (input.voiceIsListening) {
        input.voiceStopGestureSelectionGuardRef.current = true;
        setTimeout(() => {
          input.voiceStopGestureSelectionGuardRef.current = false;
        }, 0);
        void input.finishVoiceRecording();
      } else {
        // Editing can intentionally return to an old controlled selection value.
        input.voicePendingSelectionEchoesRef.current = [];
      }
    },
  } satisfies Pick<
    MobileComposerInputRowProps,
    | "inputStyle"
    | "caretHidden"
    | "value"
    | "placeholder"
    | "selection"
    | "onPressIn"
    | "onKeyPress"
  >;
}
