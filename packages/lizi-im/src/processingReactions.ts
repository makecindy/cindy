/** Processing variants shared by transports; select once when entering processing. */
export const PROCESSING_REACTION_POOL = ['👨‍💻', '🤔', '🤓', '✍'] as const;
// Feishu requires native emoji_type names rather than Unicode reactions.
const FEISHU_PROCESSING_REACTION_POOL = ['Typing', 'THINKING', 'SMART', 'OnIt'] as const;

export function processingReaction(emoji: string, random: () => number = Math.random): string {
  const pool =
    emoji === '👨‍💻'
      ? PROCESSING_REACTION_POOL
      : emoji === 'Typing'
        ? FEISHU_PROCESSING_REACTION_POOL
        : null;
  return pool === null ? emoji : pool[Math.floor(random() * pool.length)];
}
