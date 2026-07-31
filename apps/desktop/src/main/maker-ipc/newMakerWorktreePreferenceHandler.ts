/**
 * 新建会话 worktree 偏好写穿 IPC。
 *
 * device-link 调用由主进程内的 invoke context + allowlist 证明来源；本机调用必须额外
 * 校验 Cindy 自有顶层 Renderer，避免 WebView / Ghost 修改后续会话创建偏好。
 */
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface NewMakerWorktreePreferenceHandlerDeps {
  isDeviceLinkInvoke(): boolean;
  assertTrustedCaller(event: unknown): void;
  broadcast(
    channel: typeof MAKER_PUSH.WORKTREE_PREF_APPLY,
    payload: { worktreeEnabled: boolean },
  ): void;
}

export function registerNewMakerWorktreePreferenceHandler(
  registry: IpcHandlerRegistry,
  deps: NewMakerWorktreePreferenceHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.APPLY_NEW_MAKER_WORKTREE_PREF, (event, pref: unknown) => {
    if (!deps.isDeviceLinkInvoke()) {
      deps.assertTrustedCaller(event);
    }
    if (!pref || typeof pref !== 'object') {
      throwIpcError('INVALID_PARAMS', 'pref required');
    }
    const p = pref as { worktreeEnabled?: unknown };
    if (typeof p.worktreeEnabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'worktreeEnabled must be boolean');
    }
    deps.broadcast(MAKER_PUSH.WORKTREE_PREF_APPLY, {
      worktreeEnabled: p.worktreeEnabled,
    });
  });
}
