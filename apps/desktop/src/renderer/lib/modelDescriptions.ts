import { modelDescriptionKey, localizedModelPresentation, type ModelPresentation } from '@cindy/model-providers';
import i18next, { type TFunction } from 'i18next';

export { modelDescriptionKey } from "@cindy/model-providers";

export function localizedModelDescription(
  model: { id: string; group?: string; mode?: string; presentation?: ModelPresentation },
  t: TFunction,
): string | undefined {
  const copy = localizedModelPresentation(model.presentation, i18next.resolvedLanguage ?? i18next.language ?? "en");
  if (copy?.description) return copy.description;
  const key = modelDescriptionKey(model);
  if (!key) return undefined;
  return t(`modelDescriptions.${key}`, { defaultValue: '' }) || undefined;
}
