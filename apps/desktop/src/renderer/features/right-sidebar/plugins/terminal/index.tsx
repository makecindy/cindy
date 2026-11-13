/**
 * terminal plugin —— RSB 内嵌终端（PTY 后端 + xterm.js）。
 *
 * State 设计（最小化）：
 *   - `created`：本 renderer 已创建或接管 PTY。宿主每次渲染都会 hydrate,
 *     所以只在 rendererInstanceId 不匹配时复位,不能抹掉运行中的 patch。
 *   - `exited`：PTY 退出快照。null = 仍在运行。
 *   - `title` / `shellId` / `shellDisplayName`：UI 显示用。
 *
 * 持久化语义：PTY 进程跟 main 生命周期绑定,app 重启就死,因此 `created` / `exited`
 * 在新 renderer 里复位；title / shellId 持久化让用户重启后 tab pill 不闪。
 *
 * 注册：模块顶层 import-side-effect。plugins/index.ts 把它 import 进来。
 */

import { lazy } from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';
import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';
import { finishClosing, markClosing } from '../../lib/tabClosingSignal';

const TerminalTabBody = lazy(() =>
  import('./TerminalTabBody').then((module) => ({ default: module.TerminalTabBody })),
);

/** Renderer-local identity distinguishes live patches from a persisted snapshot. */
export const TERMINAL_RENDERER_INSTANCE_ID = crypto.randomUUID();

export interface TerminalState {
  rendererInstanceId?: string;
  /** PTY 是否已在 main 端 spawn / attach。新 renderer 必须重新 create / attach。 */
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
  rendererInstanceId: TERMINAL_RENDERER_INSTANCE_ID,
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
    descriptionKey: 'rightSidebar.tabs.descriptions.terminal',
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
    const currentRenderer = obj.rendererInstanceId === TERMINAL_RENDERER_INSTANCE_ID;
    const exit = obj.exited as Partial<NonNullable<TerminalState['exited']>> | undefined;
    return {
      rendererInstanceId: currentRenderer ? TERMINAL_RENDERER_INSTANCE_ID : undefined,
      created: currentRenderer && obj.created === true,
      exited: currentRenderer && exit &&
        (exit.code === null || (typeof exit.code === 'number' && Number.isFinite(exit.code))) &&
        (exit.signal === null || typeof exit.signal === 'string')
        ? { code: exit.code, signal: exit.signal } : null,
      title: typeof obj.title === 'string' ? obj.title : DEFAULT_STATE.title,
      shellId: typeof obj.shellId === 'string' ? obj.shellId : DEFAULT_STATE.shellId,
      shellDisplayName:
        typeof obj.shellDisplayName === 'string'
          ? obj.shellDisplayName
          : DEFAULT_STATE.shellDisplayName,
    };
  },
  /** Release the PTY first; the store owns renderer cleanup after committed removal. */
  onBeforeClose: async (_state, ctx) => {
    markClosing(ctx.tabId);
    try {
      const { getXterm } = await import('./lib/xtermPool');
      const original = getXterm(ctx.tabId);
      const retainedContext = original?.remoteContext;
      const deviceId = getSessionDeviceId(ctx.sessionId);
      // Prefer the retained origin; otherwise send the tab's task identity for
      // main to match against its saved PTY. Missing device metadata cannot grant
      // another window authority over a PTY whose saved identity includes a device.
      const context = retainedContext ?? (deviceId ? { sessionId: ctx.sessionId, deviceId } : { sessionId: ctx.sessionId });
      await window.electronAPI.terminal.dispose(ctx.tabId, context);
      // Snapshot restoration transfers close-listener ownership to the live
      // entry. A removed/replaced lifetime must not consume this late release.
      const retained = getXterm(ctx.tabId);
      if (original && retained?.closing && retained.closeCancelledListeners === original.closeCancelledListeners) {
        retained.ptyAttached = false;
      }
    } catch {
      // store.closeTab ignores thrown errors; only false preserves the tab.
      // The store does not finishClosing when the hook vetoes.
      finishClosing(ctx.tabId);
      toast.error(i18n.t('rightSidebar.terminal.closeFailed'));
      return false;
    }
  },
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
