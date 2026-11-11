import { describe, expect, it } from 'vitest';

import { actionableWorkerReportQuestion } from '../orcaLeadWorkerAttention';

// 2026-11-11 codex P2：progress 是内部遥测，其 question（旧端或历史数据写入的）
// 不得出现在用户可见的出错/需确认通知里；只有 blocked / failed 的问题可外显。
// 生产入口：findOrcaWorkerReportQuestion → 通知标题拼装（CCAgentSidebarUpper）。
// tier: unit（纯函数）。实测耗时 <1s。
describe('actionableWorkerReportQuestion', () => {
  it('surfaces the question only for blocked and failed reports', () => {
    expect(actionableWorkerReportQuestion({ state: 'blocked', question: '选 A 还是 B' })).toBe('选 A 还是 B');
    expect(actionableWorkerReportQuestion({ state: 'failed', question: '重试还是停止？' })).toBe('重试还是停止？');
  });

  it('never surfaces a question from non-actionable states', () => {
    expect(actionableWorkerReportQuestion({ state: 'progress', question: '内部问题' })).toBeNull();
    expect(actionableWorkerReportQuestion({ state: 'waiting', question: '旧问题' })).toBeNull();
    expect(actionableWorkerReportQuestion({ state: 'ready', question: '看看这个' })).toBeNull();
    expect(actionableWorkerReportQuestion({ state: 'dropped', question: '不用了' })).toBeNull();
    expect(actionableWorkerReportQuestion(null)).toBeNull();
    expect(actionableWorkerReportQuestion({ state: 'blocked' })).toBeNull();
  });
});
