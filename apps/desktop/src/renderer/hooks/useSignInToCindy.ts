/**
 * useSignInToCindy — 从应用内发起 Cindy 登录的唯一正确通路。
 *
 * local 模式下直接 navigate('/login') 会被 GuestRoute 弹回首页(它对
 * mode==='local' 一律 redirect),必须先 exitLocalMode() 把会话切回 signed-out
 * 再进登录页——与 settings/UserProfileCard 的既有做法同通路(2026-07-24 实踩:
 * 引导卡/banner/供应商页三处直跳 /login 全部无效)。
 *
 * 数据语义:exitLocalMode 不删除 local 命名空间(local-v1)的任何数据;登录后
 * data owner 切到账号命名空间,local 数据保留在盘上但不合并、不可见(再次进入
 * 本地模式可找回)。
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function useSignInToCindy(): () => Promise<void> {
  const { mode, exitLocalMode } = useAuth();
  const navigate = useNavigate();

  return useCallback(async () => {
    if (mode === 'local') await exitLocalMode();
    navigate('/login');
  }, [mode, exitLocalMode, navigate]);
}
