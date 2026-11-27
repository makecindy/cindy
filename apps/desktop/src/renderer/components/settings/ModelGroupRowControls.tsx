/**
 * 路由编辑页里的小控件：按模型排的路由和合并整个供应商的路由共用同一套
 * (名字那一行；来源行尾的上移、下移、移出图标按钮，「按权重」时的权重输入)。
 */
import { useRef, useState, type ReactNode } from 'react';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Tip } from '@/components/ui/tooltip';

import { MODEL_GROUP_LIMITS, modelGroupWeight } from '../../../shared/modelGroups';
import { SettingsTextInput } from './SettingsTextInput';

/**
 * 路由的名字：失焦或回车时保存。回车保存后焦点还在框里，之后失焦会再走一次：同一个名字不重复保存；
 * 没保存成功时可以原样再提交一次(2026-11-26 排查)。
 */
export function RouteNameRow({ value, label, hint, onCommit }: {
  value: string;
  label: string;
  hint: string;
  onCommit(next: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const sent = useRef<string | null>(null);
  const commit = () => {
    const next = draft.trim().slice(0, MODEL_GROUP_LIMITS.name);
    if (!next || next === value) {
      setDraft(value);
      return;
    }
    if (next === sent.current) return;
    sent.current = next;
    void onCommit(next).then((ok) => { if (!ok && sent.current === next) sent.current = null; });
  };
  return (
    <SettingsRow
      title={label}
      hint={hint}
      wrap
      trailing={
        <SettingsTextInput
          aria-label={label}
          data-settings-search-action="Renames one route; the routes list is indexed by its section entry"
          value={draft}
          maxLength={MODEL_GROUP_LIMITS.name}
          onChange={setDraft}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
          className="w-[240px] max-w-full"
        />
      }
    />
  );
}

/**
 * 行尾的小图标按钮：32px 热区，带可见提示。
 * 上移、下移传 `move`：保存期间不禁用(禁用会让焦点掉到页面最上面)，只忽略多余的点击；挪完以后把焦点放回挪动的那一行的
 * 同一个按钮，到了头(那个按钮变成不可用)就放到另一个方向的按钮上，键盘用户接着按就行(2026-11-26 排查)。
 */
export function RowIconButton({ label, onClick, disabled, busy = false, move, children }: {
  label: string;
  onClick(): unknown;
  disabled?: boolean;
  /** 正在保存：点击不生效，但按钮保持可用、焦点不丢。 */
  busy?: boolean;
  /** 上移/下移：这一行的稳定标识与方向。 */
  move?: { row: string; direction: 'up' | 'down' };
  children: ReactNode;
}) {
  const focusKey = move ? `${move.row}\u0000${move.direction}` : undefined;
  const handle = () => {
    if (busy) return;
    const result = onClick();
    if (!move) return;
    void Promise.resolve(result).then(() => requestAnimationFrame(() => {
      const find = (direction: 'up' | 'down') => [...document.querySelectorAll<HTMLButtonElement>('[data-row-move]')]
        .find((button) => button.dataset.rowMove === `${move.row}\u0000${direction}` && !button.disabled);
      (find(move.direction) ?? find(move.direction === 'up' ? 'down' : 'up'))?.focus();
    }));
  };
  return (
    <Tip text={label} disabled={disabled}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        aria-busy={busy || undefined}
        data-row-move={focusKey}
        onClick={handle}
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
  // 回车保存后焦点留在框里，之后失焦会再走一次：同一个值不重复保存。
  const sent = useRef<number | null>(null);
  const commit = () => {
    const parsed = Number(draft.trim());
    if (!draft.trim() || !Number.isFinite(parsed)) { setDraft(String(value)); return; }
    const next = modelGroupWeight(parsed);
    setDraft(String(next));
    if (next === value || next === sent.current) return;
    sent.current = next;
    void onCommit(next).then((saved) => { if (!saved) { sent.current = null; setDraft(String(value)); } });
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
      // 回车就保存，焦点留在框里(失焦会让下一次 Tab 从页面最上面开始)。
      onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
      className="w-[64px] shrink-0"
      inputClassName="text-right tabular-nums"
    />
  );
}
