const COMPACTION_ITEM_TYPES: ReadonlySet<string> = new Set([
  "compaction",
  "compaction_summary",
  "context_compaction",
]);

export function isCompactionItemType(type: unknown): boolean {
  return typeof type === "string" && COMPACTION_ITEM_TYPES.has(type);
}

