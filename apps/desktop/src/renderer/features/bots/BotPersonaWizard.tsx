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

const DEFAULT_SELECTION: PersonaSelection = {
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

function OptionCard({
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

/**
 * 3 步人格引导("调整性格")。只管自己那段 marker 区间——decompile 失败或没有
 * marker 时退回默认选项,绝不代人删掉 marker 以外的手写文本。
 *
 * 曾经这里还折叠着一个「高级:自己写设定」,展开是**整份** identitySource 的
 * textarea。它已经撤掉:那是当时唯一能碰到背景正文的入口,而它一次性覆盖整份
 * 文本,连向导自己那段 marker 都可能被顺手删掉。现在背景正文在设置页「TA 是谁」
 * 里有一等公民的「背景设定」子块(读写走 `readBotBackground` / `writeBotBackground`),
 * 两段各有各的入口、谁也不覆盖谁,这个藏起来的逃生口就没有存在的理由了。
 */
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
  const [style, setStyle] = useState<PersonaStyle>(DEFAULT_SELECTION.style);
  const [proactivity, setProactivity] = useState<PersonaProactivity>(DEFAULT_SELECTION.proactivity);
  const [call, setCall] = useState<PersonaCallForm>(DEFAULT_SELECTION.call);
  const [customCall, setCustomCall] = useState('');

  useEffect(() => {
    if (!open) return;
    const parsed = extractPersonaFromIdentitySource(identitySource) ?? DEFAULT_SELECTION;
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
            {/* ①②③。这三个序号不是装饰:标题上写着「选三下就好」,序号是把那句
                承诺变得看得见的唯一方式——不然三个 fieldset 读起来像三张要填的表。 */}
            <fieldset>
              <legend className="text-12 font-medium text-[var(--text-primary)]">
                {`① ${t('bots.persona.stepStyle')}`}
              </legend>
              <div className="mt-2 grid gap-2">
                {PERSONA_STYLE_OPTIONS.map((option) => (
                  <OptionCard
                    key={option}
                    title={t(`bots.persona.style.${option}.label`)}
                    description={t(`bots.persona.style.${option}.description`)}
                    selected={style === option}
                    onSelect={() => setStyle(option)}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-12 font-medium text-[var(--text-primary)]">
                {`② ${t('bots.persona.stepProactivity')}`}
              </legend>
              <div className="mt-2 grid gap-2">
                {PERSONA_PROACTIVITY_OPTIONS.map((option) => (
                  <OptionCard
                    key={option}
                    title={t(`bots.persona.proactivity.${option}.label`)}
                    description={t(`bots.persona.proactivity.${option}.description`)}
                    selected={proactivity === option}
                    onSelect={() => setProactivity(option)}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-12 font-medium text-[var(--text-primary)]">
                {`③ ${t('bots.persona.stepCall')}`}
              </legend>
              <div className="mt-2 grid gap-2">
                {PERSONA_CALL_OPTIONS.map((option) => (
                  <OptionCard
                    key={option}
                    title={t(`bots.persona.call.${option}`)}
                    description=""
                    selected={call === option}
                    onSelect={() => setCall(option)}
                  />
                ))}
              </div>
              {call === 'custom' ? (
                <input
                  value={customCall}
                  onChange={(event) => setCustomCall(event.target.value)}
                  placeholder={t('bots.persona.customCallPlaceholder')}
                  className="mt-2 h-9 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                />
              ) : null}
            </fieldset>

            <div className="rounded-xl bg-[var(--surface-chip)] px-3 py-2.5">
              <p className="text-11 font-medium uppercase tracking-[0.1em] text-[var(--text-tertiary)]">
                {t('bots.persona.previewTitle')}
              </p>
              <p className="mt-1 text-12 text-[var(--text-primary)]">{personaSummaryText(t, selection)}</p>
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
