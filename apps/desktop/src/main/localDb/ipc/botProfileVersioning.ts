export function botProfileContentChanged(input: {
  previousCapabilities: Record<string, unknown>;
  nextCapabilities: Record<string, unknown>;
  previousIdentitySource: string;
  nextIdentitySource: string;
}): boolean {
  return (
    JSON.stringify(input.previousCapabilities) !== JSON.stringify(input.nextCapabilities) ||
    input.previousIdentitySource !== input.nextIdentitySource
  );
}

export function mergeBotProfileCapabilities(input: {
  previous: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  skills?: unknown;
  hasSkills: boolean;
}): Record<string, unknown> {
  const next = input.capabilities
    ? { ...input.previous, ...input.capabilities }
    : { ...input.previous };
  if (input.hasSkills) {
    next.skills = Array.isArray(input.skills)
      ? input.skills
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 100)
      : [];
  }
  return next;
}
