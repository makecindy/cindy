/**
 * openInSidebarFileBrowser —— "在侧边栏文件浏览器中定位目录 / 文件"的统一入口。
 *
 * 聊天流的目录 chip(assistant 输出 `./Skills`、`src/components/` 这类真实存在
 * 的目录)点击后经这里把 RSB 的 file-browser tab 带出来并定位到该目录:
 *   1. 已有 file-browser tab → 激活它;没有 → 新建(file-browser 事实上单例,
 *      与 AddTabDropdown 的行为一致);
 *   2. 通过 plugin state 写入 revealDirPath + 自增 revealDirNonce,
 *      FileBrowserBody 侧 effect 消费后展开父目录 + 展开该目录 + 滚动到行
 *      (nonce 保证重复点击同一目录也能再次触发 reveal);
 *   3. 请求右侧栏可见(与 openUrlInSidebarBrowser 同款)。
 *
 * 远程会话零特判:file-browser plugin 自身已按 session 的 remoteHostId/deviceId
 * 路由到远端 file-service / device-link,目录定位只是树内导航。
 */

import { addTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { routeSidebarCommand } from './detachedSidebarRouting';

/** 在指定 session 的侧边栏文件浏览器里定位到 workdir 相对目录,并确保侧边栏可见。 */
export async function openDirInSidebarFileBrowser(
  sessionId: string,
  relDirPath: string,
): Promise<void> {
  const routeResult = await routeSidebarCommand({
    type: 'open-file-browser',
    sessionId,
    relPath: relDirPath,
    targetKind: 'directory',
  });
  if (routeResult !== 'attached') {
    if (routeResult !== 'routed') return;
    requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  const bucket = getBucket(sessionId);
  const existing = bucket.tabs.find((t) => t.kind === 'file-browser');
  if (existing) {
    if (bucket.activeTabId !== existing.id) {
      await setActiveTab(sessionId, existing.id);
    }
    await patchTabState(sessionId, existing.id, (current) => {
      const base =
        typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
      const nonce = typeof base.revealDirNonce === 'number' ? base.revealDirNonce : 0;
      return { ...base, revealDirPath: relDirPath, revealDirNonce: nonce + 1 };
    });
  } else {
    await addTab(sessionId, 'file-browser', {
      selectedFilePath: null,
      revealDirPath: relDirPath,
      revealDirNonce: 1,
    });
  }
  requestRightSidebarVisibility('open', { sessionId });
}

/** 在指定 session 的侧边栏文件浏览器里打开 workdir 相对文件,并确保侧边栏可见。 */
export async function openFileInSidebarFileBrowser(
  sessionId: string,
  relFilePath: string,
  options?: { userInitiated?: boolean },
): Promise<void> {
  const command = {
    type: 'open-file-browser' as const,
    sessionId,
    relPath: relFilePath,
    targetKind: 'file' as const,
  };
  const routeResult = await (options ? routeSidebarCommand(command, options) : routeSidebarCommand(command));
  if (routeResult !== 'attached') {
    if (routeResult !== 'routed') return;
    requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  const bucket = getBucket(sessionId);
  const existing = bucket.tabs.find((t) => t.kind === 'file-browser');
  if (existing) {
    if (bucket.activeTabId !== existing.id) {
      await setActiveTab(sessionId, existing.id);
    }
    await patchTabState(sessionId, existing.id, (current) => {
      const base =
        typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
      const nonce = typeof base.revealFileNonce === 'number' ? base.revealFileNonce : 0;
      return {
        ...base,
        revealFilePath: relFilePath,
        revealFileNonce: nonce + 1,
      };
    });
  } else {
    await addTab(sessionId, 'file-browser', {
      selectedFilePath: relFilePath,
      revealFilePath: relFilePath,
      revealFileNonce: 1,
    });
  }
  requestRightSidebarVisibility('open', { sessionId });
}

/**
 * 在指定 session 的侧边栏文件浏览器里打开 workdir 外的本地文件。
 * FileBrowserBody 会复用外部文件拖入链路消费该请求，因此格式校验、dirty guard
 * 与只读预览语义保持一致；绝对路径不会被挂进当前 workdir 的文件树。
 */
export async function openExternalFileInSidebarFileBrowser(
  sessionId: string,
  absFilePath: string,
): Promise<void> {
  const routeResult = await routeSidebarCommand({
    type: 'open-file-browser',
    sessionId,
    absPath: absFilePath,
    targetKind: 'external-file',
  });
  if (routeResult !== 'attached') {
    if (routeResult !== 'routed') return;
    requestRightSidebarVisibility('open', { sessionId });
    return;
  }
  await ensureHydrated(sessionId);
  const bucket = getBucket(sessionId);
  const existing = bucket.tabs.find((t) => t.kind === 'file-browser');
  if (existing) {
    if (bucket.activeTabId !== existing.id) {
      await setActiveTab(sessionId, existing.id);
    }
    await patchTabState(sessionId, existing.id, (current) => {
      const base =
        typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
      const nonce = typeof base.externalFileNonce === 'number' ? base.externalFileNonce : 0;
      return {
        ...base,
        externalFilePath: absFilePath,
        externalFileNonce: nonce + 1,
      };
    });
  } else {
    await addTab(sessionId, 'file-browser', {
      selectedFilePath: null,
      externalFilePath: absFilePath,
      externalFileNonce: 1,
    });
  }
  requestRightSidebarVisibility('open', { sessionId });
}
