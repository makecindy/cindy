import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormField } from '@/components/ui/form-field';
import { SettingsTextInput } from './SettingsTextInput';

/** Shared native field; local and cloud callers own storage and save semantics. */
export function McpTokenField({
  id,
  value,
  onChange,
  hasToken,
  placeholder,
  hint,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  hasToken: boolean;
  placeholder: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  return (
    <FormField
      id={id}
      label={t('settings.mcp.fields.token')}
      hint={hint ?? t('settings.mcp.fields.tokenHelp')}
      labelAction={
        hasToken && (
          <span className="flex items-center gap-1 rounded-full bg-[var(--settings-btn-secondary-bg)] px-2 py-0.5 text-11 font-medium text-[var(--settings-section-desc)]">
            <Check size={11} />
            {t('settings.mcp.fields.tokenSaved')}
          </span>
        )
      }
    >
      {(control) => (
        <SettingsTextInput
          data-settings-search-action="Enter the token of the MCP server being edited"
          {...control}
          surface="ivory"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          secret
        />
      )}
    </FormField>
  );
}
