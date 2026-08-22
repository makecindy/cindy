/**
 * workdir probe host wire format.
 *
 * The utility process only returns booleans, a resolved path the parent itself
 * asked to validate, or a stable filesystem error code. It never returns host
 * error messages to avoid leaking local filesystem details across the process
 * boundary.
 *
 * Job kinds:
 *   - probe:        stat(dir) → isDirectory(远程会话创建的目录可用性守卫)
 *   - validate:     realpath → stat → 'wx' 写探针 → 清理(IM 渠道**新选择**目录
 *                   的严格校验)。realPath 是父进程自己提交的路径经符号链接
 *                   解析后的形式, 回传给提交者不构成越权泄漏。
 *   - availability: stat → 'wx' 写探针 → 清理(IM 渠道**已保存**目录的可用性
 *                   探测, 失败宽大降级为不可用)。
 */

export interface WorkdirProbeRequest {
  kind: 'probe' | 'validate' | 'availability';
  id: number;
  dir: string;
}

export type WorkdirProbeResult =
  | { ok: true; isDirectory: boolean }
  | { ok: true; realPath: string }
  | { ok: true; usable: boolean }
  | { ok: false; code: string };

/** 各 job 的窄返回形态(客户端按 job 收口, 形态不符按执行边界故障 fail-closed)。 */
export type WorkdirProbeStatResult = { ok: true; isDirectory: boolean } | { ok: false; code: string };
export type WorkdirValidateResult = { ok: true; realPath: string } | { ok: false; code: string };
export type WorkdirAvailabilityResult = { ok: true; usable: boolean } | { ok: false; code: string };

export interface WorkdirProbeResponse {
  kind: 'result';
  id: number;
  result: WorkdirProbeResult;
}
