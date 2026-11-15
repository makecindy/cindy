/**
 * AttentionDot —— 统一「提醒角标点」。
 * ===========================================================================
 * 角标点规范(UI rule — 新增/调整带"提醒/状态点"的 UI 时统一遵循):
 *
 *   颜色:由 `tone` 选语义色(三态,均走主题 token,小圆点 hue 豁免)。
 *   全端统一色表 —— 侧栏列表行 / 置顶卡片 / rail 瓷砖 / 自动化入口 / 灵动岛
 *   (macos-agent-island-helper.swift)同一套语义:
 *     • done(默认)→ 绿 `--card-status-done`:任务完成有未读结果(普通与定时任务
 *       不再区分颜色)。
 *     • awaiting   → TapTap 蓝 `--card-status-awaiting`:等待用户回复/选择(Claude
 *       权限 / AskUserQuestion / 计划审阅;Codex 无此态)。与灵动岛 needs-interaction 同色。
 *     • error      → 红 `--card-status-error`:任务出错(终止错误)。红专职表示出错。
 *     • info       → 信息蓝 `--status-info`(双模式取 info-700 的深浅两档):新功能入口
 *       提示,不表示任何任务状态。
 *   running 不走本组件:橙(Thinking Orange)专职表达"正在跑"(vendor mark 呼吸 /
 *   spinner),不再用于任何"完成"语义。不用黑/前景色。
 *
 *   形态:静态圆点,不做循环动画(2026-11-11 维护者裁决 D-06:插件页未读点原为
 *   session-card-pulse 呼吸脉冲,是全应用唯一一处,改为与其他未读点一致的静态点)。
 *   需要表达"正在跑"时用 vendor mark 呼吸 / spinner,不要给本组件加回循环动画。
 *
 *   尺寸:`size`(px),默认 6;按宿主大小微调(rail 瓷砖 5、tab/图标钮 6 等)。
 *   定位:本组件只画圆点,绝对定位/偏移由调用方经 `className`(如
 *         `absolute right-1.5 top-1.5`)给。
 *
 * 这份规范连同组件会随 PR 进描述,供 reviewer / 其他人对齐。
 */

import { cn } from '@/lib/utils';
import type { AttentionKind } from '@/lib/sessionAttentionStore';

/** 展示用 tone == store 的 AttentionKind(done/awaiting/error);另有不属于会话状态的 info。 */
export type DotTone = AttentionKind | 'info';

/** tone → 背景色 token。 */
const TONE_BG: Record<DotTone, string> = {
  done: 'bg-[var(--card-status-done)]',
  awaiting: 'bg-[var(--card-status-awaiting)]',
  error: 'bg-[var(--card-status-error)]',
  info: 'bg-[var(--status-info)]',
};

export interface AttentionDotProps {
  /** 直径(px),默认 6。 */
  size?: number;
  /** 语义色:done(绿,默认)/ awaiting(TapTap 蓝)/ error(红)/ info(信息蓝,新功能入口提示,非会话状态)。 */
  tone?: DotTone;
  /** 定位/偏移等由调用方给(如 absolute right-x top-y)。 */
  className?: string;
}

export function AttentionDot({ size = 6, tone = 'done', className }: AttentionDotProps) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        'shrink-0 rounded-full',
        TONE_BG[tone],
        className,
      )}
    />
  );
}
