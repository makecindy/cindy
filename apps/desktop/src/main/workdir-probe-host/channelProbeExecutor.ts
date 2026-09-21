/**
 * IM 渠道工作目录探测的有界异步执行器。
 *
 * 把渠道 store 的用户目录探测(realpath/stat/'wx' 写探针/清理)接到
 * Main 的共享调度器: 超时立即返回, 底层 IO 结束前继续占槽且保持去重。
 * 设置类最多占用一个槽, 为远程目录操作保留容量。仅由 im/index.ts
 * (Electron main)装配使用; 引入本模块即引入 electron。
 */

import { MainProcessWorkdirProbeError } from './MainProcessWorkdirProbeClient';
import { workdirProbeHostClient } from './index';
import type {
  ChannelUserDirProbeExecutor,
  UserDirAvailabilityOutcome,
  UserDirValidateOutcome,
} from '../im/shared/channelWorkingDirSettings';

function boundaryErrorCode(error: unknown): string {
  if (error instanceof MainProcessWorkdirProbeError) {
    return error.code === 'WORKDIR_PROBE_TIMEOUT' ? 'PROBE_TIMEOUT' : 'PROBE_UNAVAILABLE';
  }
  return 'PROBE_UNAVAILABLE';
}

export function createWorkdirProbeHostExecutor(): ChannelUserDirProbeExecutor {
  return {
    async validate(selectedPath: string, timeoutMs: number): Promise<UserDirValidateOutcome> {
      try {
        const result = await workdirProbeHostClient.validate(selectedPath, selectedPath, timeoutMs);
        if (result.ok) {
          return typeof result.realPath === 'string'
            ? { ok: true, realPath: result.realPath }
            : { ok: false, code: 'PROBE_UNAVAILABLE' };
        }
        // NOT_DIRECTORY / NOT_WRITABLE / 原生 fs 码原样交给 store 映射渠道码。
        return { ok: false, code: result.code };
      } catch (error) {
        return { ok: false, code: boundaryErrorCode(error) };
      }
    },
    async availability(candidate: string, timeoutMs: number): Promise<UserDirAvailabilityOutcome> {
      try {
        const result = await workdirProbeHostClient.availability(candidate, candidate, timeoutMs);
        if (result.ok) {
          return typeof result.usable === 'boolean'
            ? { ok: true, usable: result.usable }
            : { ok: false, code: 'PROBE_UNAVAILABLE' };
        }
        if (result.code === 'NOT_DIRECTORY') {
          // 不是目录 = 宽大降级为不可用, 不算执行边界故障。
          return { ok: true, usable: false };
        }
        return { ok: false, code: result.code };
      } catch (error) {
        return { ok: false, code: boundaryErrorCode(error) };
      }
    },
  };
}
