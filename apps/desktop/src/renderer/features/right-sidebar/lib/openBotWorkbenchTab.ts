import { addOrFocusSingletonTab, addTab, ensureHydrated, getBucket, reorderTabs } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';

/** 工作台排在最前(工作台 / 文件 / 浏览器),其余标签保持原顺序。 */
async function moveWorkbenchToFront(sessionId: string, tabId: string): Promise<void> {
  const others = getBucket(sessionId).tabs.filter((candidate) => candidate.id !== tabId).map((candidate) => candidate.id);
  if (others.length > 0) await reorderTabs(sessionId, [tabId, ...others]).catch(() => undefined);
}

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
  await moveWorkbenchToFront(sessionId, tab.id);
  requestRightSidebarVisibility('open', { sessionId, userInitiated: false });
}

/**
 * 用户点伙伴聊天头部的「工作台」:常驻入口。标签被关掉了就重建并排到最前,
 * 还在就切到它;无论右侧栏当前收起还是分离出去,都把它打开。
 * 与 `openRoutinesTab` 同一套路,保留用户已有的 attached / detached 选择。
 */
export async function openBotWorkbenchTab(sessionId: string, botId: string): Promise<void> {
  const route = await routeSidebarCommand({ type: 'open-bot-workbench-tab', sessionId, botId });
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    const existed = getBucket(sessionId).tabs.some((tab) => tab.kind === 'bot-workbench');
    const tab = await addOrFocusSingletonTab(sessionId, 'bot-workbench', { botId });
    if (!existed) await moveWorkbenchToFront(sessionId, tab.id);
  }
  if (route === 'attached' || route === 'routed') requestRightSidebarVisibility('open', { sessionId });
}
