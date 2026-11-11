/**
 * Pi's thinkingLevelMap is a sparse override, not a list of supported levels.
 * Standard levels default to supported; extended levels require an explicit mapping.
 * Explicit null disables either kind. Shared with the catalog import tool so a refresh
 * cannot reintroduce the same capability loss. See pinned Pi docs/models.md.
 */
export function piSupportedEfforts(model) {
  if (model.reasoning !== true) return [];
  const map = model.thinkingLevelMap;
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].filter((level) => {
    const value = map?.[level];
    return value === undefined
      ? level !== 'xhigh' && level !== 'max'
      : typeof value === 'string';
  });
}
