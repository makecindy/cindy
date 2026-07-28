/**
 * 读取当前生效的 interaction prompt slot(模块级单例,见 store.ts 顶注)。
 *
 * 两个消费者:
 * - InteractionPromptHost —— 决定卡片是 inline 渲染还是 portal 出去;
 * - CCAgentSessionView —— 决定卡片的 window 级快捷键归谁。卡片一旦被 portal 到
 *   常驻可见的 slot(doc-browse 中栏),它就不再随源 rail 折叠而隐藏,快捷键归属
 *   必须跟着卡片实际渲染的位置走,而不是跟着源 rail 的 viewVisible。
 *
 * useSyncExternalStore 保证并发渲染下读到的是同一份快照。
 */

import { useSyncExternalStore } from 'react';

import { getSlotElement, subscribeSlot } from './store';

export function useInteractionPromptSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribeSlot, getSlotElement, getSlotElement);
}
