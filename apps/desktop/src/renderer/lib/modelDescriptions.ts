import type { TFunction } from 'i18next';

import { modelDescriptionKey } from '../../shared/modelDescriptionKey';

export { modelDescriptionKey };

export function localizedModelDescription(
  model: { id: string; group?: string; mode?: string },
  t: TFunction,
): string | undefined {
  const key = modelDescriptionKey(model);
  if (!key) return undefined;
  return t(`modelDescriptions.${key}`, { defaultValue: '' }) || undefined;
}
