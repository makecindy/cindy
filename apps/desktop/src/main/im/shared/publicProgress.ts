/**
 * im/shared/publicProgress.ts
 * ---------------------------------------------------------------------------
 * chunked-text 渠道(本批企业微信)的**公开过程反馈**视图。
 *
 * 富卡渠道的过程区(`turnActivity.renderActivity`)会列出工具步骤与思考摘要 —— 那
 * 些是任务内部实现, 适合展示在 Cindy 自己的界面上, 不适合推到用户的 IM 会话里。
 * 这里只取三样东西:
 *
 *  1. 粗粒度阶段:「已进行 N 步 · 42s」——不含工具名、参数和命令;
 *  2. 「正在整理回答」这一行 —— 正文确实在产出;
 *  3. 已经本地化、面向用户的状态行(自动重试说明 / 正在等待你的确认)。
 *
 * 任何自由文本(思考增量、工具输入、命令输出)都不进这里。
 */
import type { TurnActivityState } from './turnActivity.js';

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60 ? `${sec % 60}s` : ''}`;
}

/**
 * 渲染一行公开阶段摘要。永远返回非空字符串 —— 只要一轮在跑, 就应该有一条
 * "在处理"的可见反馈; 具体有什么进展由耗时与步数体现。
 */
export function renderPublicStage(activity: TurnActivityState, now: number): string {
  const elapsed = formatElapsed(now - activity.startedAt);
  const steps = activity.totalSteps > 0 ? ` · 已进行 ${activity.totalSteps} 步` : '';
  const lines = [`⚙️ 正在处理${steps} · ${elapsed}`];
  if (activity.writing) lines.push('✍️ 正在整理回答…');
  // 这两行在别处已经过本地化, 是给用户看的状态, 不是内部实现细节。
  if (activity.notice) lines.push(`⏳ ${activity.notice}`);
  if (activity.interactionNotice) lines.push(`⏳ ${activity.interactionNotice}`);
  return lines.join('\n');
}
