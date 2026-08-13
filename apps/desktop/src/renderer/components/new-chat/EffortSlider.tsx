import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { Effort } from '@/lib/userPreferences.types';
import { effortTierColor, effortTierColorAt } from '@/themes/effortTierColors';

/**
 * EffortSlider —— 配置浮层里的**推理强度滑杆**(model-selector-unified §1.3)。
 *
 * 三条行为契约(设计稿 v4 定稿,实现时逐条对齐):
 *   1. **档位绝对色**:条色 / 滑块色按档位 key 取绝对值(themes/effortTierColors),不按
 *      「第几档」相对取 —— 封顶 high 的模型拉满也是蓝,紫只属于真正的顶档。
 *   2. **单色条 + 连续过渡**:条本身永远是单色(不画渐变);拖动中滑块 1:1 跟手,条色按
 *      连续档位坐标在相邻档色之间插值 —— 渐变发生在**时间**上,不是画在条上。
 *   3. **点击跳档 = 扫过动画**:松手 / 点击时恢复 CSS 过渡,宽度与颜色一起扫到目标档。
 *      拖动期间移除过渡(否则跟手会被过渡拖成橡皮筋)。
 *
 * 只渲染**该 (模型, 引擎) 真实支持**的档位;调用方在 ≤1 档时根本不该挂载本组件
 * (一个档位的滑杆是假控件,规格「不可调时不显示滑杆」)。
 */
