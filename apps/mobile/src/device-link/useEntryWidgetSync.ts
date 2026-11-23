/**
 * 把「新建任务 + 伙伴」交给 Android 桌面入口组件。
 *
 * 桌面组件的目标不是系统的快捷方式列表：这里只写一个快照，交给系统的「添加小组件」。
 * 组件不联网、也不读登录态，所以内容变化、账号切换与退登都要由这里推过去 ——
 * 合并与清空的细节在 `entryWidgetWriter`。
 */
import { useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/auth/AuthContext';
import { cindyEntryWidget, writeEntryWidgetTargets } from '../../modules/cindy-entry-widget/src';
import { createEntryWidgetWriter } from './entryWidgetWriter';
import { useDesktopEntryIconResolver } from './useDesktopEntryIconResolver';
import { useDesktopEntryRows } from './useDesktopEntryRows';

export function useEntryWidgetSync(ready: boolean) {
  const auth = useAuth();
  const rows = useDesktopEntryRows();
  const { t } = useTranslation();
  const resolveIcon = useDesktopEntryIconResolver();
  const cindyTaskTitle = t('settings.entryWidget.cindyTask');
  // 账号切换 / 退登都会推进这个键：上一个账号的在途写入与图标缓存必须作废。
  const accountKey = `${auth.accountGeneration}:${auth.user?.id ?? ''}`;

  // 头像解析随登录态重建；写入队列只建一次，靠 ref 读最新的解析器。
  const resolver = useRef(resolveIcon);
  resolver.current = resolveIcon;
  const writer = useMemo(() => createEntryWidgetWriter({
    write: writeEntryWidgetTargets,
    resolveIcon: (row) => resolver.current(row),
  }), []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !cindyEntryWidget) return;
    // 登录态还没落定：先别动原生快照，等初始化结束后再写 / 清。
    if (!auth.initialized) return;
    void writer.update({
      accountKey,
      authenticated: auth.isAuthenticated,
      ready,
      rows,
      cindyTaskTitle,
    });
  }, [accountKey, auth.initialized, auth.isAuthenticated, cindyTaskTitle, ready, rows, writer]);
}
