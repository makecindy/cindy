import { parseChatInvitationToken } from '@cindy/device-link';
import { useSyncExternalStore } from 'react';

export interface ChatInviteIntent {
  readonly id: number;
  /** Canonical link, or undefined for manual entry. Never a route parameter. */
  readonly link?: string;
  /** Resolved manual target; keep link absent so the sheet remains editable. */
  readonly manualLink?: string;
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

function invitationToken(path: string): string | null {
  // Scheme hints identify the installed app; they never select a server.
  if (/^(cindy|cindycn|cindydev):\/\//i.test(path)) {
    return parseChatInvitationToken(path.replace(/^[^:]+:/, 'cindy:'));
  }
  if (path.startsWith('/')) {
    // Router may strip the scheme on a warm delivery. A public-page path keeps
    // its fragment, whereas the existing native link carries the token in path.
    if (path.split(/[?#]/, 1)[0].endsWith('/chat-invite/join')) {
      return parseChatInvitationToken(`https://invitation.invalid${path}`);
    }
    return parseChatInvitationToken(`cindy:/${path}`);
  }
  if (/^https?:\/\//.test(path)) return parseChatInvitationToken(path);
  return null;
}

/** Automatic discovery accepts only complete links, never bare tokens or malformed clipboard text. */
export function parseChatInviteLink(path: string): string | null {
  if (!/^(https?|cindy|cindycn|cindydev):\/\//i.test(path)) return null;
  if (!isChatInviteLinkPath(path)) return null;
  const token = invitationToken(path);
  return token ? `cindy://chat-invite/${token}` : null;
}

export const getChatInviteSequence = () => sequence;

/** One current invitation, in memory only. Login/account changes retain its target. */
export function receiveChatInviteLink(path: string): boolean {
  if (!isChatInviteLinkPath(path)) return false;
  const token = invitationToken(path);
  // Retain only an empty canonical link for malformed input.
  const link = `cindy://chat-invite/${token ?? ''}`;
  if (current) {
    if ((current.link ?? current.manualLink) !== link && !current.hasOtherInvitation) {
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
  current = { ...current, manualLink };
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
