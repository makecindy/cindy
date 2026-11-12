/** Events a plugin may publish; saving a matching Routine remains a separate user action. */
export interface GhostRoutineEvents {
  events: Array<{ type: string; name: string; fields: string[] }>;
}

export function parseGhostRoutineEvents(
  raw: unknown,
): GhostRoutineEvents | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const events = (raw as Record<string, unknown>).events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 32)
    return null;
  const output: GhostRoutineEvents["events"] = [];
  const seen = new Set<string>();
  for (const item of events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { type, name, fields } = item as Record<string, unknown>;
    if (
      typeof type !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(type) ||
      seen.has(type)
    )
      return null;
    if (typeof name !== "string" || !name.trim() || name.length > 200)
      return null;
    if (
      !Array.isArray(fields) ||
      fields.length > 32 ||
      fields.some(
        (field) =>
          typeof field !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(field),
      )
    )
      return null;
    if (new Set(fields).size !== fields.length) return null;
    output.push({ type, name, fields: fields as string[] });
    seen.add(type);
  }
  return { events: output };
}
