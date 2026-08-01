import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSessionReferences = vi.hoisted(() => vi.fn());
vi.mock('../../maker-ipc/sessionReferenceResolver.js', () => ({ resolveSessionReferences }));

import {
  outboundSessionReferencesRequested,
  rewriteOutboundSessionReferences,
} from '../outboundSessionReferences.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

function queued(sessionRefs?: AgentInputQueuedMessage['sessionRefs']): AgentInputQueuedMessage {
  return {
    clientId: 'client-1',
    text: 'compare linked session',
    persistedContent: 'compare linked session',
    model: 'model',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    sessionRefs,
    trustedSessionReferenceContexts: [
      {
        sessionId: 'forged',
        source: 'local',
        messages: [{ role: 'user', content: 'renderer-forged history' }],
        range: 'recent',
        messageCount: 1,
        truncated: false,
      },
    ],
    chatMessage: { clientId: 'client-1', role: 'user', content: 'compare linked session' },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'model',
      effort: 'medium',
      permissionMode: 'default',
    },
  };
}

describe('rewriteOutboundSessionReferences', () => {
  beforeEach(() => resolveSessionReferences.mockReset());

  it.each([
    ['controller-local source', [{ sessionId: 'on-a' }]],
    ['controlled-device source', [{ sessionId: 'on-b', deviceId: 'device-b' }]],
    [
      'third-device source authorized directly by controller',
      [{ sessionId: 'on-c', deviceId: 'device-c' }],
    ],
  ])('resolves %s before the target device sees relative routing ids', async (_name, refs) => {
    const snapshot = [
      {
        sessionId: refs[0]?.sessionId,
        source: refs[0] && 'deviceId' in refs[0] ? 'device-link' : 'local',
        messages: [{ role: 'user', content: 'trusted history' }],
        range: 'recent',
        messageCount: 1,
        truncated: false,
      },
    ];
    resolveSessionReferences.mockResolvedValueOnce(snapshot);

    const rewritten = await rewriteOutboundSessionReferences('maker:input:enqueue', [
      'target-on-b',
      queued(refs),
    ]);

    expect(resolveSessionReferences).toHaveBeenCalledWith(refs);
    expect((rewritten[1] as AgentInputQueuedMessage).trustedSessionReferenceContexts).toEqual(
      snapshot,
    );
    expect(JSON.stringify(rewritten)).not.toContain('renderer-forged history');
  });

  it('does not borrow the target device identity when the controller cannot read a third device', async () => {
    resolveSessionReferences.mockRejectedValueOnce(new Error('source device access revoked'));
    await expect(
      rewriteOutboundSessionReferences('maker:input:steer', [
        'target-on-b',
        queued([{ sessionId: 'on-c', deviceId: 'device-c' }]),
      ]),
    ).rejects.toThrow('access revoked');
  });

  it('lets a queued remove-from-queue steer use the target stored snapshot', async () => {
    const refs = [{ sessionId: 'on-c', deviceId: 'device-c' }];
    const projected = queued(refs);
    delete projected.trustedSessionReferenceContexts;
    const args = ['target-on-b', projected, { removeFromQueue: true }];

    await expect(rewriteOutboundSessionReferences('maker:input:steer', args)).resolves.toBe(args);
    expect(resolveSessionReferences).not.toHaveBeenCalled();
    expect(outboundSessionReferencesRequested('maker:input:steer', args)).toBe(false);
  });

  it('refreshes the trusted snapshot when a remotely queued message changes its links', async () => {
    const refs = [{ sessionId: 'replacement', deviceId: 'device-c' }];
    const snapshot = [{ sessionId: 'replacement', messages: [] }];
    resolveSessionReferences.mockResolvedValueOnce(snapshot);
    const rewritten = await rewriteOutboundSessionReferences('maker:input:update-text', [
      'target-on-b',
      'client-1',
      'now use cindy://session/replacement',
      refs,
    ]);
    expect(resolveSessionReferences).toHaveBeenCalledWith(refs);
    expect(rewritten[4]).toEqual(snapshot);
  });

  it('keeps the legacy three-argument update-text shape unchanged', async () => {
    const args = ['target-on-b', 'client-1', 'plain edit'];
    const rewritten = await rewriteOutboundSessionReferences('maker:input:update-text', args);

    expect(rewritten).toBe(args);
    expect(JSON.stringify(rewritten)).toBe('["target-on-b","client-1","plain edit"]');
    expect(resolveSessionReferences).not.toHaveBeenCalled();
  });

  it('resolves references in a full queued-content replacement', async () => {
    const refs = [{ sessionId: 'replacement', deviceId: 'device-c' }];
    resolveSessionReferences.mockResolvedValueOnce([{ sessionId: 'replacement', messages: [] }]);
    const rewritten = await rewriteOutboundSessionReferences('maker:input:update-content', [
      'target-on-b',
      'client-1',
      queued(refs),
    ]);
    expect(resolveSessionReferences).toHaveBeenCalledWith(refs);
    expect((rewritten[2] as AgentInputQueuedMessage).trustedSessionReferenceContexts).toHaveLength(
      1,
    );
  });

  it('does not rewrite unrelated channels', async () => {
    const args = ['target-on-b', queued([{ sessionId: 'on-c', deviceId: 'device-c' }])];
    await expect(rewriteOutboundSessionReferences('maker:input:stop', args)).resolves.toBe(args);
    expect(resolveSessionReferences).not.toHaveBeenCalled();
  });

  it('detects every reference-bearing queue mutation that requires a target probe', () => {
    expect(
      outboundSessionReferencesRequested('maker:input:enqueue', [
        'target',
        queued([{ sessionId: 'source' }]),
      ]),
    ).toBe(true);
    expect(
      outboundSessionReferencesRequested('maker:input:update-content', [
        'target',
        'client-1',
        queued([{ sessionId: 'source' }]),
      ]),
    ).toBe(true);
    expect(
      outboundSessionReferencesRequested('maker:input:update-text', [
        'target',
        'client-1',
        'text',
        [{ sessionId: 'source' }],
      ]),
    ).toBe(true);
    expect(outboundSessionReferencesRequested('maker:input:enqueue', ['target', queued()])).toBe(
      false,
    );
  });
});
