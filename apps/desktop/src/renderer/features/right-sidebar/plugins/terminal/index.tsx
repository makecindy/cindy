/**
 * terminal plugin —— RSB 内嵌终端（PTY 后端 + xterm.js）。
 *
 * State 设计（最小化）：
 *   - `created`：PTY 是否已在 main 端起来。从 hydrate 拿到 true 时也不立即重建,
 *     用户切回 tab 时若 PTY 已死 main 会回 TERMINAL_NOT_FOUND,renderer 会触发 restart。
 *     最简实现:hydrate 后强制设 false,确保切回来重新 create PTY(因为 main 进程重启后
 *     肯定没存 PTY)。
 *   - `exited`：PTY 退出快照。null = 仍在运行。
 *   - `title` / `shellId` / `shellDisplayName`：UI 显示用。
 *
 * 持久化语义：PTY 进程跟 main 生命周期绑定,app 重启就死,因此 `created` / `exited`
 * 都不持久化(hydrate 强制 reset)；title / shellId 持久化让用户重启后 tab pill 不闪。
 *
 * 注册：模块顶层 import-side-effect。plugins/index.ts 把它 import 进来。
 */

import { lazy } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const TerminalTabBody = lazy(() =>
  import('./TerminalTabBody').then((module) => ({ default: module.TerminalTabBody })),
);

export interface TerminalState {
  /** PTY 是否已在 main 端 spawn。每次 app 启动后 hydrate 强制设 false（PTY 死了） */
  created: boolean;
  /** PTY 退出快照，null = 仍在运行 */
  exited: { code: number | null; signal: string | null } | null;
  /** 用户自定义 tab title（v1 不开放 UI 修改，留扩展） */
  title: string;
  /** auto-detect / pref 选中的 shell id；hydrate 不强制清,显示用 */
  shellId: string;
  /** UI 显示用("zsh" / "PowerShell" / "Git Bash"...) */
  shellDisplayName: string;
}

const DEFAULT_STATE: TerminalState = {
  created: false,
  exited: null,
  title: '',
  shellId: '',
  shellDisplayName: '',
};

function TerminalTabPillTitle({ state, t }: { state: TerminalState; t: TFunction }) {
  if (state.title) return <>{state.title}</>;
  return <>{t('rightSidebar.terminal.defaultTitle')}</>;
}

function TerminalTabPillIcon() {
  return <TerminalIcon size={13} />;
}

const plugin: TabKindPlugin<TerminalState> = {
  kind: 'terminal',
  menu: {
    kind: 'terminal',
    labelKey: 'rightSidebar.tabs.kinds.terminal',
    icon: TerminalIcon,
    order: 30, // file-browser=10, web-browser=20, terminal=30
    enabled: true,
  },
  TabPillTitle: TerminalTabPillTitle,
  TabPillIcon: TerminalTabPillIcon,
  TabBody: TerminalTabBody,
  defaultState: () => ({ ...DEFAULT_STATE }),
  hydrateState: (raw): TerminalState => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    const obj = raw as Record<string, unknown>;
    return {
      // PTY 进程跟 main 生命周期绑定:app 重启后旧 PTY 已死,强制 created=false 重新创建
      created: false,
      exited: null,
      title: typeof obj.title === 'string' ? obj.title : DEFAULT_STATE.title,
      shellId: typeof obj.shellId === 'string' ? obj.shellId : DEFAULT_STATE.shellId,
      shellDisplayName:
        typeof obj.shellDisplayName === 'string'
          ? obj.shellDisplayName
          : DEFAULT_STATE.shellDisplayName,
    };
  },
  /** 关 tab 时(store.closeTab 调)：先让 main 端 dispose PTY,再清渲染端 xterm。 */
  onBeforeClose: async (_state, ctx) => {
    try {
      await window.electronAPI.terminal.dispose(ctx.tabId);
    } catch {
      /* 已经 disposed / not found 都静默 */
    }
    const { disposeXterm } = await import('./lib/xtermPool');
    disposeXterm(ctx.tabId);
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
