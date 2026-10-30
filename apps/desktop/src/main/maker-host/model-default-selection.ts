interface DefaultModelCandidate {
  id: string;
  mode?: string;
  defaultEnabled?: boolean;
  availability?: string;
  costDiscount?: number;
  newSessionDefault?: readonly string[];
  modalities?: { input: readonly string[]; output: readonly string[] };
}

/** Discovery determines membership; explicit upstream defaults determine visibility.
 * A new family, variant or preview must not wait for a client allowlist update.
 * User visibility overrides are applied by the caller afterwards.
 */
export function selectDefaultModels(
  models: readonly DefaultModelCandidate[],
  _providerId?: string,
): ReadonlySet<string> {
  return new Set(models.filter(model =>
    model.defaultEnabled !== false && model.availability !== 'requires_payment' &&
    (!model.mode || model.mode === 'chat' || model.mode === 'responses')
  ).map(model => model.id));
}
