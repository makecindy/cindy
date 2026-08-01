import type { DingTalkIM } from '@cindy/im';

import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildDingTalkAdapter } from './adapter';

export function wireDingTalkOrchestrator(
  dingtalkIm: DingTalkIM,
  config: ImOrchestratorConfig,
): void {
  createImOrchestrator(buildDingTalkAdapter(dingtalkIm, config));
}
