/**
 * runInTerminal —— 把一段命令写到 RSB 内置终端执行。
 * ---------------------------------------------------------------------------
 * 流程:
 *   1. ensureHydrated(sessionId) 确保 bucket 已加载(避免在 IPC list 完成前
 *      乐观建 tab,与 hydrate 结果合并冲突)
 *   2. requestRightSidebarVisibility('open') 展开 RSB,让用户看到执行结果
 *   3. addOrFocusSingletonTab(sessionId, 'terminal') 复用已有 terminal tab
 *      或新建一个(cwd 由 TerminalTabBody 从 session workdir 取,这里不管)
 *   4. 等 PTY created —— TerminalTabBody 在 mount 后的 useEffect 里异步 spawn
 *      PTY,建 tab 后立即 write 会拿到 main 端 TERMINAL_NOT_FOUND
 *   5. terminal.write(tabId, command + '\n') 把命令喂给 PTY
 *
 * 多行命令整块写入:PTY 是真实 shell,会逐行执行(与用户逐行手敲等价)。
 */

import {
  addOrFocusSingletonTab,
  ensureHydrated,
  getBucket,
  subscribe,
} from '@/features/right-sidebar/store';
import { requestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';

/** 等 PTY spawn 的最长时限。TerminalTabBody 的 create 通常 < 200ms,5s 足够兜底。 */
const PTY_READY_TIMEOUT_MS = 5000;

interface TerminalStateLike {
  created?: boolean;
}

type TerminalReadiness = 'ready' | 'missing' | 'pending';

/**
 * 读取指定 terminal tab 的 PTY 就绪状态。
 * - 'ready'   — tab 存在且 state.created === true,可以 write
 * - 'missing' — tab 已不在 store(被用户关闭 / session 切换 / 水合重置),
 *                调用方不应继续等
 * - 'pending' — tab 存在但 PTY 尚未 spawn 完成,需继续等
 */
function readTerminalStatus(sessionId: string, tabId: string): TerminalReadiness {
  const bucket = getBucket(sessionId);
  const tab = bucket.tabs.find((t) => t.id === tabId);
  if (!tab) return 'missing';
  const state = tab.state as TerminalStateLike | null;
  return state?.created === true ? 'ready' : 'pending';
}

/**
 * 等待指定 terminal tab 的 PTY 就绪(state.created === true)。
 *
 * TerminalTabBody 挂载后异步调 terminal.create spawn PTY,成功后 patchState
 * ({ created: true })。subscribe 监听 store 变化,state 翻 true 后立即返回;
 * tab 被销毁(用户手关 / session 切换)时立即返回 false,不等超时;
 * 超时则放弃,调用方据 false 决定是否报错。
 *
 * 生命周期保证:无论走哪条出口(ready / missing / timeout),subscribe 都会被
 * 取消,timer 会被清除,不会泄漏。
 */
function waitForTerminalReady(
  sessionId: string,
  tabId: string,
  timeoutMs = PTY_READY_TIMEOUT_MS,
): Promise<boolean> {
  const initial = readTerminalStatus(sessionId, tabId);
  if (initial === 'ready') return Promise.resolve(true);
  if (initial === 'missing') return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve(ok);
    };
    const unsubscribe = subscribe(() => {
      const status = readTerminalStatus(sessionId, tabId);
      if (status === 'ready') finish(true);
      else if (status === 'missing') finish(false);
    });
    const timer = window.setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * 归一化命令以安全写入 PTY。
 *
 * - `\r\n` / 单独 `\r` 统一成 `\n`:PTY host(node-pty / xterm.js)把 `\n` 当
 *   Enter 处理,不需要 `\r`;残留 `\r` 在某些 shell(cmd.exe)里会被当作额外
 *   按键,导致空行或意外行为。
 * - 去掉尾部多余空行,只保留一个 `\n`:多行命令最后一条也要按 Enter 提交,
 *   但连续多个 Enter 只会产生空提示符。
 *
 * 多行命令(heredoc / for 循环 / 续行)整块写入,shell 逐行执行,与用户
 * 逐行手敲等价。
 */
export function normalizeCommand(command: string): string {
  const normalized = command.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return normalized + '\n';
}

/**
 * 把命令写到 RSB 内置终端执行。
 *
 * - 没有 terminal tab 则新建一个;已有则复用并激活
 * - RSB 折叠态会自动展开;detached 子窗口不抢前台(由 visibility 订阅方决定)
 * - 命令多行时整块写入,PTY shell 逐行执行
 *
 * @returns 成功返回 true;终端 PTY 未在时限内就绪或 tab 被销毁返回 false
 *          (调用方应 toast 提示)
 */
export async function runInTerminal(sessionId: string, command: string): Promise<boolean> {
  await ensureHydrated(sessionId);
  requestRightSidebarVisibility('open', { sessionId });
  const tab = await addOrFocusSingletonTab(sessionId, 'terminal');
  const ready = await waitForTerminalReady(sessionId, tab.id);
  if (!ready) return false;
  await window.electronAPI.terminal.write(tab.id, normalizeCommand(command));
  return true;
}
