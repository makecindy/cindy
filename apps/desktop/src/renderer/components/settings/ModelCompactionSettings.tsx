import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { Slider } from '@/components/ui/slider';
import {
  MAX_MODEL_COMPACTION_PCT,
  MIN_MODEL_COMPACTION_PCT,
  type ModelContextLimitView,
} from '../../../shared/modelContextLimit';
import { DefaultOverrideControls } from './DefaultOverrideControls';

/** 连续提交（键盘连按）的合并窗口：一次按键风暴最多落一次盘。 */
const COMMIT_DEBOUNCE_MS = 300;

/** One supplier/model preference shared by every harness. */
export function ModelCompactionSettings({
  policy,
  disabled,
  onChange,
}: {
  policy: NonNullable<ModelContextLimitView['compaction']>;
  disabled: boolean;
  onChange: (pct: number | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const key = 'settings.providers.models.advanced.compaction';
  // Drag preview stays local; only the released value is persisted.
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<{
    pct: number;
    owner: ReturnType<typeof getDataOwnerGeneration>;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const writing = useRef<number | null>(null);
  const lastWriteAt = useRef(0);
  // 共享 Slider 取消手势会把“按下时”的值回放一遍；记下按下时的值来识别它。
  const pressValue = useRef<number | null>(null);
  const value = draft ?? policy.pct;

  // 策略变化（自己写入的确认、还原、换模型、外部改写）→ 预览跟住落盘值；
  // 但属于还没发送的尾部提交或在途写入的预览要留住，否则连按的最后一格会被确认吃掉。
  useEffect(() => {
    setDraft((current) =>
      current !== null && (pending.current?.pct === current || writing.current === current)
        ? current
        : null,
    );
  }, [policy.pct, policy.isCustomized]);

  // 卸载或换模型（onChange 换了）时，作废还没发送的尾部提交。
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
      setDraft(null);
    },
    [onChange],
  );

  const write = async (pct: number) => {
    writing.current = pct;
    lastWriteAt.current = Date.now();
    await onChange(pct);
    if (writing.current === pct) writing.current = null;
    // 写失败时策略不变，这里把预览收回，显示主进程真正保存的值。
    setDraft((current) => (current === pct ? null : current));
  };
  const commit = (pct: number) => {
    const since = Date.now() - lastWriteAt.current;
    if (pending.current) clearTimeout(pending.current.timer);
    if (since >= COMMIT_DEBOUNCE_MS) {
      // 距上次写入够久：立刻落盘（拖拽只有一次提交，不该让人等窗口）。
      pending.current = null;
      void write(pct);
      return;
    }
    // 窗口内的连续提交（键盘连按）：合并成窗口末尾的一次写入；
    // 绑定提交时的账号代次，账号已切换就作废，不把旧值写进新账号。
    const owner = getDataOwnerGeneration();
    pending.current = {
      pct,
      owner,
      timer: setTimeout(() => {
        pending.current = null;
        if (!isDataOwnerGenerationCurrent(owner)) return;
        void write(pct);
      }, COMMIT_DEBOUNCE_MS - since),
    };
  };
  const restoreDefault = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setDraft(null);
    void onChange(null);
  };
  return (
    <details
      className="mt-3 border-t border-[var(--settings-theme-card-border)] pt-3"
      data-model-compaction
    >
      {/* 状态标记挂在标题行：它出现/消失时不会挤压下面的滑杆，滑杆宽度保持恒定。 */}
      <summary className="cursor-pointer text-12 font-medium text-[var(--text-secondary)]">
        {t(`${key}.title`)}
        <span className="ml-2 inline-flex items-center rounded-full bg-[var(--surface-chip)] px-2 py-0.5 align-middle text-11 font-medium leading-none text-[var(--text-secondary)]">
          {policy.isCustomized ? t('settings.defaults.customizedBadge') : t(`${key}.defaultBadge`)}
        </span>
      </summary>
      <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.hint`)}
      </p>
      <div className="mt-2 flex items-center gap-[14px]">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Slider
            value={[value]}
            min={MIN_MODEL_COMPACTION_PCT}
            max={MAX_MODEL_COMPACTION_PCT}
            step={1}
            disabled={disabled}
            onPointerDown={() => {
              pressValue.current = value;
            }}
            onPointerUp={() => {
              pressValue.current = null;
            }}
            onValueChange={(next: number[]) => {
              const pct = next[0];
              if (typeof pct !== 'number') return;
              // 取消回放与拖回起点都等于“按下时”的值：丢弃预览，跟住落盘值。
              // 不能拿当前 policy.pct 比对——拖动期间策略被外部改掉时两者不同。
              // 命中后顺手清掉：取消回放自身必命中，等于自动清了，
              // 否则取消后键盘恰好调回该值会被误当成又一次回放。
              if (pct === pressValue.current) {
                pressValue.current = null;
                setDraft(null);
                return;
              }
              setDraft(pct);
            }}
            onValueCommit={(next: number[]) => {
              const pct = next[0];
              if (typeof pct === 'number') commit(pct);
            }}
            aria-label={t(`${key}.sliderAria`)}
          />
          <div className="flex items-center justify-between text-11 leading-none text-[var(--text-tertiary)]">
            <span>{MIN_MODEL_COMPACTION_PCT}%</span>
            <span>{MAX_MODEL_COMPACTION_PCT}%</span>
          </div>
        </div>
        {/* 定宽数值块：50%–95% 数字位数相同，滑杆不会随数值长短跳动。 */}
        <span className="w-[52px] shrink-0 text-center text-13 font-medium leading-none tabular-nums text-[var(--text-primary)]">
          {value}%
        </span>
        <DefaultOverrideControls
          isCustomized={policy.isCustomized}
          disabled={disabled}
          alwaysVisible
          showCustomizedBadge={false}
          label={t(`${key}.restoreAria`)}
          onReset={restoreDefault}
        />
      </div>
      <p className="mt-2 text-11 leading-relaxed text-[var(--text-secondary)]">
        {t(`${key}.timing`)}
      </p>
    </details>
  );
}
