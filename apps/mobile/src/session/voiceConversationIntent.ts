import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
} from '@/auth/authOwnerGeneration';

export interface VoiceConversationIntent {
  readonly id: string;
  readonly expiresAt: number;
}

export interface VoiceConversationSessionHandoff {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly clientId: string;
}

type Launch = {
  intent: VoiceConversationIntent;
  phase: 'pending' | 'claimed' | 'handoff';
  handoff?: VoiceConversationSessionHandoff;
};

const INTENT_LIFETIME_MS = 15 * 60_000;
const processId = Math.random().toString(36).slice(2);
let sequence = 0;
let launch: Launch | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;
let stopWatching: (() => void) | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Only the registered app schemes and their Router-relative form open the mic entry. */
export function isVoiceConversationLink(path: string): boolean {
  const scheme = /^([a-zA-Z][\w+.-]*):\/\//.exec(path);
  if (scheme && !['cindy', 'cindycn', 'cindydev', 'xdt-maker'].includes(scheme[1]!.toLowerCase())) return false;
  const route = scheme ? path.slice(scheme[0].length) : path;
  return /^\/?voice\/?$/.test(route);
}

/** Memory only: restored route parameters cannot authorize a fresh microphone start. */
export function clearVoiceConversationIntent(id?: string): void {
  if (!launch || (id !== undefined && launch.intent.id !== id)) return;
  launch = null;
  clearTimeout(expiry);
  expiry = undefined;
  stopWatching?.();
  stopWatching = undefined;
  notify();
}

function scheduleExpiry(): void {
  clearTimeout(expiry);
  expiry = setTimeout(clearVoiceConversationIntent, INTENT_LIFETIME_MS);
}

/** Screen cleanup must not remove the handoff its destination is about to claim. */
export function clearUntransferredVoiceConversationIntent(id: string): void {
  if (launch?.phase !== 'handoff') clearVoiceConversationIntent(id);
}

export function receiveVoiceConversationIntent(path: string): VoiceConversationIntent | null {
  if (Platform.OS !== 'ios' || !isVoiceConversationLink(path)) return null;
  clearVoiceConversationIntent();
  let owner = getMobileAuthOwner();
  if (owner.switching) return null;
  const intent = {
    id: `${processId}-${++sequence}`,
    expiresAt: Date.now() + INTENT_LIFETIME_MS,
  };
  launch = { intent, phase: 'pending' };
  stopWatching = subscribeMobileAuthOwner(() => {
    const next = getMobileAuthOwner();
    if (next.switching || (owner.accountKey && !isMobileAuthOwnerCurrent(owner))) {
      clearVoiceConversationIntent();
    } else if (next.accountKey) {
      // A first login may claim a launch received on the signed-out screen.
      owner = next;
    }
  });
  scheduleExpiry();
  notify();
  return intent;
}

export function voiceConversationIntentHref(intent: VoiceConversationIntent): string {
  return `/sessions/new?voiceConversation=${encodeURIComponent(intent.id)}`;
}

function currentLaunch(id: string, phase: Launch['phase']): Launch | null {
  if (Platform.OS !== 'ios' || !launch || launch.intent.id !== id || launch.phase !== phase) return null;
  if (launch.intent.expiresAt <= Date.now()) {
    clearVoiceConversationIntent(id);
    return null;
  }
  const owner = getMobileAuthOwner();
  return owner.accountKey && !owner.switching ? launch : null;
}

/** Claim once, after login, foreground and page readiness, before requesting the mic. */
export function takeVoiceConversationIntent(id: string): boolean {
  const current = currentLaunch(id, 'pending');
  if (!current) return false;
  current.phase = 'claimed';
  notify();
  return true;
}

/** Keep the first sent message attached to the same launch across new-task navigation. */
export function transferVoiceConversationToSession(
  id: string,
  target: VoiceConversationSessionHandoff,
): boolean {
  const current = currentLaunch(id, 'claimed');
  if (!current || !target.sessionId || !target.deviceId || !target.clientId) return false;
  current.phase = 'handoff';
  current.handoff = { ...target };
  current.intent = { ...current.intent, expiresAt: Date.now() + INTENT_LIFETIME_MS };
  scheduleExpiry();
  return true;
}

export function takeVoiceConversationSessionHandoff(
  id: string,
  target: Pick<VoiceConversationSessionHandoff, 'sessionId' | 'deviceId'>,
): VoiceConversationSessionHandoff | null {
  const current = currentLaunch(id, 'handoff');
  const handoff = current?.handoff;
  if (!handoff || handoff.sessionId !== target.sessionId || handoff.deviceId !== target.deviceId) return null;
  clearVoiceConversationIntent(id);
  return handoff;
}

export const getPendingVoiceConversationIntent = (): VoiceConversationIntent | null =>
  Platform.OS === 'ios' && launch?.phase === 'pending' ? launch.intent : null;

export function subscribeVoiceConversationIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const usePendingVoiceConversationIntent = () => useSyncExternalStore(
  subscribeVoiceConversationIntent,
  getPendingVoiceConversationIntent,
  getPendingVoiceConversationIntent,
);
