import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { makeGenericNewMakerRouteState } from '../lib/genericNewMakerRouteState';

/**
 * 打开「新建任务」草稿页。左上角导航行的「新建」和任务列表段头最右侧的「＋」共用
 * 这一份,保证两处打开的草稿预选同一台电脑、同一个项目(恢复上次成功创建的工作区,
 * 见 #11420),而不是同一个动作在两条调用链上慢慢漂移。
 *
 * 不读侧栏的机器范围:段头标题表示「你在看什么」,不表示「新任务去哪台电脑」。
 * 带设备归属的入口(项目行、对话组头)走各自的 onCreateDialogue,与这里刻意分开。
 */
export function useNewMakerDraftEntry(): () => void {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return useCallback(() => {
    navigate('/cc-agent/new', { state: makeGenericNewMakerRouteState(pathname) });
  }, [navigate, pathname]);
}
