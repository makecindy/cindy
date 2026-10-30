import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  isMobileAuthOwnerCurrent,
  type MobileAuthOwnerGeneration,
} from "@/auth/authOwnerGeneration";
import type { RemoteSerializedAttachment } from "@/session/types";
import {
  DEFAULT_NEW_SESSION_DRAFT,
  type NewSessionDraft,
  type NewSessionRemoteAgentPick,
} from "./newSession";
import { isRemoteTaskSuggestionId } from "./remoteTaskSuggestionsModel";
import { appendComposerPluginTrigger } from "./composerPlugins";
import {
  composerDocumentProjectedText,
  textComposerDocument,
} from "./composerDocument";

export function readNewSessionRouteString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    Array.isArray(value) &&
    typeof value[0] === "string" &&
    value[0].length > 0
  )
    return value[0];
  return null;
}

export function createInitialNewSessionDraft(input: {
  initialWorkingDir: string | null;
  visualInitialDraft: string | null;
  routeDraft: unknown;
  suggestion: unknown;
  t: (key: string) => string;
}): NewSessionDraft {
  return {
    ...DEFAULT_NEW_SESSION_DRAFT,
    firstMessage:
      input.visualInitialDraft ??
      readNewSessionRouteString(input.routeDraft) ??
      (isRemoteTaskSuggestionId(input.suggestion)
        ? input.t(
            `devices.list.taskSuggestions.items.${input.suggestion}.prompt`,
          )
        : DEFAULT_NEW_SESSION_DRAFT.firstMessage),
    workspaceKind: input.initialWorkingDir ? "project" : "dialogue",
    workingDir: input.initialWorkingDir ?? "",
  };
}

export type NewSessionSelection = { start: number; end: number };
export type NewSessionRemoteAgentChoice = {
  controlledDeviceId: string;
  pick: NewSessionRemoteAgentPick;
  restored?: true;
} | null;

export interface NewSessionDraftRestoreTarget {
  userTouchedWorkspaceRef: RefObject<boolean>;
  userTouchedRuntimeRef: RefObject<boolean>;
  appliedPermissionMemoryRef: RefObject<boolean>;
  runtimeActionSeqRef: RefObject<number>;
  firstMessageRef: RefObject<string>;
  firstMessageSelectionRef: RefObject<NewSessionSelection>;
  attachmentsRef: RefObject<RemoteSerializedAttachment[]>;
  prePlanPermissionModeRef: RefObject<string | null>;
  setRemoteAgentChoice: (choice: NewSessionRemoteAgentChoice) => void;
  setFirstMessageSelection: (selection: NewSessionSelection) => void;
  setAttachments: (files: RemoteSerializedAttachment[]) => void;
  setPlanModeDraftOn: (enabled: boolean) => void;
  setDraft: (draft: NewSessionDraft) => void;
}

/** Restore refs and visible state together, before composer actions can read the draft. */
export function restoreNewSessionDraft(
  target: NewSessionDraftRestoreTarget,
  saved: NewSessionDraft,
  files: RemoteSerializedAttachment[],
  plan?: { enabled: boolean; restorePermissionMode: string | null },
  controlledDeviceId?: string,
): void {
  const { agentDeviceId, ...recovered } = saved;
  target.setRemoteAgentChoice(
    agentDeviceId && controlledDeviceId
      ? {
          controlledDeviceId,
          pick: {
            deviceId: agentDeviceId,
            agentKind: saved.agentKind,
            model: saved.model,
            providerId: saved.providerId,
            effort: saved.effort,
            fastMode: saved.fastMode,
          },
        }
      : null,
  );
  target.userTouchedWorkspaceRef.current = true;
  target.userTouchedRuntimeRef.current = true;
  target.appliedPermissionMemoryRef.current = true;
  target.runtimeActionSeqRef.current += 1;
  target.firstMessageRef.current = recovered.firstMessage;
  const selection = {
    start: recovered.firstMessage.length,
    end: recovered.firstMessage.length,
  };
  target.firstMessageSelectionRef.current = selection;
  target.setFirstMessageSelection(selection);
  target.attachmentsRef.current = files;
  target.setAttachments(files);
  if (plan) {
    target.setPlanModeDraftOn(plan.enabled);
    target.prePlanPermissionModeRef.current = plan.restorePermissionMode;
  }
  target.setDraft(recovered);
}

/** A share claimed by another screen must not suppress this form's draft recovery. */
export function markNewSessionIncomingShare(
  batch: { destination?: string } | null | undefined,
  received: RefObject<boolean>,
): void {
  if (batch?.destination === "new") received.current = true;
}

/** Both normal and goal creation keep the same account-generation boundary. */
export function captureNewSessionOwner(
  owner: MobileAuthOwnerGeneration,
  accountId: string,
) {
  return {
    worktreeAccountId: owner.accountId,
    isCurrentOwner: () =>
      owner.accountId === accountId && isMobileAuthOwnerCurrent(owner),
  };
}

export interface NewSessionDraftEditTarget {
  firstMessageRef: RefObject<string>;
  creatingRef: RefObject<boolean>;
  editRecoveredDraft: (patch: { firstMessage: string }) => unknown;
  voiceDictionaryLearningTrackerRef: RefObject<{
    inspectDraft(text: string): void;
  } | null>;
  setDraft: Dispatch<SetStateAction<NewSessionDraft>>;
}

/** Text input, system shares and plugin insertion all keep durable edits and refs in sync. */
export function patchNewSessionDraft(
  target: NewSessionDraftEditTarget,
  patch: Partial<NewSessionDraft>,
): void {
  if (patch.firstMessage !== undefined) {
    target.firstMessageRef.current = patch.firstMessage;
    if (!target.creatingRef.current)
      target.editRecoveredDraft({ firstMessage: patch.firstMessage });
    target.voiceDictionaryLearningTrackerRef.current?.inspectDraft(
      patch.firstMessage,
    );
  }
  target.setDraft((current) => ({ ...current, ...patch }));
}

export function setNewSessionFirstMessage(
  target: NewSessionDraftEditTarget,
  next: SetStateAction<string>,
): void {
  const value =
    typeof next === "function" ? next(target.firstMessageRef.current) : next;
  // Keep the ordering of the text-input path: publish the draft before dictionary inspection.
  target.firstMessageRef.current = value;
  if (!target.creatingRef.current)
    target.editRecoveredDraft({ firstMessage: value });
  target.setDraft((current) => ({ ...current, firstMessage: value }));
  target.voiceDictionaryLearningTrackerRef.current?.inspectDraft(value);
}

export function appendNewSessionSharedText(
  target: NewSessionDraftEditTarget,
  text: string,
): void {
  setNewSessionFirstMessage(target, (current) =>
    [current, text].filter(Boolean).join("\n\n"),
  );
}

export function openNewSessionPluginPalette(target: {
  firstMessageRef: RefObject<string>;
  patchDraft: (patch: Partial<NewSessionDraft>) => void;
  firstMessageSelectionRef: RefObject<NewSessionSelection>;
  setFirstMessageSelection: (selection: NewSessionSelection) => void;
  focusComposer: () => void;
}): void {
  const next = composerDocumentProjectedText(
    appendComposerPluginTrigger(
      textComposerDocument(target.firstMessageRef.current),
    ),
  );
  target.patchDraft({ firstMessage: next });
  const selection = { start: next.length, end: next.length };
  target.firstMessageSelectionRef.current = selection;
  target.setFirstMessageSelection(selection);
  target.focusComposer();
}
