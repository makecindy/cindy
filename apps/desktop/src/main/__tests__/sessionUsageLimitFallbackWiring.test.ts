import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 接线守卫：这个特性的失败模式全是“代码看着对、但某处没接上”。
 * 纯函数与 MCP 层测试都绕过了真正的入口，所以这里直接盯 register.ts 的接线形状。
 */
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');

function slice(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`接线锚点缺失：${start} / ${end}`);
  return source.slice(from, to);
}

describe('usage-limit fallback wiring', () => {
  it('routes the provider-group hand-back through the single quota-recovery choke point', () => {
    // 供应商组服务恒存在，普通额度错误只会经它的 fallback 依赖交回；
    // 这里接不上，整条策略就是死代码。
    const deps = slice(
      '  providerGroupService = createProviderGroupService({',
      '  setProviderGroupTurnProbe(',
    );
    expect(deps).toContain(
      'fallback: (sessionId, signals, token) => handBackUsageLimitRecovery(sessionId, signals, token)',
    );
    expect(deps).not.toContain('fallback: (sessionId, signals, token) => usageLimitAutoResume.onTurnError');
  });

  it('keeps the non-group branch on the same choke point instead of a private copy', () => {
    const branch = slice('    onUsageLimitedTurnError: (sessionId, signals, item, candidateToken) => {',
      '      // 先不呈现的那次错误');
    expect(branch).toContain('handBackUsageLimitRecovery(sessionId, signals, candidateToken)');
    expect(branch).not.toContain('recoverWithConfiguredUsageLimitFallback');
  });

  it('hands back to reset waiting only after the route switch failed', () => {
    const handBack = slice('  function handBackUsageLimitRecovery(', '  const inputCoordinator: AgentInputCoordinator');
    expect(handBack).toContain('recoverWithConfiguredUsageLimitFallback');
    expect(handBack).toContain('if (resumed) return;');
    // 没续跑成时先撤掉立即等待，再交回等额度重置，避免留下到点无定时器的等待。
    const giveUp = handBack.slice(handBack.indexOf('if (resumed) return;'));
    expect(giveUp.indexOf('cancelUsageLimitWait')).toBeGreaterThan(-1);
    expect(giveUp.indexOf('cancelUsageLimitWait')).toBeLessThan(
      giveUp.indexOf('usageLimitAutoResume.onTurnError'),
    );
  });

  it('leases the recovery across the route switch and re-arms with a fresh token', () => {
    const recover = slice('  async function recoverWithConfiguredUsageLimitFallback(', '  function handBackUsageLimitRecovery(');
    // 换路可能以 runtime-refresh 关闭旧会话并撤销额度等待，必须先租后重挂。
    expect(recover).toContain('leaseUsageLimitRecovery(sessionId, token)');
    expect(recover).toContain('rearmUsageLimitWait(sessionId, lease, Date.now())');
    // 直接按原候选令牌 arm 会在重建后必然失败。
    expect(recover).not.toContain('armUsageLimitWait(sessionId, candidateToken');
    // 两次 await 之间用户可能接手：租用前后都要复核。
    expect(recover.split('isUsageLimitWaitCurrent').length - 1).toBeGreaterThanOrEqual(2);
    expect(recover).toContain('isUsageLimitRecoveryLeaseCurrent(sessionId, lease)');
  });

  it('refuses to configure the policy for tasks that can never use it', () => {
    const write = slice('      if (patch.usageLimitFallback !== undefined) {', '      if (patch.harness !== undefined) {');
    expect(write).toContain('isUsageLimitAutoResumeEligible(targetSessionId)');
    expect(write).toContain('sessionRunsOffThisMachine(targetSessionId)');
    expect(write).toContain('fallbackProfiles.pendingMutation');
  });
});
