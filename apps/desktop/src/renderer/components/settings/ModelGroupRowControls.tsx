/**
 * 路由编辑页里来源那一行行尾的小控件：按模型排的路由和合并整个供应商的路由共用同一套
 * (上移、下移、移出的图标按钮，「按权重」时的权重输入)。
 */
import { useState, type ReactNode } from 'react';

import { Tip } from '@/components/ui/tooltip';

import { modelGroupWeight } from '../../../shared/modelGroups';
import { SettingsTextInput } from './SettingsTextInput';

/** 行尾的小图标按钮：32px 热区，带可见提示。 */
export function RowIconButton({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tip text={label} disabled={disabled}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-settings-search-action="Reorders or removes one source inside a route"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] enabled:hover:bg-[var(--surface-chip)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)] disabled:opacity-40"
      >
        {children}
      </button>
    </Tip>
  );
}

/** 「按权重」时每个来源的权重：失焦或回车时保存，1–1000，空着或不是数字时恢复原值；保存失败也恢复成已保存的值。 */
export function WeightInput({ value, label, onCommit }: { value: number; label: string; onCommit(next: number): Promise<boolean> }) {
  const [draft, setDraft] = useState(String(value));
  const commit = () => {
    const parsed = Number(draft.trim());
    if (!draft.trim() || !Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = modelGroupWeight(parsed);
    setDraft(String(next));
    if (next !== value) void onCommit(next).then((saved) => { if (!saved) setDraft(String(value)); });
  };
  return (
    <SettingsTextInput
      aria-label={label}
      data-settings-search-action="Sets how many new tasks one source gets when a route picks by weight"
      data-model-group-weight
      value={draft}
      size="sm"
      inputMode="numeric"
      maxLength={4}
      onChange={(next) => setDraft(next.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      className="w-[64px] shrink-0"
      inputClassName="text-right tabular-nums"
    />
  );
}
