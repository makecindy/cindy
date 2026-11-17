import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TemplateParameter } from '@cindy/maker-scheduler';

import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

interface TemplateParamFormProps {
  parameters: TemplateParameter[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

export function TemplateParamForm({ parameters, values, onChange }: TemplateParamFormProps) {
  const { t } = useTranslation();
  if (parameters.length === 0) return null;

  const setValue = (key: string, value: string) => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta)]">
        {t('scheduler.template.params.heading')}
      </h3>
      {parameters.map((parameter) => (
        <label key={parameter.key} className="flex flex-col gap-1.5">
          <span className="text-12 leading-[1.33] text-[var(--settings-section-desc)]">
            {parameter.label}
            {parameter.required && <span className="ml-1 text-[var(--cmd-palette-item-meta)]">*</span>}
          </span>
          <TemplateParamControl
            parameter={parameter}
            value={values[parameter.key] ?? ''}
            onChange={(value) => setValue(parameter.key, value)}
          />
        </label>
      ))}
    </div>
  );
}

function TemplateParamControl({
  parameter,
  value,
  onChange,
}: {
  parameter: TemplateParameter;
  value: string;
  onChange: (value: string) => void;
}) {
  const placeholder = parameter.placeholder ?? parameter.default ?? '';
  if (parameter.type === 'boolean') {
    const checked = value === 'true';
    // The parameter row is already a label (TemplateParamForm), so this row stays a span:
    // one label owns the checkbox.
    return (
      <span
        className={cn(
          'inline-flex h-9 w-fit items-center gap-2 rounded-md px-1.5',
          'cursor-pointer',
          'text-13 leading-none text-[var(--settings-btn-secondary-text)]',
          'transition-colors hover:bg-[var(--surface-hover)]',
        )}
      >
        <Checkbox checked={checked} onChange={() => onChange(checked ? 'false' : 'true')} />
        {parameter.placeholder ?? parameter.label}
      </span>
    );
  }

  if (parameter.type === 'select') {
    return (
      <div className="relative flex h-9 items-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-full w-full appearance-none bg-transparent pr-6 text-13 text-[var(--settings-input-text)] outline-none"
        >
          <option value="">{placeholder}</option>
          {(parameter.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDown size={13} className="pointer-events-none absolute right-3 text-[var(--cmd-palette-item-meta)]" />
      </div>
    );
  }

  return (
    <div className="flex h-9 items-center rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] px-3">
      <input
        type="text"
        inputMode={parameter.type === 'number' ? 'numeric' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'w-full bg-transparent text-13 font-normal outline-none',
          'text-[var(--settings-input-text)] placeholder-[var(--settings-input-placeholder)]',
          'select-text',
        )}
      />
    </div>
  );
}
