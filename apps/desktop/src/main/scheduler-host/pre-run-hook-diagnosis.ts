/**
 * 检查脚本拦下本轮时补上「所属插件不可用」的诊断。独立成模块：诊断由宿主注入，
 * scheduler-host 不直接依赖插件系统；执行器的进程语义不受影响。
 */

import type { PreRunHookMissingPlugin, PreRunHookRunResult } from '@cindy/maker-scheduler';

/** 返回检查脚本所属、当前不可用的插件；与插件无关时返回 undefined。 */
export type DiagnosePreRunHookFailure = (
  command: string,
) => Promise<PreRunHookMissingPlugin | undefined>;

/** 拦下本轮时补上缺失插件的诊断；诊断失败不改变 fail-closed 结果。 */
export async function withPreRunHookDiagnosis(
  hook: PreRunHookRunResult,
  command: string,
  diagnose: DiagnosePreRunHookFailure | undefined,
): Promise<PreRunHookRunResult> {
  if (hook.decision !== 'block' || !diagnose) return hook;
  try {
    const missingPlugin = await diagnose(command);
    return missingPlugin ? { ...hook, missingPlugin } : hook;
  } catch {
    return hook;
  }
}
