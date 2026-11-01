/**
 * Bash 模拟桌面键鼠守卫 hook (PreToolUse)。
 *
 * 解决问题:
 *   cindy_computer 拒绝输入(Electron 文本框、模拟器窗口、系统 sheet)后,模型会退到
 *   `osascript … keystroke`、剪贴板 ⌘V、`cliclick`、自写 CGEvent 脚本或直接调
 *   cua-driver CLI。这些路径不认目标窗口、不认密码框、不给远程输入和正在用电脑的
 *   人让路,2026-10-31 复盘里真实打进了别的窗口(CU-014)。桌面输入只有一个入口。
 *
 * 行为:
 *   1. PreToolUse 阶段拿到 Bash 的 tool_input.command
 *   2. 命中 maker-core 共用判定 isShellDesktopInputCommand → permissionDecision=deny,
 *      理由指向 cindy_computer;其余命令原样放行,不改写
 *   3. Computer Use 未开启时同样拒绝,理由改为「请在设置里开启 Computer Use」:shell 模拟
 *      按键在任何档位都不是桌面操作的入口(2026-10-31 实测:关着 Computer Use 的沙箱里
 *      一条 keystroke 照样打进了前台窗口)
 *
 * 关键保证:
 *   - 与能力路由的 PreToolUse 守卫同一机制:完全访问档同样生效,
 *     不进 canUseTool,也不弹确认
 *   - 只看命令文本,fail-open:输入缺失或判定异常一律放行
 *   - matcher 是正则语义,'Bash' 也会命中 BashOutput 等工具名,hook 内严格等值判断
 *
 * 位置说明: 本文件在 host 层 (apps/desktop/src/main/maker-host/claude-hooks/),
 *           判定与理由在 maker-core shared/desktop-input-shell.ts,与 auto-review 共用。
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@cindy/maker-core';
import {
  isShellDesktopInputCommand,
  SHELL_DESKTOP_INPUT_DENIAL_CODE,
  SHELL_DESKTOP_INPUT_DENIAL_REASON,
} from '@cindy/maker-core';

const BASH_TOOL_NAME = 'Bash';

export const SHELL_DESKTOP_INPUT_DISABLED_REASON =
  `${SHELL_DESKTOP_INPUT_DENIAL_CODE}: desktop keyboard and mouse input is not available through the shell ` +
  '(osascript System Events keystroke/click, cliclick, CGEvent scripts, the cua-driver CLI ignore the target ' +
  'window and the person using this computer). Cindy Computer Use is disabled in Settings, so there is no ' +
  'desktop input entry in this task. Tell the person this step needs Computer Use: they can turn it on under ' +
  'Settings → Built-in tools → Computer Use (link: cindy://settings/builtin-tools; macOS also asks for ' +
  'Accessibility and Screen Recording there), then send the next message or start a new task so the ' +
  'cindy_computer tools appear. See cindy_helper get_capabilities({key:"computer-use"}).';

export function createDesktopInputShellGuardHooks(
  isComputerUseEnabled: () => boolean,
  logger?: Logger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== BASH_TOOL_NAME) return { continue: true };
    let command: string | undefined;
    try {
      const value = (pre.tool_input as { command?: unknown } | undefined)?.command;
      command = typeof value === 'string' ? value : undefined;
      if (!command || !isShellDesktopInputCommand(command)) {
        return { continue: true };
      }
    } catch (err) {
      logger?.warn('desktop input shell guard skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { continue: true };
    }
    let enabled = true;
    try {
      enabled = isComputerUseEnabled();
    } catch {
      enabled = true;
    }
    // Never log the command: the text being typed (`keystroke "…"`) is often exactly the
    // secret or message the model could not enter securely. Id and size are enough.
    logger?.warn('shell desktop input denied; cindy_computer is the only desktop input entry', {
      toolUseId: pre.tool_use_id,
      commandLength: command.length,
      computerUseEnabled: enabled,
    });
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: enabled
          ? SHELL_DESKTOP_INPUT_DENIAL_REASON
          : SHELL_DESKTOP_INPUT_DISABLED_REASON,
      },
    };
  };
  return { PreToolUse: [{ matcher: BASH_TOOL_NAME, hooks: [guard] }] };
}