export function EffortSlider({
  stops,
  value,
  recommended,
  labelOf,
  onChange,
  disabled = false,
}: {
  /** 该 (模型, 引擎) 支持的档位,低 → 高。长度必须 ≥2。 */
  stops: readonly Effort[];
  /** 当前生效档位;不在 stops 里时回落到首档位置(调用方通常已收敛过)。 */
  value: Effort | null;
  /** 推荐档(目录 defaultEffort);气泡里标注「推荐」。 */
  recommended?: Effort | null;
  /** 档位 → 显示文案(i18n,绝不入库)。 */
  labelOf: (effort: Effort) => string;
  onChange: (effort: Effort) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const trackRef = useRef<HTMLDivElement>(null);
  // 拖动中的连续坐标(0..n-1)。null = 未拖动,一切按 value 渲染。
  const [dragPos, setDragPos] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);

  const lastIndex = Math.max(0, stops.length - 1);
  const valueIndex = Math.max(0, value ? stops.indexOf(value) : -1);
  const activeIndex = dragPos === null ? valueIndex : Math.round(dragPos);
  const activeStop = stops[Math.min(lastIndex, Math.max(0, activeIndex))] ?? stops[0];
  const position = dragPos ?? valueIndex;
  const percent = lastIndex > 0 ? (position / lastIndex) * 100 : 0;
  const color =
    dragPos === null ? effortTierColor(activeStop) : effortTierColorAt(stops, dragPos);

  const positionFromEvent = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return valueIndex;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * lastIndex;
    },
    [lastIndex, valueIndex],
  );

  const commit = useCallback(
    (index: number) => {
      const next = stops[Math.min(lastIndex, Math.max(0, index))];
      if (next && next !== value) onChange(next);
    },
    [lastIndex, onChange, stops, value],
  );

  // pointerup 挂在 document 上:拖出滑杆范围松手也要收尾,否则 dragging 态卡住、
  // 条色停在插值中间(既不是任何一档的颜色,也不再跟手)。
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      draggingRef.current = true;
      setDragPos(positionFromEvent(event.clientX));
    };
    const onUp = (event: PointerEvent) => {
      const index = Math.round(positionFromEvent(event.clientX));
      setDragging(false);
      draggingRef.current = false;
      // 先落值再清连续坐标:清早了会先闪回旧档再跳到新档。
      commit(index);
      setDragPos(null);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [commit, dragging, positionFromEvent]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    setDragging(true);
    draggingRef.current = false;
    // 按下即吸附到最近档(保留过渡 ⇒ 点远处 = 快速扫过去);后续 move 才切连续跟手。
    commit(Math.round(positionFromEvent(event.clientX)));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : event.key === 'Home'
            ? -lastIndex
            : event.key === 'End'
              ? lastIndex
              : 0;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    commit(Math.min(lastIndex, Math.max(0, valueIndex + delta)));
  };

  const live = dragging && draggingRef.current;
  const transition = live
    ? 'none'
    : 'left var(--motion-base) var(--motion-ease-out), width var(--motion-base) var(--motion-ease-out), background-color var(--motion-base) var(--motion-ease-out)';

  return (
    <div
      className={cn('group/effort relative min-w-0 flex-1 pl-1.5 pr-2.5', disabled && 'opacity-50')}
    >
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('newChat.modelSelector.effortLabel')}
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        aria-valuenow={activeIndex}
        aria-valuetext={activeStop ? labelOf(activeStop) : undefined}
        aria-disabled={disabled}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          'relative flex h-[38px] touch-none items-center',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        <div className="absolute inset-x-0 h-3 rounded-full bg-[var(--surface-chip)]" />
        <div
          data-effort-fill
          className="absolute left-0 z-[1] h-3 rounded-full"
          style={{ width: `${percent}%`, backgroundColor: color, transition }}
        />
        {stops.map((stop, index) =>
          index === 0 || index === lastIndex ? null : (
            <div
              key={stop}
              aria-hidden
              // 档位停点:设计稿是「用面板底色打孔」的实心点(color-mix(card 65%)),
              // 之前用 opacity 让它糊在轨道色里,拖动时几乎看不见档位在哪。
              className="absolute z-[2] h-[5px] w-[5px] -translate-x-1/2 rounded-full"
              style={{
                left: `${(index / lastIndex) * 100}%`,
                backgroundColor:
                  'color-mix(in srgb, var(--model-dropdown-bg) 65%, transparent)',
              }}
            />
          ),
        )}
        <div
          data-effort-thumb
          className={cn(
            'absolute z-[3] h-[21px] w-[21px] -translate-x-1/2 rounded-full border-[2.5px] border-[var(--model-dropdown-bg)]',
            dragging && 'scale-110',
          )}
          style={{
            left: `${percent}%`,
            backgroundColor: color,
            // 设计稿的滑块「描边环」:2.5px 面板底色描边 + 4px 同色 22% 外晕。
            // 外晕是滑块在深浅两种轨道色上都能被一眼找到的原因,不是装饰。
            boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 22%, transparent)`,
            transition: `${transition}, box-shadow var(--motion-fast) var(--motion-ease-out)`,
          }}
        >
          <div
            className={cn(
              'pointer-events-none absolute bottom-[calc(100%-2px)] left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 py-1',
              'bg-[var(--tooltip-bg)] text-11 text-[var(--tooltip-text)] opacity-0 transition-opacity duration-100',
              'group-hover/effort:opacity-100',
              dragging && 'opacity-100',
            )}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: effortTierColor(activeStop) }}
            />
            <span>{activeStop ? labelOf(activeStop) : ''}</span>
            {recommended && activeStop === recommended && (
              <span className="opacity-70">· {t('newChat.modelSelector.unified.recommended')}</span>
            )}
          </div>
        </div>
      </div>
      {/* 端点标签只在拖动时浮现:静态时它们既占视觉又没人看(设计稿 v4)。 */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-1 -bottom-0.5 flex justify-between text-10 text-[var(--text-tertiary)]',
          'transition-opacity duration-150',
          dragging ? 'opacity-100' : 'opacity-0',
        )}
      >
        <span>{t('newChat.modelSelector.unified.effortEndFast')}</span>
        <span>{t('newChat.modelSelector.unified.effortEndSmart')}</span>
      </div>
    </div>
  );
}
