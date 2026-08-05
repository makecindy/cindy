/**
 * FeishuConflictDialogHost
 * ---------------------------------------------------------------------------
 * 全局挂载在 App 根的 host：订阅 main 推送的 feishuBot:conflict 事件，
 * 弹出 FeishuConflictDialog。
 *
 * 不要在 SettingsView 里 mount——SettingsView 不一定打开（用户可能在主聊天界面），
 * 而 conflict 可能在 app 启动时（Settings 还没渲染）就触发。所以放 App.tsx 顶层。
 */

import { useCallback, useEffect, useState } from 'react';

import { FeishuConflictDialog } from './FeishuConflictDialog';

const FEISHU_OPEN_PLATFORM_URL = 'https://open.feishu.cn/app?lang=zh-CN';

export function FeishuConflictDialogHost() {
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = window.electronAPI.feishuBot.onConflict((payload) => {
      setAppId(payload.appId);
      setOpen(true);
    });
    return unsub;
  }, []);

  const handleDismiss = useCallback(() => {
    setOpen(false);
  }, []);

  const handleCreateOwnApp = useCallback(() => {
    setOpen(false);
    window.electronAPI.openExternal?.(FEISHU_OPEN_PLATFORM_URL);
  }, []);

  return (
    <FeishuConflictDialog
      open={open}
      appId={appId}
      onDismiss={handleDismiss}
      onCreateOwnApp={handleCreateOwnApp}
    />
  );
}
