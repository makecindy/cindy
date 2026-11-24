/**
 * 反馈环境里的 OS 信息。版本取用户能在「关于本机」核对的系统版本：Electron
 * getSystemVersion 在 macOS 返回 27.0.1，而 os.release() 是 Darwin 内核 27.0.0
 * (issue #12421)。Windows / Linux 两者同值，行为不变；缺 API 时回退 os.release()，
 * 与 device-link 的取值方式一致。
 */

import os from 'node:os';

interface SystemVersionProcess {
  platform: string;
  arch: string;
  getSystemVersion?: () => string;
}

export interface IssueOsInfo {
  platform: string;
  arch: string;
  osVersion: string;
}

export function readOsInfo(proc: SystemVersionProcess = process): IssueOsInfo {
  return {
    platform: proc.platform,
    arch: proc.arch,
    osVersion: proc.getSystemVersion?.() || os.release(),
  };
}
