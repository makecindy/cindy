import { addOrFocusSingletonTab, addTab, ensureHydrated, getBucket, reorderTabs } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { clearPanelCollapsedRecord, readPanelCollapsed, readPanelCollapsedRecord, writePanelCollapsed } from '@/layout/collapsePrefs';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

/** 工作台排在最前(工作台 / 文件 / 浏览器),其余标签保持原顺序。 */
async function moveWorkbenchToFront(sessionId: string, tabId: string): Promise<void> {
  const others = getBucket(sessionId).tabs.filter((candidate) => candidate.id !== tabId).map((candidate) => candidate.id);
  if (others.length > 0) await reorderTabs(sessionId, [tabId, ...others]).catch(() => undefined);
}

/**
 * 伙伴主任务页首次进入时提供默认的「工作台」标签。
 *
 * 只在标签和布局记录都不存在时创建并展开(首次进入默认打开);已有记录或标签时不动,
 * 用户之后收起右侧栏或切到文件 / 浏览器的选择都保留。这是程序自发的动作:
 * detached 形态下只把命令交给已打开的子窗口,不因此弹出窗口或抢前台。
 */
export async function ensureBotWorkbenchTab(
  sessionId: string,
  botId: string,
  signal?: AbortSignal,
): Promise<void> {
  const owner = getDataOwnerGeneration();
  const isCurrent = () => !signal?.aborted && isDataOwnerGenerationCurrent(owner);
  if (!isCurrent() || readPanelCollapsedRecord('right-tabs', { sessionId }) !== null) return;
  const route = await routeSidebarCommand(
    { type: 'open-bot-workbench-tab', sessionId, botId },
    { allowOpen: false, userInitiated: false },
  );
  if (route !== 'attached' || !isCurrent()) return;
  await ensureHydrated(sessionId);
  // Hydration / routing may finish after a close, route change or owner switch.
  if (!isCurrent() || readPanelCollapsedRecord('right-tabs', { sessionId }) !== null) return;
  if (getBucket(sessionId).tabs.some((tab) => tab.kind === 'bot-workbench')) {
    // Older layouts can contain the tab without a visibility record. Preserve
    // their effective visibility and remember that this is no longer a first visit.
    writePanelCollapsed('right-tabs', { sessionId }, readPanelCollapsed('right-tabs', { sessionId }, true));
    return;
  }
  // Use the existing per-session layout record as the first-visit marker. Commit
  // the default before async tab creation so a later user close wins permanently.
  const defaultRevision = writePanelCollapsed('right-tabs', { sessionId }, false);
  let tab;
  try {
    tab = await addTab(sessionId, 'bot-workbench', { botId });
  } catch (error) {
    // A failed default is not a user choice. Do not erase a later close or a
    // successful manual reopen while this INSERT was waiting.
    if (defaultRevision !== undefined && isDataOwnerGenerationCurrent(owner) && getBucket(sessionId).hydrated
      && !getBucket(sessionId).tabs.some((candidate) => candidate.kind === 'bot-workbench')) {
      clearPanelCollapsedRecord('right-tabs', { sessionId }, false, defaultRevision);
    }
    throw error;
  }
  if (!isCurrent() || !getBucket(sessionId).tabs.some((candidate) => candidate.id === tab.id)) return;
  await moveWorkbenchToFront(sessionId, tab.id);
  if (isCurrent() && readPanelCollapsedRecord('right-tabs', { sessionId }) !== true
    && getBucket(sessionId).tabs.some((candidate) => candidate.id === tab.id)) {
    requestRightSidebarVisibility('open', { sessionId, userInitiated: false });
  }
}

/**
 * 用户点伙伴聊天头部的「工作台」:常驻入口。标签被关掉了就重建并排到最前,
 * 还在就切到它;无论右侧栏当前收起还是分离出去,都把它打开。
 * 与 `openRoutinesTab` 同一套路,保留用户已有的 attached / detached 选择。
 */
export async function openBotWorkbenchTab(sessionId: string, botId: string): Promise<void> {
  const owner = getDataOwnerGeneration();
  const route = await routeSidebarCommand({ type: 'open-bot-workbench-tab', sessionId, botId, focusTab: true });
  if (!isDataOwnerGenerationCurrent(owner)) return;
  // The detached receiver activates the tab but its visibility listener is a
  // no-op for open. The main window must also bring an already open host forward.
  if (route === 'routed') requestRightSidebarVisibility('open', { sessionId });
  if (route === 'attached') {
    await ensureHydrated(sessionId);
    if (!isDataOwnerGenerationCurrent(owner)) return;
    const existed = getBucket(sessionId).tabs.some((tab) => tab.kind === 'bot-workbench');
    writePanelCollapsed('right-tabs', { sessionId }, false);
    const tab = await addOrFocusSingletonTab(sessionId, 'bot-workbench', { botId });
    if (!existed && isDataOwnerGenerationCurrent(owner) && getBucket(sessionId).tabs.some((candidate) => candidate.id === tab.id)) {
      await moveWorkbenchToFront(sessionId, tab.id);
    }
    if (isDataOwnerGenerationCurrent(owner) && readPanelCollapsedRecord('right-tabs', { sessionId }) !== true
      && getBucket(sessionId).tabs.some((candidate) => candidate.id === tab.id)) {
      requestRightSidebarVisibility('open', { sessionId });
    }
  }
}
