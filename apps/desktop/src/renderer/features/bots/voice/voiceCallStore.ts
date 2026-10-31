import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  VoiceCallCommand,
  VoiceCallStatus,
  VoiceCallStatusUpdate,
} from '@/../shared/voiceConversation';
import type { VoiceQuestionBridge } from '@/components/new-chat/voiceQuestionSelection';

/** Where one window can show the call of a task it currently has on screen. */
export type VoiceCallSlot = {
  element: HTMLElement;
  openTask(clientId: string): void;
  questionBridge: VoiceQuestionBridge;
};
/** Stable between audio frames, so task pages do not rerender with the level meter. */
export type VoiceCallSummary = {
  open: boolean;
  botName: string | null;
  sessionId: string | null;
  callId: string | null;
};

const CLOSED: VoiceCallSummary = { open: false, botName: null, sessionId: null, callId: null };

let status: VoiceCallStatus | null = null;
let summary = CLOSED;
let removeRemote: (() => void) | null = null;
let localCommands: ((command: VoiceCallCommand) => boolean) | null = null;
let floatingSlot: HTMLElement | null = null;
const slots = new Map<string, VoiceCallSlot>();
const statusListeners = new Set<() => void>();
const slotListeners = new Set<() => void>();

function notify(listeners: Set<() => void>): void {
  for (const listener of listeners) listener();
}

function setStatus(next: VoiceCallStatus | null): void {
  status = next;
  const open = next?.open ?? false;
  if (
    summary.open !== open ||
    summary.sessionId !== (next?.sessionId ?? null) ||
    summary.callId !== (next?.callId ?? null) ||
    summary.botName !== (next?.bot.name ?? null)
  )
    summary = next
      ? { open, botName: next.bot.name, sessionId: next.sessionId, callId: next.callId }
      : CLOSED;
  notify(statusListeners);
}

function applyRemote(update: VoiceCallStatusUpdate): void {
  if ('status' in update) setStatus(update.status);
  else if (status) setStatus({ ...status, state: { ...status.state, level: update.level } });
}

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  if (!removeRemote) {
    const api = window.electronAPI?.voiceConversation;
    removeRemote = api?.onCallStatus?.(applyRemote) ?? (() => {});
    // A window opened mid-call must show it without waiting for the next update.
    void api?.callStatus?.().then(
      (current) => {
        if (current && !status) setStatus(current);
      },
      () => undefined,
    );
  }
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size) return;
    removeRemote?.();
    removeRemote = null;
  };
}

/** The main window's call host is the source of the status it publishes. */
export function installVoiceCallHost(
  handleCommand: (command: VoiceCallCommand) => boolean,
): () => void {
  localCommands = handleCommand;
  return () => {
    if (localCommands === handleCommand) localCommands = null;
    setStatus(null);
  };
}

export const publishVoiceCallStatus = setStatus;

/** Local in the main window, otherwise routed there by Main. */
export async function sendVoiceCallCommand(command: VoiceCallCommand): Promise<boolean> {
  if (localCommands) return localCommands(command);
  const result = await window.electronAPI.voiceConversation.callCommand(command);
  return result.ok;
}

export function getVoiceCallStatus(): VoiceCallStatus | null {
  return status;
}

export function useVoiceCallStatus(): VoiceCallStatus | null {
  return useSyncExternalStore(subscribeStatus, () => status);
}

export function useVoiceCallSummary(): VoiceCallSummary {
  return useSyncExternalStore(subscribeStatus, () => summary);
}

function subscribeSlots(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => slotListeners.delete(listener);
}

export function useVoiceCallSlot(sessionId: string | null | undefined): VoiceCallSlot | null {
  return useSyncExternalStore(
    subscribeSlots,
    () => (sessionId ? slots.get(sessionId) : null) ?? null,
  );
}

export function useFloatingVoiceCallSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribeSlots, () => floatingSlot);
}

export function registerVoiceCallSlot(sessionId: string, slot: VoiceCallSlot): () => void {
  slots.set(sessionId, slot);
  notify(slotListeners);
  return () => {
    if (slots.get(sessionId) !== slot) return;
    slots.delete(sessionId);
    notify(slotListeners);
  };
}

/** Publishes a mounted element after commit, so portals never target a detached node. */
export function useFloatingVoiceCallSlotElement(): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    floatingSlot = element;
    notify(slotListeners);
    return () => {
      if (floatingSlot !== element) return;
      floatingSlot = null;
      notify(slotListeners);
    };
  }, [element]);
  return setElement;
}
