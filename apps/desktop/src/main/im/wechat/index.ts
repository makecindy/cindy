import type { ImOrchestratorConfig } from '../shared/types';
import { createImOrchestrator } from '../shared/orchestrator';
import { resetSessionToDefaults } from '../shared/sessionRepo';
import { buildWechatAdapter } from './adapter';
import type { WechatIM } from './WechatIM';

export function wireWechatOrchestrator(wechatIm: WechatIM, config: ImOrchestratorConfig): void {
  const orchestrator = createImOrchestrator(buildWechatAdapter(wechatIm, config));
  wechatIm.attachTurnRuntime({
    runner: orchestrator.turnRunner,
    repo: orchestrator.repo,
    config,
    resetSessionToDefaults: (sessionId, nextConfig, prepared) =>
      resetSessionToDefaults(sessionId, nextConfig, prepared, 'wechat'),
  });
}

export { WechatIM, WECHAT_AUTH_BASE_URL } from './WechatIM';
export type { WechatBotPhase, WechatBotState, WechatIMDeps } from './WechatIM';
