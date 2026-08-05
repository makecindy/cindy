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
 *   running 不走本组件:橙(Thinking Orange)专职表达"正在跑"(vendor mark 呼吸 /
 *   spinner),不再用于任何"完成"语义。不用黑/前景色。
 *
 *   形态(两种,按语义选):
 *     • 呼吸(breathing=true):单条会话"有需要你关注的未读结果"的提醒点——卡片
 *       任务完成未读、rail 瓷砖未读。复用 `.session-card-dot` 的 session-card-pulse
 *       关键帧(prefers-reduced-motion 下自动停),用呼吸吸引注意。
 *     • 静态(breathing=false,默认):聚合入口/常驻类未读徽标——如自动化入口(🕐)
 *       的未读小点。不动,低打扰。
 *
 *   尺寸:`size`(px),默认 6;按宿主大小微调(rail 瓷砖 5、tab/图标钮 6 等)。
 *   定位:本组件只画圆点,绝对定位/偏移由调用方经 `className`(如
 *         `absolute right-1.5 top-1.5`)给。
 *
 * 这份规范连同组件会随 PR 进描述,供 reviewer / 其他人对齐。
 */

import { cn } from '@/lib/utils';
import type { AttentionKind } from '@/lib/sessionAttentionStore';

/** 展示用 tone == store 的 AttentionKind(done/awaiting/error),不再有派生档。 */
export type DotTone = AttentionKind;

/** tone → 背景色 token。 */
const TONE_BG: Record<DotTone, string> = {
  done: 'bg-[var(--card-status-done)]',
  awaiting: 'bg-[var(--card-status-awaiting)]',
  error: 'bg-[var(--card-status-error)]',
};

export interface AttentionDotProps {
  /** true → 呼吸(live 活动态);false(默认)→ 静态(settled 未读/完成)。 */
  breathing?: boolean;
  /** 直径(px),默认 6。 */
  size?: number;
  /** 语义色:done(绿,默认)/ awaiting(TapTap 蓝)/ error(红)。 */
  tone?: DotTone;
  /** 定位/偏移等由调用方给(如 absolute right-x top-y)。 */
  className?: string;
}

export function AttentionDot({ breathing = false, size = 6, tone = 'done', className }: AttentionDotProps) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        'shrink-0 rounded-full',
        TONE_BG[tone],
        breathing && 'session-card-dot',
        className,
      )}
    />
  );
}
