import type { DingTalkChannelIM } from '@cindy/im';

import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildDingTalkAdapter } from './adapter';

export function wireDingTalkOrchestrator(
  dingtalkIm: DingTalkChannelIM,
  config: ImOrchestratorConfig,
): void {
  createImOrchestrator(buildDingTalkAdapter(dingtalkIm, config));
}
