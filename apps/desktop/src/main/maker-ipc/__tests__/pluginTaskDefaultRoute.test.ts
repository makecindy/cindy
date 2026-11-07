import { describe, expect, it } from 'vitest';

import { encodeCatalogModelPin } from '../../../shared/catalogModelPin.js';
import { auxiliaryChainSessionCandidates, pluginTaskRouteAttempts, pluginTaskSelectionIsOpen } from '../pluginTaskDefaultRoute.js';

describe('auxiliaryChainSessionCandidates', () => {
  // Rule: a plugin's own persistent task (no originating session) follows the
  // auxiliary chain instead of the new-task composer selection. tier: unit.
  it('maps catalog pins and lightweight profiles to session routes in chain order', () => {
    const refs = [
      encodeCatalogModelPin({ providerId: 'xd', agentKind: 'codex', model: 'deepseek/deepseek-v4-flash' }),
      'codex-gpt-5.4-mini',
      'litellm-gpt-5.4-mini',
      encodeCatalogModelPin({ providerId: 'xd', agentKind: 'codex', model: 'deepseek/deepseek-v4-flash' }),
      'not-a-ref',
    ];
    expect(auxiliaryChainSessionCandidates(refs)).toEqual([
      { agentKind: 'codex', providerId: 'xd', model: 'deepseek/deepseek-v4-flash' },
      { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.4-mini' },
      { agentKind: 'codex', providerId: 'xd', model: 'gpt-5.4-mini' },
    ]);
  });

  // Rule (2026-10-28): plugin tasks run on Pi when the model is offered there; a
  // chain head without a light effort level yields to a later candidate that has
  // one; default efforts are only a last pass. tier: unit.
  it('tries each candidate on Pi first, every candidate at a light effort before any default', () => {
    const a = { agentKind: 'codex' as const, providerId: 'xd', model: 'a' };
    const b = { agentKind: 'pi' as const, providerId: 'xd', model: 'b' };
    const aPi = { ...a, agentKind: 'pi' as const };
    expect(pluginTaskRouteAttempts([a, b])).toEqual([
      { candidate: aPi, effort: 'low' }, { candidate: aPi, effort: 'medium' },
      { candidate: a, effort: 'low' }, { candidate: a, effort: 'medium' },
      { candidate: b, effort: 'low' }, { candidate: b, effort: 'medium' },
      { candidate: aPi, effort: undefined }, { candidate: a, effort: undefined }, { candidate: b, effort: undefined },
    ]);
  });

  it('treats any explicit identifying field as a closed selection', () => {
    expect(pluginTaskSelectionIsOpen({})).toBe(true);
    expect(pluginTaskSelectionIsOpen({ effort: 'low' })).toBe(true);
    expect(pluginTaskSelectionIsOpen({ model: 'gpt-6.1-sol' })).toBe(false);
    expect(pluginTaskSelectionIsOpen({ providerId: 'openai' })).toBe(false);
  });
});
