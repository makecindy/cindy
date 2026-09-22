import type { ImOrchestratorConfig } from '../shared/types';
import { createImOrchestrator } from '../shared/orchestrator';
import { resetSessionToDefaults } from '../shared/sessionRepo';
import { buildWechatAdapter } from './adapter';
import type { WechatIM } from './WechatIM';

export function wireWechatOrchestrator(wechatIm: WechatIM, config: ImOrchestratorConfig): void {
  const adapter = buildWechatAdapter(wechatIm, config);
  const orchestrator = createImOrchestrator(adapter);
  wechatIm.attachTurnRuntime({
    runner: orchestrator.turnRunner,
    repo: orchestrator.repo,
    config,
    // WechatIM 自带 /new 流程,与 shared slashCommands 走同一份渠道能力声明。
    resetSessionToDefaults: (sessionId, nextConfig, prepared) =>
      resetSessionToDefaults(sessionId, nextConfig, prepared, {
        channel: 'wechat',
        refreshWorkingDir: adapter.sessions.refreshWorkingDirOnNew === true,
      }),
  });
}

export { WechatIM, WECHAT_AUTH_BASE_URL } from './WechatIM';
export type { WechatBotPhase, WechatBotState, WechatIMDeps } from './WechatIM';
