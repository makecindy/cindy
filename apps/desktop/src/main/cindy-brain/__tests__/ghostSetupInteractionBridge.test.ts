import { describe, expect, it, vi } from 'vitest';

import { MAKER_PUSH } from '../../maker-ipc/channels';
import { createDesktopOnlyConfirmationRequestId } from '../desktopOnlyConfirmationProjection';
import {
  projectInteractionDismissedForRemote,
  GhostSetupInteractionBridge,
  parseGhostSetupInlineSubmit,
  parseGhostSetupInlineSubmitRequest,
  parseGhostSetupInteractionCommand,
  projectInteractionRequestForRemote,
  projectPendingInteractionsForRemote,
  sanitizeGhostSetupRequestForRemote,
  sanitizeGhostSetupSnapshotForRemote,
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

  it('fails closed when a pending setup command is malformed', () => {
    const logger = { warn: vi.fn() };
    const onCommand = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn(), logger });
    bridge.open('session-1', snapshot(), onCommand);

    expect(
      bridge.resolve('request-1', {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: '',
        expectedRevision: 1,
      }),
    ).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('plugin setup interaction received invalid command', {
      requestId: 'request-1',
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

  it('turns account-boundary cleanup into cancel commands for every session', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    bridge.open('session-1', snapshot(4), first);
    bridge.open('session-2', { ...snapshot(7), requestId: 'request-2' }, second);

    bridge.cleanupAll('session_aborted');
    await Promise.resolve();

    expect(first).toHaveBeenCalledWith({
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: 4,
      cleanupReason: 'session_aborted',
    });
    expect(second).toHaveBeenCalledWith({
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: 7,
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

  it('fails closed when an inline submission payload is malformed', () => {
    const logger = { warn: vi.fn() };
    const onInlineSubmit = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn(), logger });
    bridge.open('session-1', snapshot(), vi.fn(), onInlineSubmit);

    expect(bridge.submitInline('request-1', { value: 'missing action metadata' })).toBe(false);
    expect(onInlineSubmit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'plugin setup interaction received invalid inline submission',
      { requestId: 'request-1' },
    );
  });

  it('fails closed when the pending interaction has no inline submit callback', () => {
    const logger = { warn: vi.fn() };
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn(), logger });
    bridge.open('session-1', snapshot(), vi.fn());

    expect(
      bridge.submitInline('request-1', {
        actionId: 'inline_form:opaque',
        expectedRevision: 1,
        value: 'secret',
      }),
    ).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'plugin setup interaction received invalid inline submission',
      { requestId: 'request-1' },
    );
  });
});

