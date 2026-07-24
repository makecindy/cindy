import { describe, expect, it, vi } from 'vitest';

import { MAKER_PUSH } from '../../maker-ipc/channels';
import {
  GhostSetupInteractionBridge,
  parseGhostSetupInlineSubmit,
  parseGhostSetupInlineSubmitRequest,
  parseGhostSetupInteractionCommand,
  type GhostSetupInteractionSnapshot,
} from '../ghostSetupInteractionBridge';

function snapshot(revision = 1): GhostSetupInteractionSnapshot {
  return {
    kind: 'plugin_setup',
    requestId: 'request-1',
    revision,
    ghost: { id: 'gmail', name: 'Gmail' },
    steps: [
      {
        id: 'account',
        groupId: 'account',
        groupMode: 'any_of',
        title: '连接账号',
        description: '连接 Gmail 账号',
        phase: 'pending',
        action: { id: 'oauth_connect:secret:google', kind: 'oauth_connect' },
      },
    ],
  };
}

describe('GhostSetupInteractionBridge', () => {
  it('keeps run_action pending and broadcasts full revisioned snapshots', async () => {
    const broadcast = vi.fn();
    const onCommand = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast });
    const responseTarget = {
      id: 101,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    bridge.open('session-1', snapshot(), onCommand);

    expect(
      bridge.resolve(
        'request-1',
        {
          kind: 'plugin_setup',
          action: 'run_action',
          actionId: 'oauth_connect:secret:google',
          expectedRevision: 1,
        },
        responseTarget,
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(onCommand).toHaveBeenCalledWith(
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'oauth_connect:secret:google',
        expectedRevision: 1,
      },
      responseTarget,
    );
    expect(bridge.pendingSnapshots('session-1')).toHaveLength(1);

    expect(bridge.update(snapshot(2))).toBe(true);
    expect(bridge.update(snapshot(1))).toBe(false);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_REQUEST, {
      sessionId: 'session-1',
      request: snapshot(2),
    });
  });

  it('restores pending snapshots and dismisses only when Main closes it', () => {
    const broadcast = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast });
    bridge.open('session-1', snapshot(), vi.fn());

    expect(bridge.pendingSnapshots()).toEqual([{ sessionId: 'session-1', request: snapshot() }]);
    expect(bridge.close('request-1', 'ready')).toBe(true);
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'session-1',
      requestId: 'request-1',
      reason: 'ready',
    });
  });

  it('retires a terminal snapshot from pending semantics before delayed dismissal', () => {
    const broadcast = vi.fn();
    const onCommand = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast });
    bridge.open('session-1', snapshot(), onCommand);
    const terminal = { ...snapshot(2), terminal: true as const };

    expect(bridge.update(terminal)).toBe(true);
    expect(bridge.complete('request-1')).toBe(true);
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(
      bridge.resolve('request-1', {
        kind: 'plugin_setup',
        action: 'cancel',
        expectedRevision: 2,
      }),
    ).toBe(false);
    expect(bridge.submitInline('request-1', {})).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();

    // The retained entry still owns the delayed visual dismissal.
    expect(bridge.close('request-1', 'ready')).toBe(true);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'session-1',
      requestId: 'request-1',
      reason: 'ready',
    });
  });

  it('turns session cleanup into a cancel command for the coordinator', async () => {
    const onCommand = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    bridge.open('session-1', snapshot(4), onCommand);
    bridge.cleanupForSession('session-1', 'session_aborted');
    await Promise.resolve();

    expect(onCommand).toHaveBeenCalledWith({
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: 4,
      cleanupReason: 'session_aborted',
    });
  });

  it('rolls back pending state when the initial broadcast fails', () => {
    const bridge = new GhostSetupInteractionBridge({
      broadcast: () => {
        throw new Error('renderer unavailable');
      },
    });

    expect(() => bridge.open('session-1', snapshot(), vi.fn())).toThrow('renderer unavailable');
    expect(bridge.pendingSnapshots()).toEqual([]);
  });

  it('submits inline Secret only through the dedicated callback', async () => {
    const onCommand = vi.fn();
    const onInlineSubmit = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    bridge.open('session-1', snapshot(), onCommand, onInlineSubmit);

    expect(
      bridge.submitInline('request-1', {
        actionId: 'inline_form:opaque',
        expectedRevision: 1,
        value: 'test-secret-value',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(onInlineSubmit).toHaveBeenCalledWith({
      actionId: 'inline_form:opaque',
      expectedRevision: 1,
      value: 'test-secret-value',
    });
    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('parseGhostSetupInteractionCommand', () => {
  it('rejects arbitrary actions and invalid revisions', () => {
    expect(
      parseGhostSetupInteractionCommand({ kind: 'plugin_setup', action: 'open_url' }),
    ).toBeNull();
    expect(
      parseGhostSetupInteractionCommand({
        kind: 'plugin_setup',
        action: 'cancel',
        expectedRevision: -1,
      }),
    ).toBeNull();
    expect(
      parseGhostSetupInteractionCommand({
        kind: 'plugin_setup',
        action: 'submit_form',
        actionId: 'inline_form:opaque',
        expectedRevision: 1,
        value: 'must-not-use-generic-resolve',
      }),
    ).toBeNull();
  });
});

describe('parseGhostSetupInlineSubmit', () => {
  it('accepts the exact narrow shape and rejects empty, oversized or extra fields', () => {
    expect(
      parseGhostSetupInlineSubmit({
        actionId: 'inline_form:opaque',
        expectedRevision: 2,
        value: 'secret',
      }),
    ).toEqual({
      actionId: 'inline_form:opaque',
      expectedRevision: 2,
      value: 'secret',
    });
    expect(
      parseGhostSetupInlineSubmit({
        actionId: 'inline_form:opaque',
        expectedRevision: 2,
        value: ' ',
      }),
    ).toBeNull();
    expect(
      parseGhostSetupInlineSubmit({
        actionId: 'inline_form:opaque',
        expectedRevision: 2,
        value: 'x'.repeat(4097),
      }),
    ).toBeNull();
    expect(
      parseGhostSetupInlineSubmit({
        actionId: 'inline_form:opaque',
        expectedRevision: 2,
        value: 'secret',
        storageKey: 'api_key',
      }),
    ).toBeNull();
  });

  it('request parser accepts only requestId + submit fields', () => {
    expect(
      parseGhostSetupInlineSubmitRequest({
        requestId: 'request-1',
        actionId: 'inline_form:opaque',
        expectedRevision: 2,
        value: 'secret',
      }),
    ).toMatchObject({ requestId: 'request-1' });
    expect(
      parseGhostSetupInlineSubmitRequest({
        requestId: 'request-1',
        actionId: 'inline_form:opaque',
        expectedRevision: 2,
        value: 'secret',
        url: 'https://example.com',
      }),
    ).toBeNull();
  });
});
