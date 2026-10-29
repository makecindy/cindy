/** Host-authored facts about methods invoked in one completed reply. No tool arguments or paths. */
export interface TurnResourceReceipt {
  kind: 'workflow' | 'skill' | 'plugin';
  id: string;
  name: string;
}

/** Additive metadata: old, malformed and unknown entries remain invisible. */
export function readTurnResources(value: unknown): TurnResourceReceipt[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const resources: TurnResourceReceipt[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { kind, id, name } = item as Record<string, unknown>;
    if (kind !== 'workflow' && kind !== 'skill' && kind !== 'plugin') continue;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)) continue;
    if (typeof name !== 'string' || !name.trim() || name.length > 120
      || /[\u0000-\u001f\u007f]/.test(name)) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push({ kind, id, name: name.trim() });
  }
  return resources;
}
