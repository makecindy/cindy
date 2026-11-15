import { Button } from '@/components/ui/button';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { unquoteFontFamily } from './fontFamilyValue';
import { SettingsTextInput } from './SettingsTextInput';

export interface FontPreset {
  id: string;
  labelKey: string;
  family: string;
}

type FontOption = { id: string; label: string; family: string };

hljs.registerLanguage('typescript', typescript);

/**
 * 字体选择器只画整宽的选择按钮和弹层；名称、说明由外层 SettingsField 负责，
 * 「恢复默认」按钮用 FontFamilyResetButton 放在 SettingsField 的 action 里。
 */
interface FontFamilyPickerProps {
  'data-setting-id'?: string;
  ariaLabel: string;
  value: string;
  presets: FontPreset[];
  previewSample: string;
  previewLanguage?: string;
  previewFallbackFamily: string;
  onChange: (family: string) => void;
}

/** 字体选择的「恢复默认」：只在有自定义字体时出现（单项还原，见 DefaultOverrideControls）。 */
export function FontFamilyResetButton({ value, onReset }: { value: string; onReset: () => void }) {
  return <DefaultOverrideControls isCustomized={Boolean(value.trim())} onReset={onReset} />;
}

export function FontFamilyPicker({
  'data-setting-id': settingId,
  ariaLabel,
  value,
  presets,
  previewSample,
  previewLanguage,
  previewFallbackFamily,
  onChange,
}: FontFamilyPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState(value);
  const [previewFamily, setPreviewFamily] = useState<string | null>(null);

  useEffect(() => {
    setCustomValue(value);
  }, [value]);

  useEffect(() => {
    if (!open) setPreviewFamily(null);
  }, [open]);

  const presetOptions = useMemo<FontOption[]>(
    () =>
      presets.map((preset) => ({
        id: preset.id,
        label: t(preset.labelKey),
        family: preset.family,
      })),
    [presets, t],
  );

  const selectedLabel = useMemo(() => {
    const normalized = value.trim();
    const preset = presetOptions.find((option) => option.family === normalized);
    if (preset) return preset.label;
    if (!normalized) return t('settings.appearance.font.defaultPreset');
    // 自定义值可能保留用户手写的 CSS 引号;显示前剥掉,避免触发按钮露出字面引号。
    return unquoteFontFamily(normalized);
  }, [presetOptions, t, value]);

  const handleSelect = (family: string) => {
    onChange(family);
    setOpen(false);
  };

  const buildPreviewFamily = (family: string) => {
    const trimmed = family.trim();
    return trimmed ? `${trimmed}, ${previewFallbackFamily}` : previewFallbackFamily;
  };

  const activePreviewFamily = buildPreviewFamily(previewFamily ?? value);
  const customPreview = customValue.trim() || value.trim();
  const highlightedPreviewHtml = useMemo(() => {
    if (!previewLanguage) return null;
    try {
      return hljs.highlight(previewSample, {
        language: previewLanguage,
        ignoreIllegals: true,
      }).value;
    } catch {
      return null;
    }
  }, [previewLanguage, previewSample]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Same frame as the shared Select trigger: 36px secondary pill. */}
        <Button
          variant="secondary"
          size="lg"
          pressFeedback={false}
          aria-label={ariaLabel}
          data-setting-id={settingId}
          className="w-full min-w-0 justify-between gap-2 px-3 font-normal"
        >
          <span className="min-w-0 truncate text-left">
            {selectedLabel}
          </span>
          <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'w-[min(var(--radix-popover-trigger-width),560px)] rounded-xl p-2',
          'border border-[var(--settings-input-border)]',
          'bg-[var(--settings-theme-card-bg)] shadow-[shadow:var(--shadow-menu)]',
        )}
        onMouseLeave={() => setPreviewFamily(null)}
      >
        <div className="flex flex-col gap-2">
          <div
            className={cn(
              'rounded-xl border px-3 py-2',
              'border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
              'text-13 leading-[1.45] text-[var(--settings-input-text)]',
              'whitespace-pre-wrap break-words',
            )}
            style={{ fontFamily: activePreviewFamily }}
          >
            {highlightedPreviewHtml ? (
              <code
                className="block whitespace-pre-wrap break-words"
                style={{ fontFamily: 'inherit' }}
                dangerouslySetInnerHTML={{ __html: highlightedPreviewHtml }}
              />
            ) : (
              previewSample
            )}
          </div>

          <div>
            <div className="px-2 pb-1 text-11 font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
              {t('settings.appearance.font.presets')}
            </div>
            <div className="flex flex-col gap-[2px]" role="listbox" aria-label={ariaLabel}>
              {presetOptions.map((option) => {
                const isSelected = option.family === value.trim();
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(option.family)}
                    onFocus={() => setPreviewFamily(option.family)}
                    onBlur={() => setPreviewFamily(null)}
                    onMouseEnter={() => setPreviewFamily(option.family)}
                    onMouseLeave={() => setPreviewFamily(null)}
                    className={cn(
                      'flex h-[34px] w-full items-center justify-between rounded-[8px] px-3',
                      'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
                      isSelected && 'bg-[var(--settings-menu-bg-hover)]',
                    )}
                  >
                    <span
                      className="truncate text-13 text-[var(--settings-input-text)]"
                      style={{ fontFamily: buildPreviewFamily(option.family) }}
                    >
                      {option.label}
                    </span>
                    {isSelected ? (
                      <Check
                        size={16}
                        className="shrink-0 text-[var(--settings-theme-icon-active)]"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-[var(--settings-input-border)] pt-2">
            <div className="px-2 pb-1 text-11 font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
              {t('settings.appearance.font.custom')}
            </div>
            <div className="flex gap-2">
              <SettingsTextInput
                data-setting-id={settingId}
                value={customValue}
                onChange={setCustomValue}
                placeholder={t('settings.appearance.font.customPlaceholder')}
                size="md"
                mono
                className="min-w-0 flex-1"
              />
              <Button
                variant="secondary"
                size="lg"
                compact
                type="button"
                onClick={() => handleSelect(customPreview)}
                disabled={!customPreview}
              >
                {t('settings.appearance.font.applyCustom')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
