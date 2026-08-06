/**
 * 授权闸 —— 三条路径各自的放行条件（需求 §4.3）。
 *
 * 关键约束：
 *  - **手动上传**只要求「已配置目标 + 已同意《隐私政策》」。点击按钮本身即用户对这一次
 *    上传的意图，**不看「使用统计」开关**——那是行为埋点的偏好，与排障上传不是一件事；
 *    也**不读「崩溃时自动上传」开关**（连读都不读，见下方注释）。
 *  - **自动上传（崩溃）**额外要求用户显式开启了「崩溃时自动上传」，该开关默认关闭。
 *  - **授权判定必须读到最新值**：开发版与正式版共享同一份 userData，用户可能在另一个实例
 *    里刚刚关掉授权。所以每次判定前先让持久层现读盘（`refreshFromDisk`），不能用进程内的
 *    旧缓存继续上传。
 *  - 授权状态**读不出来时按「未知」处理**：不上传，但允许留下待补传标记，把最终判定留给
 *    下次启动时的可靠读取。
 *
 * 纯逻辑：所有读取注入。
 */

import type { LogUploadReason } from '../../shared/logUpload';

/** 闸的判定结果。三态，不是布尔——`unknown` 与 `denied` 对待补传标记的处置完全不同。 */
export type GateVerdict =
  /** 放行。 */
  | { kind: 'allowed' }
  /**
   * 明确拒绝（未配置 / 未同意 / 开关关闭）。自动路径命中时必须**清掉**已有的待补传标记：
   * 用户关闭授权后不得在下次启动偷偷补传（需求 §4.3 末条）。
   */
  | { kind: 'denied'; reason: 'not-configured' | 'no-consent' | 'crash-auto-off' }
  /**
   * 结论不明确（持久层读不出来，典型是启动极早期）。**不上传、也不清标记**：
   * 清掉等于用一次读取失败永久丢掉一个崩溃现场。
   */
  | { kind: 'unknown' };

export interface ConsentGateDeps {
  /** 本构建是否配置了上报目标。 */
  isTargetConfigured(): boolean;
  /**
   * 让持久层现读盘（`invalidateIfChanged()`）。抛异常视为读取失败 → `unknown`。
   * 跨实例正确性全靠这一下。
   */
  refreshFromDisk(): void;
  /** 已明示同意《隐私政策》。读不出来时抛异常，不要返回 false（那会被当成明确拒绝）。 */
  readPrivacyConsentAccepted(): boolean;
  /**
   * 「崩溃时自动上传」开关。同上，读不出来抛异常。
   * 只在自动路径上被调用——手动路径不看这个开关，所以也不该被它的读取故障牵连。
   */
  readCrashAutoUploadEnabled(): boolean;
}

export function evaluateGate(deps: ConsentGateDeps, reason: LogUploadReason): GateVerdict {
  // 目标未配置排在最前:功能整体关闭时不该去碰用户的授权状态,也不该产生任何标记。
  if (!deps.isTargetConfigured()) return { kind: 'denied', reason: 'not-configured' };

  let consented: boolean;
  try {
    deps.refreshFromDisk();
    consented = deps.readPrivacyConsentAccepted();
  } catch {
    return { kind: 'unknown' };
  }
  if (!consented) return { kind: 'denied', reason: 'no-consent' };

  // 手动路径到此为止:**不读崩溃开关**。读了就得处理它读不出来的情况,而那会让
  // 「崩溃自动上传偏好文件损坏」把用户主动点的上传也一起堵掉 —— 恰好是用户最需要交日志的
  // 时候(2026-08-04 review P2)。手动上传的放行条件里本来就没有这个开关。
  if (reason === 'manual') return { kind: 'allowed' };

  let crashAutoEnabled: boolean;
  try {
    crashAutoEnabled = deps.readCrashAutoUploadEnabled();
  } catch {
    return { kind: 'unknown' };
  }
  if (!crashAutoEnabled) return { kind: 'denied', reason: 'crash-auto-off' };
  return { kind: 'allowed' };
}

/** 手动入口是否可用（设置页据此禁用按钮并给出可区分提示）。 */
export function isManualUploadAvailable(deps: ConsentGateDeps): boolean {
  return evaluateGate(deps, 'manual').kind === 'allowed';
}
