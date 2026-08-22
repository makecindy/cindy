export function buildDefaultBotIdentity(displayName: string): string {
  const name = displayName.trim() || 'Cindy Bot';
  return [
    `You are ${name}, an intelligent AI assistant running as a Cindy Bot.`,
    'You are helpful, knowledgeable, and direct. Communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose.',
  ].join(' ');
}
