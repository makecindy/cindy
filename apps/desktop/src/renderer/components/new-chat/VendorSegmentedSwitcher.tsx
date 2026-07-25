/**
 * VendorSegmentedSwitcher —— NewMaker 主区域内的 Agent 引擎切换控件。
 * ---------------------------------------------------------------------------
 * 视觉规格:
 *   - 容器:pill (9999px),宽 220,padding 3,gap 2
 *           Light fill #e5e5e5 / Dark fill #1f1f1e + 1px Board #3c3c3a
 *   - segment:pill,padding [6,14],fill_container,justifyContent center,gap 6
 *     · Active : Light Card #ffffff + 1px Board #d7d7d4 / Dark #3c3c3a
 *     · Inactive: 透明,文字 Stone #737373
 *   - icon: 14×14 Agent 身份 mark (Claude Code / Codex CLI)
 *   - 文字: Inter 14, active weight 500,inactive weight 400
 *
 * F-COLLAB (2026-05): 原本第 3 个 "协同模式" tab 已被 ChatInput 底部的
 * CollaborationModeToggle 取代 — 用户先选 Claude 走单 session,需要时再 toggle
 * 召集 Worker。删 tab 后整体回到 2-tab 220 宽,与历史版本视觉对齐。
 */

import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import type { MakerVendor } from '@/lib/ccAgent.types';
import { CodexMark } from '@/components/icons/CodexMark';
import { ClaudeMark } from '@/components/icons/ClaudeMark';

interface VendorSegmentedSwitcherProps {
  value: MakerVendor;
  onChange: (next: MakerVendor) => void;
  /** disabled 状态(发送中等);整体降透明且不响应点击。 */
  disabled?: boolean;
  className?: string;
  width?: number;
  dense?: boolean;
  /** 窄态工具栏只保留品牌图标，文字通过 title / aria-label 提供。 */
  iconOnly?: boolean;
  /**
   * CREATE AGENT 首页按 Figma 185:2724 使用独立私有 token。
   * dropdown:模型选择器浮层内使用(session-agent-switch 两步切换)——浮层表面与
   * default 的暗色 active 填充(#3c3c3a 级)几乎同色,选中段会融进背景看不清;
   * 该变体把 active 段换成黑白反转强 CTA(--accent-cta-bg),当前 Agent 一眼可辨。
   */
  visualVariant?: 'default' | 'create-agent' | 'dropdown';
  /**
   * 点击**当前选中段**时也回调 onChange(默认 false = 无操作)。
   * 供「当前值是解析出的继承值、重选 = 钉成显式值」的调用方(IM 工作目录偏好)使用;
   * 普通调用点不要开 —— 那里 value 本就是显式状态,重选自己是纯无操作。
   * 调用方需自行对「显式同值」去重(如 handler 里 next === persisted 时 return)。
   */
  reselectEmitsChange?: boolean;
  /**
   * tablist 的可及名。多实例同屏(如 IM 目录偏好逐行一个)时必须传**本地化且可区分**
   * 的名字,否则读屏用户听到的全是同一个英文兜底,行与行无法分辨。
   */
  ariaLabel?: string;
}

interface SegmentOption {
  vendor: MakerVendor;
  label: string;
  Mark: ComponentType<{ size?: number; className?: string }>;
  iconClassName?: string;
}

const OPTIONS: readonly SegmentOption[] = [
  { vendor: 'cc', label: 'Claude', Mark: ClaudeMark },
  { vendor: 'codex', label: 'Codex', Mark: CodexMark },
] as const;

export function VendorSegmentedSwitcher({
  value,
  onChange,
  disabled,
  className,
  width = 220,
  dense = false,
  iconOnly = false,
  visualVariant = 'default',
  reselectEmitsChange = false,
  ariaLabel,
}: VendorSegmentedSwitcherProps) {
  const isCreateAgentVariant = visualVariant === 'create-agent';
  return (
    <div
      className={cn(
        'flex items-center rounded-full',
        isCreateAgentVariant
          ? [
              'h-[30px] gap-0 border border-[var(--create-agent-control-border)] p-0',
              'bg-[var(--create-agent-segment-track-bg)]',
              'focus-within:ring-2 focus-within:ring-[var(--create-agent-focus-ring)]',
            ]
          : [
              'gap-0.5 p-[3px]',
              dense ? 'h-[30px]' : 'h-9',
              'bg-[var(--chat-input-bg)] dark:border dark:border-[var(--cmd-palette-border)]',
            ],
        disabled && 'opacity-60 pointer-events-none',
        className,
      )}
      style={{ width }}
      role="tablist"
      aria-label={ariaLabel ?? 'Vendor switcher'}
    >
      {OPTIONS.map((opt) => {
        const isActive = value === opt.vendor;
        return (
          <button
            key={opt.vendor}
            type="button"
            role="tab"
            aria-selected={isActive}
            // 容器上的 pointer-events-none 只挡鼠标, 键盘仍能 Tab 到这里按 Enter ——
            // 在设置页的只读态(未连接/未绑定)或写入在途时会绕过禁用直接触发 onChange。
            // 原生 disabled 同时移出 tab 序并阻断激活, 是唯一可靠的门。
            disabled={disabled}
            // 阻止 mousedown 抢焦点 —— 否则点 tab 时下方 ChatInput 的 :focus-within
            // 边框会瞬间掉到非聚焦色。键盘 Tab 仍可正常 focus 本按钮（preventDefault
            // 只阻断鼠标路径），无障碍不受影响。
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (isActive && !reselectEmitsChange) return;
              onChange(opt.vendor);
            }}
            aria-label={opt.label}
            title={opt.label}
            className={cn(
              'flex h-full flex-1 items-center justify-center rounded-full',
              !iconOnly && 'gap-1.5',
              dense ? 'text-[12px] leading-none transition-colors' : 'text-[14px] leading-none transition-colors',
              isActive
                ? cn(
                    'font-medium',
                    isCreateAgentVariant
                      ? 'border border-[var(--create-agent-control-border)] bg-[var(--create-agent-control-bg)] text-[var(--create-agent-control-text)]'
                      : visualVariant === 'dropdown'
                        ? // 浮层内:黑白反转强对比(同 emptyState CTA 的 token 对),
                          // default 的 Card 色凸起在深色浮层表面上分不出来。
                          'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]'
                        : [
                            // Active: Card 色凸起 + 1px Board 描边
                            'bg-[var(--chat-input-chip-bg)] text-[var(--chat-input-chip-text)] border border-[var(--cmd-palette-border)]',
                            'dark:border-transparent',
                          ],
                  )
                : cn(
                    'font-normal',
                    isCreateAgentVariant
                      ? 'text-[var(--create-agent-segment-inactive-text)] hover:text-[var(--create-agent-control-text)]'
                      : 'text-[var(--cmd-palette-item-meta)] hover:text-[var(--msg-assistant-text)]',
                  ),
            )}
          >
            <opt.Mark size={dense ? 13 : 14} className={cn('shrink-0', opt.iconClassName)} />
            {/* 文字下沉 0.5px —— Inter 在 leading-none 下视觉重心偏上,与 vendor mark
                光学居中对齐微调,见 NewChat 视觉走查 2026-05-03。 */}
            {!iconOnly && <span className="translate-y-[0.5px] whitespace-nowrap">{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
