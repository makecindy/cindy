import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';

import {
  PERSONA_CALL_OPTIONS,
  PERSONA_PROACTIVITY_OPTIONS,
  PERSONA_STYLE_OPTIONS,
  compilePersonaIntoIdentitySource,
  extractPersonaFromIdentitySource,
  type PersonaCallForm,
  type PersonaProactivity,
  type PersonaSelection,
  type PersonaStyle,
} from './botPersona';

export const DEFAULT_PERSONA_SELECTION: PersonaSelection = {
  style: 'concise',
  proactivity: 'reactive',
  call: 'name',
};

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * "现在的 TA" 预览文案。用 UI i18n 拼(不是 botPersona.ts 里那份写进 identitySource
 * 的固定双语 prompt 素材——两者读者不同,一份给用户看,一份给模型看)。
 */
export function personaSummaryText(t: Translate, selection: PersonaSelection | null): string {
  if (!selection) return t('bots.persona.summaryUnset');
  const style = t(`bots.persona.style.${selection.style}.label`);
  const proactivity = t(`bots.persona.proactivity.${selection.proactivity}.label`);
  const call =
    selection.call === 'name'
      ? t('bots.persona.summaryCallName')
      : selection.call === 'boss'
        ? t('bots.persona.summaryCallBoss')
        : t('bots.persona.summaryCallCustom', { name: selection.customCall ?? '' });
  return [style, proactivity, call].join(' · ');
}

export function PersonaOptionCard({
  title,
  description,
  selected,
  onSelect,
}: {
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      /*
        选中用 --text-primary 描边,不是 --focus-ring。
        --focus-ring(#417CDD)是键盘焦点的颜色:拿它当常驻的「选中」色,一是这一屏
        成了整个伙伴界面里唯一的蓝,二是 Tab 到别的选项时焦点圈和选中框同色,
        「我现在在哪一项」和「我选了哪一项」分不开。阵容页那排头像候选就是用
        --text-primary 描边表示选中的,这里跟它对齐。
      */
      className={cn(
        'flex w-full flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-[var(--text-primary)] bg-[var(--surface-chip)]'
          : 'border-[var(--border-default)] hover:bg-[var(--surface-hover)]',
      )}
    >
      <span className="text-12 font-medium text-[var(--text-primary)]">{title}</span>
      <span className="text-11 leading-4 text-[var(--text-tertiary)]">{description}</span>
    </button>
  );
}

export function PersonaEditorFields({
  style,
  proactivity,
  call,
  customCall,
  onStyleChange,
  onProactivityChange,
  onCallChange,
  onCustomCallChange,
}: {
  style: PersonaStyle;
  proactivity: PersonaProactivity;
  call: PersonaCallForm;
  customCall: string;
  onStyleChange: (value: PersonaStyle) => void;
  onProactivityChange: (value: PersonaProactivity) => void;
  onCallChange: (value: PersonaCallForm) => void;
  onCustomCallChange: (value: string) => void;
}) {
  const { t } = useBotTranslation();

  return (
    <div className="flex flex-col gap-5">
      <fieldset>
        <legend className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.persona.stepStyle')}
        </legend>
        <div className="mt-2 grid gap-2">
          {PERSONA_STYLE_OPTIONS.map((option) => (
            <PersonaOptionCard
              key={option}
              title={t(`bots.persona.style.${option}.label`)}
              description={t(`bots.persona.style.${option}.description`)}
              selected={style === option}
              onSelect={() => onStyleChange(option)}
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.persona.stepProactivity')}
        </legend>
        <div className="mt-2 grid gap-2">
          {PERSONA_PROACTIVITY_OPTIONS.map((option) => (
            <PersonaOptionCard
              key={option}
              title={t(`bots.persona.proactivity.${option}.label`)}
              description={t(`bots.persona.proactivity.${option}.description`)}
              selected={proactivity === option}
              onSelect={() => onProactivityChange(option)}
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.persona.stepCall')}
        </legend>
        <div className="mt-2 grid gap-2">
          {PERSONA_CALL_OPTIONS.map((option) => (
            <PersonaOptionCard
              key={option}
              title={t(`bots.persona.call.${option}`)}
              description=""
              selected={call === option}
              onSelect={() => onCallChange(option)}
            />
          ))}
        </div>
        {call === 'custom' ? (
          <input
            value={customCall}
            onChange={(event) => onCustomCallChange(event.target.value)}
            placeholder={t('bots.persona.customCallPlaceholder')}
            className="mt-2 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          />
        ) : null}
      </fieldset>
    </div>
  );
}

/** 三步人格引导只更新 persona marker，保留 marker 之外的背景正文。 */
export function BotPersonaWizard({
  open,
  identitySource,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  identitySource: string;
  onOpenChange: (open: boolean) => void;
  onSave: (nextIdentitySource: string) => void;
}) {
  const { t } = useBotTranslation();
  const [style, setStyle] = useState<PersonaStyle>(DEFAULT_PERSONA_SELECTION.style);
  const [proactivity, setProactivity] = useState<PersonaProactivity>(
    DEFAULT_PERSONA_SELECTION.proactivity,
  );
  const [call, setCall] = useState<PersonaCallForm>(DEFAULT_PERSONA_SELECTION.call);
  const [customCall, setCustomCall] = useState('');

  useEffect(() => {
    if (!open) return;
    const parsed = extractPersonaFromIdentitySource(identitySource) ?? DEFAULT_PERSONA_SELECTION;
    setStyle(parsed.style);
    setProactivity(parsed.proactivity);
    setCall(parsed.call);
    setCustomCall(parsed.customCall ?? '');
  }, [open, identitySource]);

  const customCallInvalid = call === 'custom' && customCall.trim().length === 0;
  const selection: PersonaSelection | null = customCallInvalid
    ? null
    : call === 'custom'
      ? { style, proactivity, call, customCall: customCall.trim() }
      : { style, proactivity, call };

  const handleSave = () => {
    if (!selection) return;
    onSave(compilePersonaIntoIdentitySource(identitySource, selection));
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-32px)] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 outline-none">
          <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
            {t('bots.persona.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t('bots.persona.description')}
          </Dialog.Description>

          <div className="mt-4 flex flex-col gap-4">
            <PersonaEditorFields
              style={style}
              proactivity={proactivity}
              call={call}
              customCall={customCall}
              onStyleChange={setStyle}
              onProactivityChange={setProactivity}
              onCallChange={setCall}
              onCustomCallChange={setCustomCall}
            />

            <div className="rounded-xl bg-[var(--surface-chip)] px-3 py-2.5">
              <p className="text-11 font-medium uppercase tracking-[0.1em] text-[var(--text-tertiary)]">
                {t('bots.persona.previewTitle')}
              </p>
              <p className="mt-1 text-12 text-[var(--text-primary)]">
                {personaSummaryText(t, selection)}
              </p>
            </div>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="h-8 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              {t('bots.cancel')}
            </button>
            <button
              type="button"
              disabled={customCallInvalid}
              onClick={handleSave}
              className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
            >
              {t('bots.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
