/** A hidden saved selection needs an explicit replacement; never silently reroute it. */
export function modelNeedsReselection(
  visibility: Readonly<Record<string, boolean>> | null | undefined,
  agent: string,
  model: string,
  providerId: string | null | undefined,
): boolean {
  if (!visibility || !model) return false;
  if (providerId) return visibility[`${agent}:${providerId}:${model}`] === false;
  // A default-source selection is usable while at least one source still exposes it.
  const offerings = Object.entries(visibility).filter(([key]) =>
    key.startsWith(`${agent}:`) && key.endsWith(`:${model}`));
  return offerings.length > 0 && offerings.every(([, visible]) => !visible);
}
