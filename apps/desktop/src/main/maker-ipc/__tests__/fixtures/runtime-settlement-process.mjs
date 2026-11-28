import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { initLogger } = require('../../../logger.ts');
const { createPendingSessionRuntimeControlSettlement } = require('../../pendingSessionRuntimeControlSettlement.ts');
const { acceptSessionRuntimeMutation, settlePendingSessionRuntimeMutation } = require('../../sessionRuntimeControl.ts');
initLogger({ logDir: process.argv[2], isDev: false });

const profile = { agentKind: 'pi', model: 'first', providerId: 'source', effort: null, fastMode: false };
const calls = [];
for (const scenario of ['success', 'history-error', 'broadcast-error', 'advanced-error']) {
  const register = model => acceptSessionRuntimeMutation({
    sessionId: scenario, source: 'agent', deferred: true, profile: { ...profile, model },
  });
  const report = port => {
    calls.push(port);
    if (scenario === 'advanced-error' && port === 'history') register('second');
    if ((port === 'history' && scenario !== 'broadcast-error') || port === 'broadcast') {
      throw new Error(scenario);
    }
  };
  const settle = createPendingSessionRuntimeControlSettlement({
    async applySessionRuntimeSelection(id, model, _provider, _selection, options) {
      calls.push('apply-' + model);
      if (scenario !== 'success' && model === 'first') throw new Error('apply failed');
      settlePendingSessionRuntimeMutation(id, options.applyingPendingGeneration);
      return { deferred: false };
    },
    runtimeSelectionRequiresModelWindowConfirmation: () => false,
    async broadcastSessionRuntimeProjection() { calls.push('projection'); },
    onTurnErrorEvent: () => report('history'),
    getSessionDbAgentKind: () => 'pi',
    broadcastToAllWindows: () => report('broadcast'),
    log: { info: () => calls.push('info'), warn: () => calls.push('warn'), debug: () => calls.push('debug') },
  });
  register('first');
  calls.push(scenario);
  const result = settle(scenario, 'terminal');
  calls.push(result === undefined ? 'returned-void' : 'returned-work');
  await setImmediate();
}
process.stdout.write(JSON.stringify(calls));
