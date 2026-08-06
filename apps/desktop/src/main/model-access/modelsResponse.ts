import { isModelCurrency, parseListModelsResponseV2 } from '@cindy/model-access-protocol';

import type { ModelAccessGatewayModel } from '../../shared/modelAccess.js';

/** Non-enumerable provenance on the parsed array keeps each wire model entry byte-for-byte intact. */
export function isStrictlyResolvedGatewayModels(
  models: readonly ModelAccessGatewayModel[],
): boolean {
  return (
    (models as readonly ModelAccessGatewayModel[] & { resolvedSource?: unknown }).resolvedSource ===
    true
  );
}

/** Parse ListModels v2 or the pre-S3 unversioned envelope without replacing last-good data. */
export function normalizeGatewayModelsPayload(payload: unknown): ModelAccessGatewayModel[] | null {
  if (
    payload &&
    typeof payload === 'object' &&
    'schemaVersion' in payload &&
    (payload as { schemaVersion?: unknown }).schemaVersion === 2
  ) {
    const parsed = parseListModelsResponseV2(payload);
    if (!parsed.ok) return null;
    const models = parsed.value.models.map((model) => ({
      ...(model as unknown as ModelAccessGatewayModel),
    }));
    Object.defineProperty(models, 'resolvedSource', { value: true, enumerable: false });
    return models;
  }

  // Before S3, the server sent the unversioned { models: [...] } envelope. Keep this
  // tolerant path deliberately narrow: malformed entries are ignored as before, while
  // a syntactically valid empty array remains a successful empty result.
  if (!payload || typeof payload !== 'object') return null;
  const rawModels = (payload as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return null;
  return rawModels
    .filter((model): model is ModelAccessGatewayModel =>
      Boolean(
        model &&
        typeof model === 'object' &&
        typeof (model as { id?: unknown }).id === 'string' &&
        (model as { id: string }).id,
      ),
    )
    .map((model) => {
      const normalized = { ...model };
      // A legacy server may omit currency. Preserve that as unknown so the account-scoped ledger
      // fallback can use its last-known value; stamping the build-region currency onto an upstream
      // quote would turn USD numbers into CNY (or vice versa) without conversion.
      if (!isModelCurrency(normalized.currency)) delete normalized.currency;
      return normalized;
    });
}
