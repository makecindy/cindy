import { useSyncExternalStore } from 'react';
import { parseSharedTaskInvitationIntent, type SharedTaskInvitationIntent } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { buildAgentNetSharingInvitation, parseAgentNetSharingInvitation } from '@cindy/agent-net/portable';

let pending: (SharedTaskInvitationIntent & { expiresAt: number; link?: string }) | null = null;
let stopWatching: (() => void) | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Memory-only intent: login can continue it, but account switching cannot inherit it. */
export function clearSharedTaskInvitationIntent(): void {
  pending = null;
  stopWatching?.(); stopWatching = undefined;
  clearTimeout(expiry); expiry = undefined;
  notify();
}

export function receiveSharedTaskInvitationIntent(url: string): boolean {
  const v2 = parseAgentNetSharingInvitation(url, 'shared-task');
  const value = v2 ? { invitation: v2.receipt.invitation, server: v2.server,
    link: buildAgentNetSharingInvitation(v2.receipt, v2.server) } : parseSharedTaskInvitationIntent(url);
  if (!value) return false;
  clearSharedTaskInvitationIntent();
  let owner = getMobileAuthOwner();
  if (owner.switching) return true;
  pending = { ...value, expiresAt: Date.now() + 15 * 60_000 };
  stopWatching = subscribeMobileAuthOwner(() => {
    const next = getMobileAuthOwner();
    if (next.switching || (owner.accountKey && !isMobileAuthOwnerCurrent(owner))) clearSharedTaskInvitationIntent();
    else if (next.accountKey) owner = next; // The first login claims an unsigned intent.
  });
  expiry = setTimeout(clearSharedTaskInvitationIntent, 15 * 60_000);
  notify();
  return true;
}

export const getPendingSharedTaskInvitationIntent = () => pending;
export const subscribeSharedTaskInvitationIntent = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const usePendingSharedTaskInvitationIntent = () => useSyncExternalStore(subscribeSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent, getPendingSharedTaskInvitationIntent);
