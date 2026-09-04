/**
 * useConfirmSwitchAwayIfDirty —— 切走当前 active 文件之前的统一 dirty 拦截。
 *
 * 用在所有"会让 active 文件被换掉"的入口:
 *   - WorkdirBrowseRoute.handleActivate(file tab 切换)
 *   - WorkdirBrowseSidebar.handleSelectFile(文件树点击)
 *   - WorkdirBrowseSidebar.handleOpenMatch(搜索结果跳转)
 *   - WorkdirBrowseSidebar.handleBack / handleSwitchProject(离开当前文件上下文)
 *
 * 行为:
 *   - 切到同一文件 → 直接放行(不打扰)。
 *   - 没有 active FileBodyView / 不 dirty → 直接放行。
 *   - dirty → 弹三选一 dialog:
 *       保存(primary)   → save() 成功才放行,失败留在原文件(由 FileBodyView
 *                          内部显示 saveError)。
 *       不保存(tertiary) → 放行,丢弃改动。
 *       取消(cancel/Esc) → 阻止切换,留在当前文件。
 *
 * 返回值:Promise<boolean>。true = 放行执行切换;false = 阻止。
 */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

import { getActiveFileBodyHandle } from '../lib/activeFileBodyHandle';

export function useConfirmSwitchAwayIfDirty() {
  const { t } = useTranslation();
  const { confirmThree } = useConfirmDialog();

  return useCallback(
    async (currentRelPath: string | null, nextRelPath: string | null): Promise<boolean> => {
      if (!currentRelPath || (nextRelPath !== null && currentRelPath === nextRelPath)) return true;
      const handle = getActiveFileBodyHandle();
      if (!handle || !handle.isDirty()) return true;
      const choice = await confirmThree({
        title: t('ccAgent.workdirBrowse.confirmSwitchAway.title'),
        description: t('ccAgent.workdirBrowse.confirmSwitchAway.descriptionSwitchFile', { path: currentRelPath }),
        confirmText: t('ccAgent.workdirBrowse.confirmSwitchAway.saveAndSwitch'),
        tertiaryText: t('ccAgent.workdirBrowse.confirmSwitchAway.tertiary'),
        cancelText: t('ccAgent.workdirBrowse.confirmSwitchAway.cancel'),
      });
      if (choice === 'cancel') return false;
      if (choice === 'tertiary') return true;
      // choice === 'confirm' → 触发保存,成功才放行;失败留在原文件让用户看错误。
      return await handle.save();
    },
    [confirmThree, t],
  );
}

/**
 * 副窗口宿主关闭前的统一 dirty 预检。
 *
 * 普通任务路由的可编辑文件位于右侧栏，路由宿主拿不到 selectedPath；从当前
 * FileBodyView handle 读取路径，复用与关 tab 相同的保存／不保存／取消语义。
 */
export function useConfirmCloseActiveFileIfDirty() {
  const { t } = useTranslation();
  const { confirmThree } = useConfirmDialog();

  return useCallback(async (): Promise<boolean> => {
    const handle = getActiveFileBodyHandle();
    if (!handle || !handle.isDirty()) return true;
    const choice = await confirmThree({
      title: t('ccAgent.workdirBrowse.confirmSwitchAway.title'),
      description: t('ccAgent.workdirBrowse.confirmSwitchAway.descriptionCloseTab', {
        path: handle.relPath ?? '',
      }),
      confirmText: t('ccAgent.workdirBrowse.confirmSwitchAway.save'),
      tertiaryText: t('ccAgent.workdirBrowse.confirmSwitchAway.tertiary'),
      cancelText: t('ccAgent.workdirBrowse.confirmSwitchAway.cancel'),
    });
    if (choice === 'cancel') return false;
    if (choice === 'tertiary') return true;
    return await handle.save();
  }, [confirmThree, t]);
}
