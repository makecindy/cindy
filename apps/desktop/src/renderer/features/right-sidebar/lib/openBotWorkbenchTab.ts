import { addTab, ensureHydrated, getBucket, reorderTabs } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/**
 * 伙伴主任务页进入时确保右侧栏里有「工作台」标签。
 *
 * 只在标签还不存在时创建并展开右侧栏(首次进入默认打开);已存在时什么也不动,
 * 用户之后收起右侧栏或切到文件 / 浏览器的选择都保留。这是程序自发的动作:
 * detached 形态下只把命令交给已打开的子窗口,不因此弹出窗口或抢前台。
 */
export async function ensureBotWorkbenchTab(sessionId: string, botId: string): Promise<void> {
  const route = await routeSidebarCommand(
    { type: 'open-bot-workbench-tab', sessionId, botId },
    { allowOpen: false, userInitiated: false },
  );
  if (route !== 'attached') return;
  await ensureHydrated(sessionId);
  if (getBucket(sessionId).tabs.some((tab) => tab.kind === 'bot-workbench')) return;
  const tab = await addTab(sessionId, 'bot-workbench', { botId });
  // 工作台排在最前(工作台 / 文件 / 浏览器),其余标签保持原顺序。
  const others = getBucket(sessionId).tabs.filter((candidate) => candidate.id !== tab.id).map((candidate) => candidate.id);
  if (others.length > 0) await reorderTabs(sessionId, [tab.id, ...others]).catch(() => undefined);
  requestRightSidebarVisibility('open', { sessionId, userInitiated: false });
}
