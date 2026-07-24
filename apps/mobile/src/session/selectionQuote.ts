/**
 * selectionQuote — 聊天流「选中文字 → 添加到对话」的选区采集纯逻辑层
 * (chat-text-quote,对照桌面 SelectionQuoteButton)。
 *
 * 采集入口是 iOS 系统选择菜单里的自定义项(react-native-uitextview patch 的
 * `menuActionLabel` / `onMenuAction`,iOS 16+ 的 editMenuForTextInRange)——
 * 不用自绘浮动按钮:真机实测浮层与系统 Copy / Look Up 菜单撞位。
 *
 * 数据通路:MarkdownSelectableText 缓存 `onTextLayout` 的逐行渲染文本;用户点
 * 菜单项时 `onMenuAction` 带回选区 UTF-16 偏移,`sliceRenderedSelection` 切出
 * 选中文本,经 SelectionQuoteContext 直接提交进 chatQuoteStore(原生侧在事件
 * 发出后自行清除选区)。
 *
 * 本模块不 import react-native——纯函数可被 vitest 直接单测。
 */
import { createContext } from 'react';

import { i18n } from '@/i18n';

/**
 * 系统选择菜单里自定义项的文案(与桌面 chat.quote.addToChat 对齐)。
 * 用函数在调用点求值,避免模块顶层把 i18n.t 结果冻结成常量(冻结语言)。
 */
export function selectionQuoteMenuLabel(): string {
  return i18n.t('message.quote.menuLabel');
}

/** 采集提交接口:MarkdownSelectableText 经 context 调用。null = 宿主未启用采集。 */
export interface SelectionQuoteContextValue {
  /** 把选中文本提交为一条引用(宿主负责截断与写入 store)。 */
  commitQuote: (text: string) => void;
}

export const SelectionQuoteContext = createContext<SelectionQuoteContextValue | null>(null);

/**
 * 渲染行数组 + UTF-16 偏移 → 选中文本。lines 是 onTextLayout 报的逐行渲染
 * 子串(join 即完整渲染文本,含换行;偏移语义与 JS slice 一致)。越界 clamp
 * (numberOfLines 截断 / 过期 layout 时 end 可能越界),切出空白返回 null。
 */
export function sliceRenderedSelection(
  lines: readonly string[],
  start: number,
  end: number,
): string | null {
  if (lines.length === 0 || end <= start) return null;
  const full = lines.join('');
  const clampedStart = Math.max(0, Math.min(start, full.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, full.length));
  const text = full.slice(clampedStart, clampedEnd);
  return text.trim().length > 0 ? text : null;
}

/** onMenuAction 原生事件的最小结构(uitextview patch 的自定义 spec)。 */
export interface SelectionQuoteMenuEvent {
  nativeEvent: { target: number; start: number; end: number };
}

/**
 * MarkdownSelectableText 的 onMenuAction 处理:按事件里的选区偏移切出文本,
 * 非空则提交。lines 为空(onTextLayout 未到)或切出空白时静默忽略。
 */
export function handleSelectionQuoteMenuAction(
  event: SelectionQuoteMenuEvent,
  lines: readonly string[],
  ctx: SelectionQuoteContextValue,
): void {
  const { start, end } = event.nativeEvent;
  const text = sliceRenderedSelection(lines, start, end);
  if (text) ctx.commitQuote(text);
}