describe('sanitizeGhostSetupSnapshotForRemote', () => {
  it('allowlists inline form fields without mutating the local Desktop snapshot', () => {
    const local: GhostSetupInteractionSnapshot = {
      ...snapshot(),
      intro: 'Configure access',
      steps: [
        {
          ...snapshot().steps[0],
          phase: 'failed',
          errorCode: 'SAVE_FAILED',
          errorMessage: 'provider-local-detail',
          action: {
            id: 'inline_form:opaque',
            kind: 'inline_form',
            form: {
              fields: [
                {
                  id: 'value',
                  type: 'secret',
                  label: 'API key',
                  description: 'Stored locally',
                  placeholder: 'Paste key',
                  externalLink: { url: 'https://desktop-only.example/keys' },
                  required: true,
                  maxLength: 4096,
                },
              ],
            },
          },
        },
      ],
    };

    const remote = sanitizeGhostSetupSnapshotForRemote(local);

    expect(remote).not.toBe(local);
    expect(remote.steps[0]).toMatchObject({
      phase: 'failed',
      errorCode: 'SAVE_FAILED',
    });
    expect(remote.steps[0]).not.toHaveProperty('errorMessage');
    expect(remote.steps[0].action).toEqual({
      id: 'inline_form:opaque',
      kind: 'inline_form',
      form: {
        fields: [
          {
            id: 'value',
            type: 'secret',
            label: 'API key',
            description: 'Stored locally',
            placeholder: 'Paste key',
            required: true,
            maxLength: 4096,
          },
        ],
      },
    });
    expect(
      local.steps[0].action?.kind === 'inline_form'
        ? local.steps[0].action.form.fields[0].externalLink
        : undefined,
    ).toEqual({ url: 'https://desktop-only.example/keys' });
    expect(local.steps[0].errorMessage).toBe('provider-local-detail');
  });

  it('drops unknown error codes at the remote transport boundary', () => {
    const local = snapshot();
    (local.steps[0] as { errorCode?: string }).errorCode = 'PROVIDER_RAW_ERROR';

    expect(sanitizeGhostSetupSnapshotForRemote(local).steps[0]).not.toHaveProperty('errorCode');
  });

  it('preserves non-plugin interaction requests by identity', () => {
    const permission = { kind: 'permission', requestId: 'permission-1' };
    expect(sanitizeGhostSetupRequestForRemote(permission)).toBe(permission);
  });

  it('projects pending rebuilds only for a remote device-link caller', () => {
    const localSetup = {
      request: {
        ...snapshot(),
        steps: [
          {
            ...snapshot().steps[0],
            action: {
              id: 'inline_form:opaque',
              kind: 'inline_form' as const,
              form: {
                fields: [
                  {
                    id: 'value' as const,
                    type: 'secret' as const,
                    label: 'API key',
                    externalLink: { url: 'https://desktop-only.example/keys' },
                    required: true as const,
                    maxLength: 4096,
                  },
                ] as [
                  {
                    id: 'value';
                    type: 'secret';
                    label: string;
                    externalLink: { url: string };
                    required: true;
                    maxLength: number;
                  },
                ],
              },
            },
          },
        ],
      },
    };
    const permission = { request: { kind: 'permission', requestId: 'permission-1' } };
    const future = { request: { kind: 'future_kind', requestId: 'future-1' } };
    const issue = {
      request: {
        kind: 'issue_confirm',
        requestId: 'issue-1',
        draft: { title: 'private draft' },
      },
    };
    const rename = {
      request: {
        kind: 'rename_sessions_confirm',
        requestId: 'rename-1',
        changes: [{ sessionId: 'private-session', title: 'private title' }],
      },
    };
    const grant = {
      request: {
        kind: 'ghost_grant_confirm',
        requestId: 'grant-1',
        items: [
          { absPath: '/Users/me/private.png', previewDataUrl: 'data:image/png;base64,private' },
        ],
      },
    };
    const pending = [localSetup, permission, future, issue, rename, grant];

    const local = projectPendingInteractionsForRemote(pending, false);
    expect(local).toBe(pending);
    expect(local[0].request).toBe(localSetup.request);

    const remote = projectPendingInteractionsForRemote(pending, true);
    expect(remote).not.toBe(pending);
    expect(remote).toHaveLength(6);
    expect(JSON.stringify(remote[0])).not.toContain('desktop-only.example');
    expect(remote[1].request).toBe(permission.request);
    expect(remote[2].request).toBe(future.request);
    expect(JSON.stringify(remote)).not.toContain('private');
    expect(JSON.stringify(remote)).not.toContain('/Users/me/private.png');
    for (const entry of remote.slice(3)) {
      expect(entry.request).toEqual({
        kind: expect.any(String),
        requestId: expect.stringMatching(/^desktop-confirm-/),
      });
      expect(entry.request.requestId).not.toMatch(/issue-1|rename-1|grant-1/);
    }
    expect(localSetup.request.steps[0].action.form.fields[0].externalLink).toEqual({
      url: 'https://desktop-only.example/keys',
    });
    expect(local).toEqual(pending);
  });

  it('maps a desktop-only confirmation dismissal to its opaque remote request id', () => {
    const sourceRequest = {
      kind: 'issue_confirm',
      requestId: createDesktopOnlyConfirmationRequestId(),
      draft: { title: 'private' },
    };
    const projected = projectInteractionRequestForRemote(sourceRequest)!;
    const dismissed = projectInteractionDismissedForRemote({
      sessionId: 'session-1',
      requestId: sourceRequest.requestId,
      reason: 'resolved',
    });

    expect(dismissed).toEqual({
      sessionId: 'session-1',
      requestId: projected.requestId,
      reason: 'resolved',
    });
    expect(JSON.stringify(dismissed)).not.toContain(sourceRequest.requestId);
  });

  it('maps a dismissal when the desktop-only confirmation predates Device Link activation', () => {
    const requestId = createDesktopOnlyConfirmationRequestId();

    const dismissed = projectInteractionDismissedForRemote({
      sessionId: 'session-1',
      requestId,
      reason: 'resolved',
    });

    expect(dismissed).toMatchObject({
      sessionId: 'session-1',
      requestId: expect.stringMatching(/^desktop-confirm-/),
      reason: 'resolved',
    });
    expect(JSON.stringify(dismissed)).not.toContain(requestId);
  });

  it('keeps the opaque dismissal id stable after the Host confirmation timeout', () => {
    vi.useFakeTimers();
    try {
      const requestId = createDesktopOnlyConfirmationRequestId();
      const projected = projectInteractionRequestForRemote({
        kind: 'issue_confirm',
        requestId,
      })!;
      vi.advanceTimersByTime(9 * 60 * 1000);

      expect(projectInteractionDismissedForRemote({ requestId })).toEqual({
        requestId: projected.requestId,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('projects more than 128 concurrent confirmations without evicting source ids', () => {
    const sourceRequestIds = Array.from(
      { length: 256 },
      () => createDesktopOnlyConfirmationRequestId(),
    );

    for (const requestId of sourceRequestIds) {
      const projected = projectInteractionRequestForRemote({
        kind: 'ghost_grant_confirm',
        requestId,
      })!;
      const dismissed = projectInteractionDismissedForRemote({ requestId });
      expect(dismissed).toEqual({ requestId: projected.requestId });
      expect(JSON.stringify(dismissed)).not.toContain(requestId);
    }
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
        value: `  ${'x'.repeat(4096)} \n`,
      }),
    ).toEqual({
      actionId: 'inline_form:opaque',
      expectedRevision: 2,
      value: 'x'.repeat(4096),
    });
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
