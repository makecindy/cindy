/**
 * hook 运行时探测:检查用户机器上是否有可用的系统 node。
 *
 * 用途:AI 生成前置检查脚本时决定命令形态——
 *   - 系统 node 可用 → `node <script>`(透明、可在任何终端复现)
 *   - 不可用 → `xdt-node <script>`(执行器解析为 app 随包原生 Node 运行器,
 *     见 pre-run-hook.resolveHookCommand;无法启动 Node 时明确失败并阻止本轮)
 *
 * 结果按进程生命周期 + TTL 缓存:探测是 spawn 子进程的开销,而 node 的
 * 有无在一次 app 运行期间几乎不变;TTL 让"用户刚装完 node"无需重启也能
 * 在几分钟后被感知。探测失败(超时/异常)一律按"不可用"处理——方向安全,
 * xdt-node 执行器要求 gate 正文 entered/completed 与真实 Node/shell 退出一致；缺少资产或协议时明确失败，不放行。
 */

import { spawn } from 'node:child_process';

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;

let cached: { value: boolean; at: number } | null = null;

/** 探测一条命令能否成功执行(exit 0)。shell:true 走 PATH 解析,与 hook 执行同环境。 */
function probeCommand(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    let child: ReturnType<typeof spawn>;
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      settle(false);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    try {
      child = spawn(command, { shell: true, windowsHide: true, stdio: 'ignore' });
    } catch {
      settle(false);
      return;
    }
    child.on('error', () => settle(false));
    child.on('close', (code) => settle(code === 0));
  });
}

/** 系统 node 是否可用(缓存 + TTL)。测试可传 forceProbe 绕过缓存。 */
export async function hasSystemNode(opts?: { forceProbe?: boolean }): Promise<boolean> {
  const now = Date.now();
  if (!opts?.forceProbe && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await probeCommand('node --version');
  cached = { value, at: now };
  return value;
}

/** 测试辅助:清缓存。 */
export function __resetHookRuntimeCacheForTest(): void {
  cached = null;
}
