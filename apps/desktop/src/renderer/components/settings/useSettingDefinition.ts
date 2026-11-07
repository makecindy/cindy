import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SettingsSearchEntry } from './settingsSearchTypes';

/** Presentation only: existing controls keep their state, layout and persistence. */
export function useSettingDefinition<T extends SettingsSearchEntry>(
  definition: T,
  translate?: TFunction,
) {
  const { t: defaultTranslate } = useTranslation();
  const t = translate ?? defaultTranslate;
  return {
    title: t(definition.titleKey),
    description: definition.descriptionKey ? t(definition.descriptionKey) : '',
    anchorProps: { id: definition.targetId },
    controlProps: { 'data-setting-id': definition.id },
    options: (definition.options ?? []).map(({ value, labelKey }) => ({
      value: value as NonNullable<T['options']>[number]['value'],
      label: t(labelKey),
    })),
  };
}
