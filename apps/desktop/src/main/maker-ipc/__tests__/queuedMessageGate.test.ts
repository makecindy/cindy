import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import { requireQueuedMessageShape } from '../queuedMessageGate';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8');

function queuedMessage(agentKind: unknown): unknown {
  return {
    clientId: 'client-1',
    text: 'hello',
    persistedContent: 'hello',
    model: 'grok-code',
    effort: '',
    permissionMode: 'ask',
    workingDir: 'C:\\repo',
    chatMessage: { clientId: 'client-1', role: 'user', content: 'hello' },
    createOpts: { agentKind, workingDir: 'C:\\repo', model: 'grok-code' },
  };
}

describe('queued message IPC gate', () => {
  it('accepts every agent kind the queued createOpts contract declares', () => {
    for (const kind of ['claude-code', 'codex', 'pi', 'grok-build'] as const) {
      const item = queuedMessage(kind);
      const parsed: AgentInputQueuedMessage = requireQueuedMessageShape(item);
      expect(parsed).toBe(item);
      expect(parsed.createOpts.agentKind).toBe(kind);
    }
  });

  it('rejects a non-agent createOpts.agentKind', () => {
    for (const bogus of ['grok', 'cc', '', undefined, null, 7]) {
      expect(() => requireQueuedMessageShape(queuedMessage(bogus))).toThrow('[INVALID_PARAMS]');
    }
  });

  it('still enforces the rest of the queued message shape', () => {
    expect(() => requireQueuedMessageShape(null)).toThrow('[INVALID_PARAMS]');
    expect(() =>
      requireQueuedMessageShape({ ...(queuedMessage('grok-build') as object), clientId: '' }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      requireQueuedMessageShape({ ...(queuedMessage('grok-build') as object), text: 42 }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      requireQueuedMessageShape({ ...(queuedMessage('grok-build') as object), chatMessage: null }),
    ).toThrow('[INVALID_PARAMS]');
    expect(() =>
      requireQueuedMessageShape({ ...(queuedMessage('grok-build') as object), createOpts: 'x' }),
    ).toThrow('[INVALID_PARAMS]');
  });

  it('routes INPUT_ENQUEUE through the shared shape gate', () => {
    expect(registerSource).toContain(
      "import { requireQueuedMessageShape } from './queuedMessageGate.js';",
    );

    const validatorStart = registerSource.indexOf('const requireQueuedMessage = (');
    expect(validatorStart).toBeGreaterThan(-1);
    const validator = registerSource.slice(validatorStart, validatorStart + 600);
    expect(validator).toContain('const msg = requireQueuedMessageShape(value);');

    const enqueueStart = registerSource.indexOf('MAKER_INVOKE.INPUT_ENQUEUE,');
    expect(enqueueStart).toBeGreaterThan(-1);
    const enqueue = registerSource.slice(
      enqueueStart,
      registerSource.indexOf('MAKER_INVOKE.INPUT_STEER,', enqueueStart),
    );
    expect(enqueue).toContain('requireQueuedMessage(item)');
  });
});
