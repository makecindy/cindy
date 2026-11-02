import { parseChatInvitationShareId, parseChatInvitationToken } from '@cindy/device-link';
import { useSyncExternalStore } from 'react';

export interface ChatInviteIntent {
  readonly id: number;
  /** Canonical link, or undefined for manual entry. Never a route parameter. */
  readonly link?: string;
  /** Resolved manual target; keep link absent so the sheet remains editable. */
  readonly manualLink?: string;
  /** Original share reference remains an alias of the resolved manual target. */
  readonly manualSourceLink?: string;
  readonly hasOtherInvitation: boolean;
}

let current: ChatInviteIntent | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Includes malformed invitations, so even a truncated token never reaches a 404 route. */
export function isChatInviteLinkPath(path: string): boolean {
  const beforePayload = path.split(/[?#]/, 1)[0];
  return /(?:^|\/)chat-invite(?:\/|$)/i.test(beforePayload);
}

function invitationLink(path: string): string | null {
  const token = parseChatInvitationToken(path.startsWith('/') ? `cindy:/${path}` : path);
  if (token) return `cindy://chat-invite/${token}`;
  return parseChatInvitationShareId(path) ? path.trim() : null;
}

function sameInvitation(left: string | undefined, right: string): boolean {
  if (left === right) return true;
  const shareId = parseChatInvitationShareId(left ?? '');
  return shareId !== null && shareId === parseChatInvitationShareId(right);
}

/** Automatic discovery accepts only complete links, never bare tokens or malformed clipboard text. */
export function parseChatInviteLink(path: string): string | null {
  if (!/^(https?|cindy|cindycn|cindydev):\/\//i.test(path)) return null;
  if (!isChatInviteLinkPath(path)) return null;
  return invitationLink(path);
}

export const getChatInviteSequence = () => sequence;

/** One current invitation, in memory only. Login/account changes retain its target. */
export function receiveChatInviteLink(path: string): boolean {
  if (!isChatInviteLinkPath(path)) return false;
  // Retain only an empty canonical link for malformed input.
  const link = invitationLink(path) ?? 'cindy://chat-invite/';
  if (current) {
    if (!sameInvitation(current.link ?? current.manualLink, link) && !sameInvitation(current.manualSourceLink, link) && !current.hasOtherInvitation) {
      current = { ...current, hasOtherInvitation: true };
      notify();
    }
    return true;
  }
  current = { id: ++sequence, link, hasOtherInvitation: false };
  notify();
  return true;
}

/** The Home entry and native links share the same host; never stack two sheets. */
export function openManualChatInvite(): void {
  if (current) return;
  current = { id: ++sequence, hasOtherInvitation: false };
  notify();
}

export function setManualChatInviteLink(id: number, link?: string): void {
  if (current?.id !== id || current.link !== undefined) return;
  const manualLink = link ? parseChatInviteLink(link) ?? undefined : undefined;
  if (current.manualLink === manualLink) return;
  const manualSourceLink = !manualLink || parseChatInvitationShareId(manualLink) ? undefined
    : parseChatInvitationShareId(current.manualLink ?? '') ? current.manualLink : current.manualSourceLink;
  current = { ...current, manualLink, manualSourceLink };
  notify();
}

/** Stale sheet callbacks cannot close a newer invitation. */
export function closeChatInvite(id: number): void {
  if (current?.id !== id) return;
  current = null;
  notify();
}

export const getChatInviteIntent = () => current;
export function subscribeChatInviteIntent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const useChatInviteIntent = () => useSyncExternalStore(
  subscribeChatInviteIntent, getChatInviteIntent, getChatInviteIntent,
);
