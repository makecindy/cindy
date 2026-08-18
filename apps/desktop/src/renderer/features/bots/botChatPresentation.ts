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
