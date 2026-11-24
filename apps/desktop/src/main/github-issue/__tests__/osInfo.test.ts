/**
 * Issue #12421: 反馈环境的 OS 行要显示用户能在「关于本机」核对的系统版本。
 *
 * 测试价值
 * - 生产入口与可观察结果：readOsInfo 决定 issue 正文「**OS**: darwin arm64 (…)」
 *   与确认卡片 envLine 里的版本号；用户看到的就是这个字符串。
 * - Bug／规则依据：issue #12421 —— macOS 上 os.release() 是 Darwin 内核 27.0.0，
 *   与「关于本机」的 27.0.1 对不上。
 * - 现有覆盖缺口：submit service 测试只注入固定 osVersion，不验证取值来源。
 * - 最小失败输入：darwin + getSystemVersion()='27.0.1'，旧实现返回宿主 os.release()。
 * - tier：unit（纯函数、注入进程信息，不启动 Electron）；单独运行约 0.7s。
 *
 * 不并入 submit service 测试：那边只注入固定 osVersion，测不到取值来源；本文件独占
 * 「平台 → 版本来源」矩阵。
 */

import os from 'node:os';
import { describe, expect, it } from 'vitest';

import { readOsInfo } from '../osInfo';

describe('readOsInfo', () => {
  it('macOS 用系统版本而不是内核版本', () => {
    expect(
      readOsInfo({
        platform: 'darwin',
        arch: 'arm64',
        getSystemVersion: () => '27.0.1',
      }),
    ).toEqual({ platform: 'darwin', arch: 'arm64', osVersion: '27.0.1' });
  });

  it('没有 getSystemVersion 时回退 os.release()（旧 Electron / 非 Electron 环境）', () => {
    expect(readOsInfo({ platform: 'darwin', arch: 'arm64' }).osVersion).toBe(os.release());
  });

  it('Windows 的 getSystemVersion 原样保留，不改写成营销版本号', () => {
    expect(
      readOsInfo({
        platform: 'win32',
        arch: 'x64',
        getSystemVersion: () => '10.0.22631',
      }),
    ).toEqual({ platform: 'win32', arch: 'x64', osVersion: '10.0.22631' });
  });
});
