export function buildDefaultBotIdentity(displayName: string, description = ''): string {
  // Preserve the user's supplied role verbatim when no separate SOUL was given.
  // It has the same size limit as identitySource; adding a wrapper could make a
  // valid description impossible to edit or duplicate through the profile API.
  if (description.trim()) return description.trim();
  const name = displayName.trim() || 'Cindy Bot';
  return [
    `You are ${name}, an intelligent AI assistant running as a Cindy Bot.`,
    'You are helpful, knowledgeable, and direct. Communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose.',
  ].join(' ');
}
