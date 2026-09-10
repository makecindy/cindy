/** Only public model fields are recorded; credentials and account data never enter this trace. */
export type ModelFieldSource =
  | "public"
  | "provider"
  | "access"
  | "engine"
  | "discovery"
  | "verified"
  | "user"
  | "product"
  | "fallback"
  | "constraint";
export type ModelFieldRecord = {
  source: ModelFieldSource;
  value: unknown;
  reason?: string;
  verifiedAt?: string;
};
export type ModelFieldSources = Record<string, ModelFieldRecord[]>;
export function appendModelFieldSources(
  previous: ModelFieldSources | undefined,
  values: object,
  source: ModelFieldSource,
  details?: Pick<ModelFieldRecord, "reason" | "verifiedAt">,
): ModelFieldSources {
  const result = { ...previous };
  for (const [field, value] of Object.entries(values))
    if (value !== undefined) {
      const record = { source, value, ...details };
      const history = result[field] ?? [];
      // Reassembly of the same snapshot must not grow trace history without bound.
      result[field] = [
        ...history.filter((item) => item.source !== source),
        record,
      ];
    }
  return result;
}
