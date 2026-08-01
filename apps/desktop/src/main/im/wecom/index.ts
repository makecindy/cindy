import type { WecomIM } from '@cindy/im';

import { createImOrchestrator } from '../shared/orchestrator';
import type { ImOrchestratorConfig } from '../shared/types';
import { buildWecomAdapter } from './adapter';
import { WecomTextInteractions } from './textInteractions';

export function wireWecomOrchestrator(wecomIm: WecomIM, config: ImOrchestratorConfig): void {
  const interactions = new WecomTextInteractions(wecomIm);
  createImOrchestrator(buildWecomAdapter(wecomIm, interactions, config));
}
