/** 执行 main 已裁决并推给当前 renderer host 的 RSB command。 */

import { ghostPanelKind } from '../../../../shared/ghost';
import type { RsbWindowCommand } from '../../../../shared/rightSidebarWindow';
import { addOrFocusSingletonTab, ensureHydrated } from '../store';
import {
  closeOrcaWorkersTabAfterTeamEnd,
  ensureOrcaWorkersTab,
} from '../plugins/orca-workers/actions';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from './openInSidebarFileBrowser';
import { openUrlInSidebarBrowser } from './openInSidebarBrowser';

/** 在 main 已选定的当前 renderer host 中执行命令，不自行选择宿主。 */
export async function executeSidebarCommand(command: RsbWindowCommand): Promise<void> {
  if (command.type === 'open-web-browser') {
    await openUrlInSidebarBrowser(command.sessionId, command.url);
    return;
  }
  if (command.type === 'open-file-browser') {
    if (command.targetKind === 'external-file') {
      await openExternalFileInSidebarFileBrowser(command.sessionId, command.absPath);
    } else if (command.targetKind === 'directory') {
      await openDirInSidebarFileBrowser(command.sessionId, command.relPath);
    } else {
      await openFileInSidebarFileBrowser(command.sessionId, command.relPath);
    }
    return;
  }
  if (command.type === 'ensure-orca-workers-tab') {
    await ensureOrcaWorkersTab(command.sessionId, {
      focusWorkerSessionId: command.focusWorkerSessionId,
      searchJump: command.searchJump,
      focusTab: command.focusTab === true,
    });
    return;
  }
  if (command.type === 'close-orca-workers-tab') {
    await closeOrcaWorkersTabAfterTeamEnd(command.sessionId);
    return;
  }
  if (command.type === 'open-ghost-tab') {
    // 插件页签与 review/terminal 同款单例语义:已开则聚焦,未开则新建。
    await ensureHydrated(command.sessionId);
    await addOrFocusSingletonTab(command.sessionId, ghostPanelKind(command.ghostId));
    return;
  }
  await ensureHydrated(command.sessionId);
  await addOrFocusSingletonTab(command.sessionId, 'terminal');
}
