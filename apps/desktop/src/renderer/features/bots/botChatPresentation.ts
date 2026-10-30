import type { BotChatIdentity } from './BotSessionContentHeader';

/**
 * Pure presentation rules for a teammate's chat, kept out of the 5k-line session
 * view so they are cheap to test.
 */

/**
 * Latin-script names take spaces around them in a CJK sentence ("跟 Melody 说点
 * 什么…"), Chinese names do not ("跟小柴说点什么…"). Typography, not i18n: the
 * spacing depends on the *name*, while the sentence around it depends on the
 * locale — so the catalog carries both shapes and this picks one.
 */
export function isLatinBotName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return /^[\x20-\x7E]+$/.test(trimmed);
}

/** i18n key for the composer placeholder of a Bot chat. */
export function botComposerPlaceholderKey(name: string): string {
  return isLatinBotName(name)
    ? 'bots.chat.composerPlaceholderLatin'
    : 'bots.chat.composerPlaceholder';
}

/** The route gate supplies this only after checking the durable Bot/session link. */
export type BotChatBinding = BotChatIdentity & { sessionId: string };

/** Runtime snapshots can disappear during hydration/reconnect; ownership does not. */
export function resolveBotChatIdentity(
  binding: BotChatBinding | undefined,
  sessionId: string | undefined,
): BotChatIdentity | null {
  return binding && binding.sessionId === sessionId ? binding : null;
}

/**
 * The first hello of a just-invited teammate is composed by the host while the chat is already open.
 * Show that wait only while it is the truth: the invitation is still at its welcome stage, history has
 * loaded, and nothing — the opening, a welcome turn or the user's own message — is in the chat yet.
 */
export function isBotOpeningPending(input: {
  invitationStage: string | undefined;
  historyLoaded: boolean;
  messageCount: number;
}): boolean {
  return input.invitationStage === 'welcome' && input.historyLoaded && input.messageCount === 0;
}
