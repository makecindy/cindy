import { describe, expect, it, vi } from 'vitest';

import type {
  GhostSetupAllowedAction,
  GhostSetupAssessment,
  GhostSetupPlan,
  InstalledGhost,
} from '../../../shared/ghost';
import { MAKER_PUSH } from '../../maker-ipc/channels';
import { GhostSetupChangeBus } from '../ghostSetupChangeBus';
import { GhostMutationCoordinator } from '../ghostMutationCoordinator';
import {
  GhostSetupCoordinator,
  type GhostSetupActionResult,
  type GhostSetupTargetValidation,
} from '../ghostSetupCoordinator';
import {
  GhostSetupInteractionBridge,
  type GhostSetupInteractionCommand,
  type GhostSetupInteractionResponseTarget,
  type GhostSetupInteractionSnapshot,
} from '../ghostSetupInteractionBridge';
import { classifyGhostVisibility } from '../ghostVisibility';

function required(revision = 0): GhostSetupAssessment {
  return {
    state: 'required',
    revision,
    groups: [
      {
        id: 'account',
        mode: 'any_of',
        items: [
          {
            ref: 'secret:google',
            kind: 'oauth',
            label: 'Google 账号',
            state: 'missing',
            actions: [{ id: 'oauth_connect:secret:google', kind: 'oauth_connect' }],
          },
        ],
      },
    ],
  };
}

function ready(revision = 1): GhostSetupAssessment {
  return {
    ...required(revision),
    state: 'ready',
    groups: [
      {
        ...required(revision).groups[0],
        items: [{ ...required(revision).groups[0].items[0], state: 'satisfied', actions: [] }],
      },
    ],
  };
}

function readyWithReauth(revision = 7): GhostSetupAssessment {
  return {
    ...ready(revision),
    reauthSuggest: {
      ghostId: 'gmail',
      secretKey: 'google',
      missingScopes: ['scope.new'],
      missingScopeCount: 1,
      requirement: {
        ref: 'secret:google',
        kind: 'oauth',
        label: 'Google 账号',
        action: {
          id: 'oauth_connect:secret:google',
          kind: 'oauth_connect',
        },
      },
    },
  };
}

function reauthPlan(revision = 7): GhostSetupPlan {
  return {
    assessmentRevision: revision,
    steps: [
      {
        id: 'reauth-google',
        title: '重新连接账号',
        description: '补齐新增权限',
        requirementRefs: ['secret:google'],
        actionId: 'oauth_connect:secret:google',
      },
    ],
  };
}

function requiredInline(revision = 0): GhostSetupAssessment {
  return {
    state: 'required',
    revision,
    groups: [
      {
        id: 'credential',
        mode: 'any_of',
        items: [
          {
            ref: 'secret:api_key',
            kind: 'secret',
            label: 'API Key',
            state: 'missing',
            actions: [
              {
                id: 'inline_form:opaque',
                kind: 'inline_form',
                form: {
                  fields: [
                    {
                      id: 'value',
                      type: 'secret',
                      label: 'API Key',
                      required: true,
                      maxLength: 4096,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function readyInline(revision = 1): GhostSetupAssessment {
  const assessment = requiredInline(revision);
  assessment.state = 'ready';
  assessment.groups[0].items[0].state = 'satisfied';
  assessment.groups[0].items[0].actions = [];
  return assessment;
}

function requiredTwoGroups(): GhostSetupAssessment {
  return {
    state: 'required',
    revision: 0,
    groups: [
      ...required().groups,
      {
        id: 'provider',
        mode: 'any_of',
        items: [
          {
            ref: 'client_config:image-provider',
            kind: 'client_config',
            label: '图片模型',
            state: 'missing',
            actions: [
              {
                id: 'open_client_settings:client_config:image-provider',
                kind: 'open_client_settings',
              },
            ],
          },
        ],
      },
    ],
  };
}

function requiredNavigation(revision = 0): GhostSetupAssessment {
  return {
    state: 'required',
    revision,
    groups: [
      {
        id: 'settings',
        mode: 'any_of',
        items: [
          {
            ref: 'plugin_config:settings',
            kind: 'plugin_config',
            label: '插件设置',
            state: 'missing',
            actions: [
              {
                id: 'open_plugin_settings:plugin_config:settings',
                kind: 'open_plugin_settings',
              },
            ],
          },
        ],
      },
    ],
  };
}

function harness(initial: GhostSetupAssessment) {
  const changeBus = new GhostSetupChangeBus();
  const broadcast = vi.fn();
  const bridge = new GhostSetupInteractionBridge({ broadcast });
  let assessment = initial;
  let targetValidation: GhostSetupTargetValidation = { ok: true };
  const executeAction = vi.fn(
    async (_args: {
      sessionId: string;
      ghostId: string;
      action: GhostSetupAllowedAction;
      responseTarget?: GhostSetupInteractionResponseTarget;
    }): Promise<GhostSetupActionResult> => ({ ok: true }),
  );
  const executeInlineAction = vi.fn(async (): Promise<GhostSetupActionResult> => ({ ok: true }));
  let requestNumber = 0;
  const coordinator = new GhostSetupCoordinator({
    changeBus,
    bridge,
    assess: () => assessment,
    validateTarget: () => targetValidation,
    getGhostIdentity: () => ({
      id: 'gmail',
      name: 'Gmail',
      iconDataUrl: 'data:image/png;base64,aWNvbg==',
    }),
    executeAction,
    executeInlineAction,
    createRequestId: () => `request-${++requestNumber}`,
    timeoutMs: 5_000,
    terminalGraceMs: 0,
  });
  return {
    bridge,
    changeBus,
    coordinator,
    executeAction,
    executeInlineAction,
    broadcast,
    setAssessment(next: GhostSetupAssessment) {
      assessment = next;
    },
    setTargetValidation(next: GhostSetupTargetValidation) {
      targetValidation = next;
    },
  };
}

describe('GhostSetupCoordinator', () => {
  it('ready path does not create an interaction', async () => {
    const h = harness(ready());
    await expect(
      h.coordinator.ensureReady({ sessionId: 'session-1', ghostId: 'gmail', tool: 'search' }),
    ).resolves.toMatchObject({ ok: true });
    expect(h.bridge.pendingSnapshots()).toEqual([]);
  });

  it('ready + reauthSuggest + 匹配 plan 复用交互卡，重连清除建议后放行调用', async () => {
    const h = harness(readyWithReauth());
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      plan: reauthPlan(),
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({
      title: '重新连接账号',
      action: { id: 'oauth_connect:secret:google', kind: 'oauth_connect' },
    });
    h.executeAction.mockImplementationOnce(async () => {
      h.setAssessment(ready(8));
      h.changeBus.emit('gmail', { source: 'oauth', ref: 'google' });
      return { ok: true };
    });
    h.bridge.resolve(snapshot.requestId, {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth_connect:secret:google',
      expectedRevision: snapshot.revision,
    });

    await expect(waiting).resolves.toMatchObject({
      ok: true,
      assessment: { state: 'ready', revision: 8 },
    });
    expect(h.executeAction).toHaveBeenCalledOnce();
  });

  it('ready 重连卡取消沿用 SETUP_CANCELLED，本次调用不执行', async () => {
    const h = harness(readyWithReauth());
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      plan: reauthPlan(),
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve(snapshot.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });

    await expect(waiting).resolves.toEqual({
      ok: false,
      errorCode: 'SETUP_CANCELLED',
      message: '用户取消了插件设置，本次调用未执行。',
    });
    expect(h.executeAction).not.toHaveBeenCalled();
  });

  it('ready + reauthSuggest 但未带 plan 时不弹卡直接放行(建议非阻塞)', async () => {
    const h = harness(readyWithReauth());
    await expect(
      h.coordinator.ensureReady({ sessionId: 'session-1', ghostId: 'gmail', tool: 'search' }),
    ).resolves.toMatchObject({ ok: true, assessment: { state: 'ready' } });
    expect(h.bridge.pendingSnapshots()).toEqual([]);
  });

  it('ready + reauthSuggest + plan 但无交互面(IM/定时任务)时丢弃 plan 放行，不拦成 SETUP_REQUIRED', async () => {
    const h = harness(readyWithReauth());
    await expect(
      h.coordinator.ensureReady({
        sessionId: null,
        ghostId: 'gmail',
        tool: 'search',
        plan: reauthPlan(),
      }),
    ).resolves.toMatchObject({ ok: true, assessment: { state: 'ready' } });
    expect(h.bridge.pendingSnapshots()).toEqual([]);
  });

  it('ready 无 reauthSuggest 时忽略随调用携带的 plan，直接放行', async () => {
    const h = harness(ready(7));
    await expect(
      h.coordinator.ensureReady({
        sessionId: 'session-1',
        ghostId: 'gmail',
        tool: 'search',
        plan: reauthPlan(),
      }),
    ).resolves.toMatchObject({ ok: true, assessment: { state: 'ready' } });
    expect(h.bridge.pendingSnapshots()).toEqual([]);
  });

  it('ready 重连 plan 引用不匹配时拒绝 Agent 编排，回落 Host 默认单步卡', async () => {
    const h = harness(readyWithReauth());
    const invalidPlan: GhostSetupPlan = {
      ...reauthPlan(),
      steps: [
        {
          ...reauthPlan().steps[0],
          requirementRefs: ['secret:other'],
          actionId: 'oauth_connect:secret:other',
        },
      ],
    };
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      plan: invalidPlan,
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]).toMatchObject({
      title: 'Google 账号',
      action: { id: 'oauth_connect:secret:google', kind: 'oauth_connect' },
    });
    h.bridge.resolve(snapshot.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });
    await waiting;
  });

  it('submits inline Secret per request, re-assesses on change, and never snapshots the value', async () => {
    const h = harness(requiredInline());
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'api',
      tool: 'call',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    expect(snapshot.steps[0]).toMatchObject({
      title: 'API Key',
      description: '',
    });
    const secret = 'coordinator-sensitive-test-value';
    h.executeInlineAction.mockImplementationOnce(async () => {
      h.setAssessment(readyInline(1));
      h.changeBus.emit('api', { source: 'secret', ref: 'api_key' });
      return { ok: true };
    });

    expect(
      h.bridge.submitInline(snapshot.requestId, {
        actionId: 'inline_form:opaque',
        expectedRevision: snapshot.revision,
        value: secret,
      }),
    ).toBe(true);
    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(h.executeInlineAction).toHaveBeenCalledTimes(1);
    expect(h.executeAction).not.toHaveBeenCalled();
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain(secret);
  });

  it('rejects stale inline revisions without executing or retaining the Secret', async () => {
    const h = harness(requiredInline());
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'api',
      tool: 'call',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    h.bridge.submitInline('request-1', {
      actionId: 'inline_form:opaque',
      expectedRevision: 999,
      value: 'stale-sensitive-value',
    });
    await vi.waitFor(() => expect(h.executeInlineAction).not.toHaveBeenCalled());
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain('stale-sensitive-value');
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });
    await waiting;
  });

  it('keeps the original promise pending, rechecks a committed change, then resolves', async () => {
    const h = harness(required());
    let settled = false;
    const waiting = h.coordinator
      .ensureReady({ sessionId: 'session-1', ghostId: 'gmail', tool: 'search' })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    expect(settled).toBe(false);
    expect(h.bridge.pendingSnapshots()[0].request.ghost.iconDataUrl).toBe(
      'data:image/png;base64,aWNvbg==',
    );

    h.setAssessment(ready(1));
    h.changeBus.emit('gmail', { source: 'oauth', ref: 'google' });
    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(h.bridge.pendingSnapshots()).toEqual([]);
  });

  it('preserves non-empty satisfied steps in the ready terminal snapshot', async () => {
    const h = harness(required());
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const initial = h.bridge.pendingSnapshots()[0].request;

    h.setAssessment(ready(1));
    h.changeBus.emit('gmail', { source: 'oauth', ref: 'google' });
    await expect(waiting).resolves.toMatchObject({ ok: true });

    const terminalSnapshots = h.broadcast.mock.calls
      .filter(([channel]) => channel === MAKER_PUSH.INTERACTION_REQUEST)
      .map(([, payload]) => (payload as { request: GhostSetupInteractionSnapshot }).request)
      .filter((request) => request.terminal === true);
    expect(terminalSnapshots).toHaveLength(1);
    expect(terminalSnapshots[0].steps).toEqual([
      {
        id: initial.steps[0].id,
        groupId: initial.steps[0].groupId,
        groupMode: initial.steps[0].groupMode,
        title: initial.steps[0].title,
        description: initial.steps[0].description,
        phase: 'satisfied',
      },
    ]);
  });

  it('run_action is single-flight and only a later ready assessment settles', async () => {
    const h = harness(required());
    let release!: () => void;
    h.executeAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const revision = h.bridge.pendingSnapshots()[0].request.revision;
    const command: GhostSetupInteractionCommand = {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth_connect:secret:google',
      expectedRevision: revision,
    };
    h.bridge.resolve('request-1', command);
    h.bridge.resolve('request-1', command);
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    expect(h.executeAction).toHaveBeenCalledOnce();

    h.setAssessment(ready(1));
    release();
    await expect(waiting).resolves.toMatchObject({ ok: true });
  });

  it('keeps account-boundary action drain pending after the setup call is cancelled', async () => {
    const h = harness(required());
    const mutations = new GhostMutationCoordinator();
    const releaseMutation = mutations.acquire();
    let release!: () => void;
    h.executeAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    const waiting = h.coordinator
      .ensureReady({
        sessionId: 'session-1',
        ghostId: 'gmail',
        tool: 'search',
      })
      .finally(releaseMutation);
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const pending = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve(pending.requestId, {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth_connect:secret:google',
      expectedRevision: pending.revision,
    });
    await vi.waitFor(() => expect(h.executeAction).toHaveBeenCalledOnce());

    h.bridge.cleanupAll('session_aborted');
    await expect(waiting).resolves.toMatchObject({ ok: false, errorCode: 'SETUP_CANCELLED' });

    let drained = false;
    const drain = (async () => {
      await h.coordinator.waitForActionsIdle();
      await mutations.waitForIdle();
      drained = true;
    })();
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await drain;
    expect(drained).toBe(true);
  });

  it('publishes action error codes without copying Main diagnostic messages', async () => {
    const h = harness(required());
    h.executeAction.mockResolvedValue({
      ok: false,
      errorCode: 'AUTH_FAILED',
      message: '授权失败：provider-local-detail',
    });
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const initial = h.bridge.pendingSnapshots()[0].request;

    h.bridge.resolve(initial.requestId, {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth_connect:secret:google',
      expectedRevision: initial.revision,
    });

    await vi.waitFor(() => {
      const step = h.bridge.pendingSnapshots()[0].request.steps[0];
      expect(step).toMatchObject({ phase: 'failed', errorCode: 'AUTH_FAILED' });
      expect(step).not.toHaveProperty('errorMessage');
    });
    expect(JSON.stringify(h.broadcast.mock.calls)).not.toContain('provider-local-detail');

    const failed = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve(failed.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: failed.revision,
    });
    await waiting;
  });

  it('executes navigation actions once per session even in the same responding window', async () => {
    const h = harness(requiredNavigation());
    const sameWindow: GhostSetupInteractionResponseTarget = {
      id: 101,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    h.executeAction.mockResolvedValue({ ok: true, waitingExternal: true });
    const first = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'settings-ghost',
      tool: 'run',
    });
    const second = h.coordinator.ensureReady({
      sessionId: 'session-2',
      ghostId: 'settings-ghost',
      tool: 'run',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(2));

    for (const { request } of h.bridge.pendingSnapshots()) {
      h.bridge.resolve(
        request.requestId,
        {
          kind: 'plugin_setup',
          action: 'run_action',
          actionId: 'open_plugin_settings:plugin_config:settings',
          expectedRevision: request.revision,
        },
        sameWindow,
      );
    }

    await vi.waitFor(() => expect(h.executeAction).toHaveBeenCalledTimes(2));
    expect(h.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
    );
    expect(h.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-2' }),
    );

    for (const { request } of h.bridge.pendingSnapshots()) {
      h.bridge.resolve(request.requestId, {
        kind: 'plugin_setup',
        action: 'cancel',
        expectedRevision: request.revision,
      });
    }
    await Promise.all([first, second]);
  });

  it('carries navigation only to the webContents that responded', async () => {
    const h = harness(requiredNavigation());
    const firstWindow: GhostSetupInteractionResponseTarget = {
      id: 101,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const secondWindow: GhostSetupInteractionResponseTarget = {
      id: 202,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    h.executeAction.mockImplementationOnce(async ({ responseTarget }) => {
      responseTarget?.send('maker:plugin-setup:navigate', {
        sessionId: 'session-1',
        target: 'plugin_settings',
      });
      return { ok: true, waitingExternal: true };
    });

    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'settings-ghost',
      tool: 'run',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const request = h.bridge.pendingSnapshots()[0].request;

    h.bridge.resolve(
      request.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'open_plugin_settings:plugin_config:settings',
        expectedRevision: request.revision,
      },
      firstWindow,
    );

    await vi.waitFor(() => expect(firstWindow.send).toHaveBeenCalledOnce());
    expect(secondWindow.send).not.toHaveBeenCalled();
    expect(h.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ responseTarget: firstWindow }),
    );

    const current = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve(current.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: current.revision,
    });
    await waiting;
  });

  it('routes concurrent same-session navigation actions to each responding window', async () => {
    const h = harness(requiredNavigation());
    const firstWindow: GhostSetupInteractionResponseTarget = {
      id: 101,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const secondWindow: GhostSetupInteractionResponseTarget = {
      id: 202,
      isDestroyed: () => false,
      send: vi.fn(),
    };
    const releases: Array<() => void> = [];
    h.executeAction.mockImplementation(
      ({ responseTarget }) =>
        new Promise((resolve) => {
          responseTarget?.send('maker:plugin-setup:navigate', {
            sessionId: 'session-1',
            target: 'plugin_settings',
          });
          releases.push(() => resolve({ ok: true, waitingExternal: true }));
        }),
    );

    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'settings-ghost',
      tool: 'run',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const initial = h.bridge.pendingSnapshots()[0].request;

    h.bridge.resolve(
      initial.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'open_plugin_settings:plugin_config:settings',
        expectedRevision: initial.revision,
      },
      firstWindow,
    );
    await vi.waitFor(() => expect(h.executeAction).toHaveBeenCalledTimes(1));

    const running = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve(
      running.requestId,
      {
        kind: 'plugin_setup',
        action: 'run_action',
        actionId: 'open_plugin_settings:plugin_config:settings',
        expectedRevision: running.revision,
      },
      secondWindow,
    );

    await vi.waitFor(() => expect(h.executeAction).toHaveBeenCalledTimes(2));
    expect(firstWindow.send).toHaveBeenCalledOnce();
    expect(secondWindow.send).toHaveBeenCalledOnce();
    expect(h.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ responseTarget: firstWindow }),
    );
    expect(h.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ responseTarget: secondWindow }),
    );

    for (const release of releases) release();
    await vi.waitFor(() =>
      expect(h.bridge.pendingSnapshots()[0].request.steps[0]?.phase).toBe('waiting_external'),
    );
    const current = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve(current.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: current.revision,
    });
    await waiting;
  });

  it('cancel settles the waiting call without executing an action', async () => {
    const h = harness(required());
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: 0,
    });
    await expect(waiting).resolves.toEqual({
      ok: false,
      errorCode: 'SETUP_CANCELLED',
      message: '用户取消了插件设置，本次调用未执行。',
    });
    expect(h.executeAction).not.toHaveBeenCalled();
  });

  it('rejects cancellation from a stale setup revision', async () => {
    const h = harness(required());
    let settled = false;
    const waiting = h.coordinator
      .ensureReady({
        sessionId: 'session-1',
        ghostId: 'gmail',
        tool: 'search',
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const staleRevision = h.bridge.pendingSnapshots()[0].request.revision;

    h.setAssessment({ ...required(), revision: staleRevision + 1 });
    h.changeBus.emit('gmail', { source: 'secret', ref: 'google' });
    await vi.waitFor(() =>
      expect(h.bridge.pendingSnapshots()[0].request.revision).toBe(staleRevision + 1),
    );

    const broadcastsBeforeStaleCancel = h.broadcast.mock.calls.length;
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: staleRevision,
    });
    await vi.waitFor(() =>
      expect(h.broadcast.mock.calls.length).toBeGreaterThan(broadcastsBeforeStaleCancel),
    );
    expect(settled).toBe(false);
    expect(h.bridge.pendingSnapshots()[0].request.steps[0].phase).not.toBe('cancelled');

    const current = h.bridge.pendingSnapshots()[0].request;
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: current.revision,
    });
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      errorCode: 'SETUP_CANCELLED',
    });
  });

  it('non-interactive calls fail closed with the safe assessment boundary', async () => {
    const h = harness(required());
    await expect(
      h.coordinator.ensureReady({ sessionId: null, ghostId: 'gmail', tool: 'search' }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'SETUP_REQUIRED' });
  });

  it('rejects an agent plan that merges requirements from different groups', async () => {
    const assessment = requiredTwoGroups();
    const crossGroupPlan: GhostSetupPlan = {
      assessmentRevision: 0,
      steps: [
        {
          id: 'combined',
          title: '一起设置',
          description: '跨组步骤',
          requirementRefs: ['secret:google', 'client_config:image-provider'],
          actionId: 'oauth_connect:secret:google',
        },
      ],
    };
    const h = harness(assessment);
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      plan: crossGroupPlan,
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    expect(snapshot.steps).toHaveLength(2);
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });
    await waiting;
  });

  it('rejects an agent plan whose action belongs to an unreferenced item in the same group', async () => {
    const assessment: GhostSetupAssessment = {
      state: 'required',
      revision: 0,
      groups: [
        {
          ...required().groups[0],
          items: [
            ...required().groups[0].items,
            {
              ref: 'secret:api-key',
              kind: 'secret',
              label: 'API Key',
              state: 'missing',
              actions: [
                {
                  id: 'open_plugin_settings:secret:api-key',
                  kind: 'open_plugin_settings',
                },
              ],
            },
          ],
        },
      ],
    };
    const mismatchedPlan: GhostSetupPlan = {
      assessmentRevision: 0,
      steps: [
        {
          id: 'connect-google',
          title: '连接 Google',
          description: '授权 Google 账号',
          requirementRefs: ['secret:google'],
          actionId: 'open_plugin_settings:secret:api-key',
        },
      ],
    };
    const h = harness(assessment);
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      plan: mismatchedPlan,
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    expect(snapshot.steps).toHaveLength(2);
    expect(snapshot.steps[0]).toMatchObject({
      title: 'Google 账号',
      action: { id: 'oauth_connect:secret:google' },
    });
    expect(snapshot.steps[1]).toMatchObject({
      title: 'API Key',
      action: { id: 'open_plugin_settings:secret:api-key' },
    });
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });
    await waiting;
  });

  it('keeps every actionable any-of option visible even when the agent plan hides one', async () => {
    const assessment: GhostSetupAssessment = {
      state: 'required',
      revision: 0,
      groups: [
        {
          id: 'search-provider',
          mode: 'any_of',
          items: [
            {
              ref: 'secret:brave',
              kind: 'secret',
              label: 'Brave API Key',
              state: 'missing',
              actions: [
                {
                  id: 'inline_form:brave',
                  kind: 'inline_form',
                  form: {
                    fields: [
                      {
                        id: 'value',
                        type: 'secret',
                        label: 'Brave API Key',
                        required: true,
                        maxLength: 4096,
                      },
                    ],
                  },
                },
              ],
            },
            {
              ref: 'secret:tavily',
              kind: 'secret',
              label: 'Tavily API Key',
              state: 'missing',
              actions: [
                {
                  id: 'inline_form:tavily',
                  kind: 'inline_form',
                  form: {
                    fields: [
                      {
                        id: 'value',
                        type: 'secret',
                        label: 'Tavily API Key',
                        required: true,
                        maxLength: 4096,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const incompletePlan: GhostSetupPlan = {
      assessmentRevision: 0,
      steps: [
        {
          id: 'brave-only',
          title: 'Brave API Key',
          description: 'Configure Brave',
          requirementRefs: ['secret:brave'],
          actionId: 'inline_form:brave',
        },
      ],
    };
    const h = harness(assessment);
    const waiting = h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'web-search',
      tool: 'search',
      plan: incompletePlan,
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const snapshot = h.bridge.pendingSnapshots()[0].request;
    expect(snapshot.steps).toHaveLength(2);
    expect(snapshot.steps.map((step) => step.title)).toEqual(['Brave API Key', 'Tavily API Key']);
    expect(snapshot.steps.every((step) => step.groupId === 'search-provider')).toBe(true);
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });
    await waiting;
  });

  it('rechecks when a change lands during the asynchronous initial assessment', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    let release!: (value: GhostSetupAssessment) => void;
    const assess = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GhostSetupAssessment>((resolve) => {
            release = resolve;
          }),
      )
      .mockReturnValueOnce(ready(1));
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess,
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      terminalGraceMs: 0,
    });

    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    changeBus.emit('gmail', { source: 'oauth' });
    release(required(0));

    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(assess).toHaveBeenCalledTimes(2);
    expect(bridge.pendingSnapshots()).toEqual([]);
  });

  it('keeps initial assessment reads running until two consecutive in-flight changes are observed', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    let releaseFirst!: (value: GhostSetupAssessment) => void;
    let releaseSecond!: (value: GhostSetupAssessment) => void;
    const assess = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GhostSetupAssessment>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<GhostSetupAssessment>((resolve) => {
            releaseSecond = resolve;
          }),
      )
      .mockReturnValueOnce(ready(2));
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess,
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      terminalGraceMs: 0,
    });

    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    changeBus.emit('gmail', { source: 'oauth' });
    releaseFirst(required(0));
    await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(2));
    changeBus.emit('gmail', { source: 'oauth' });
    releaseSecond(required(1));

    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(assess).toHaveBeenCalledTimes(3);
  });

  it('does not lose a second change while verification is in flight', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    let releaseVerify!: (value: GhostSetupAssessment) => void;
    const assess = vi
      .fn()
      .mockReturnValueOnce(required())
      .mockImplementationOnce(
        () =>
          new Promise<GhostSetupAssessment>((resolve) => {
            releaseVerify = resolve;
          }),
      )
      .mockReturnValueOnce(ready(2));
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess,
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      terminalGraceMs: 0,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));

    changeBus.emit('gmail', { source: 'oauth' });
    await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(2));
    changeBus.emit('gmail', { source: 'oauth' });
    releaseVerify(required(1));

    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(assess).toHaveBeenCalledTimes(3);
  });

  it('publishes a stable code without leaking a Main-localized message when re-assessment fails', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    let assessmentReads = 0;
    const assess = vi.fn(() => {
      assessmentReads += 1;
      if (assessmentReads === 1) return required();
      throw new Error('setup storage unavailable');
    });
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess,
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      terminalGraceMs: 0,
    });

    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));

    changeBus.emit('gmail', { source: 'oauth' });
    await vi.waitFor(() => {
      expect(bridge.pendingSnapshots()[0].request.steps[0]).toMatchObject({
        phase: 'failed',
        errorCode: 'ASSESSMENT_FAILED',
      });
      expect(bridge.pendingSnapshots()[0].request.steps[0]).not.toHaveProperty('errorMessage');
    });

    const snapshot = bridge.pendingSnapshots()[0].request;
    bridge.resolve(snapshot.requestId, {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: snapshot.revision,
    });
    await expect(waiting).resolves.toMatchObject({ errorCode: 'SETUP_CANCELLED' });
  });

  it.each([
    ['GHOST_NOT_FOUND', '目标插件已卸载或当前不可用'],
    ['GHOST_ASLEEP', '目标插件已被停用'],
    ['TOOL_NOT_FOUND', '目标插件不再提供工具 search'],
  ] as const)(
    'settles immediately with %s when manifest lifecycle invalidates the target',
    async (errorCode, message) => {
      const h = harness(required());
      const waiting = h.coordinator.ensureReady({
        sessionId: 'session-1',
        ghostId: 'gmail',
        tool: 'search',
      });
      await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
      h.setTargetValidation({ ok: false, errorCode, message });
      h.changeBus.emit('gmail', { source: 'manifest' });

      await expect(waiting).resolves.toEqual({ ok: false, errorCode, message });
      expect(h.bridge.pendingSnapshots()).toEqual([]);
    },
  );

  it('revalidates the captured workdir policy and ignores changes for other workdirs', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    const executeAction = vi.fn();
    let disabledWorkdir: string | null = null;
    const validateTarget = vi.fn(
      (_ghostId: string, _tool: string | undefined, workingDir?: string | null) =>
        workingDir === disabledWorkdir
          ? ({
              ok: false,
              errorCode: 'GHOST_DISABLED_IN_WORKDIR',
              message: '用户已在当前工作目录停用该插件;不要重试。',
            } as const)
          : ({ ok: true } as const),
    );
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess: () => required(),
      validateTarget,
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction,
      terminalGraceMs: 0,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      workingDir: '/proj/alpha',
    });
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));

    disabledWorkdir = '/proj/beta';
    changeBus.emit('gmail', { source: 'workdir_policy' });
    await vi.waitFor(() => expect(validateTarget).toHaveBeenCalledTimes(2));
    expect(validateTarget).toHaveBeenLastCalledWith('gmail', 'search', '/proj/alpha');
    expect(bridge.pendingSnapshots()).toHaveLength(1);

    disabledWorkdir = '/proj/alpha';
    changeBus.emit('gmail', { source: 'workdir_policy' });
    await expect(waiting).resolves.toEqual({
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
      message: '用户已在当前工作目录停用该插件;不要重试。',
    });
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('setup waiter 与工具入口共用目录停用优先于未启用的可见性判序', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    const ghost = {
      dir: '/plugins/gmail',
      enabled: true,
      manifest: {
        schemaVersion: 3,
        id: 'gmail',
        name: 'Gmail',
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        tools: [{ name: 'search', description: 'Search' }],
      },
    } as InstalledGhost;
    let disabled = false;
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess: () => required(),
      validateTarget: (ghostId, _tool, workingDir) => {
        const visibility = classifyGhostVisibility(ghostId, workingDir ?? null, {
          listGhosts: () => [ghost],
          isAvailableForActiveSession: () => true,
          isDisabledForWorkdir: () => disabled,
        });
        return visibility.ok ? { ok: true } : visibility;
      },
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      terminalGraceMs: 0,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
      workingDir: '/proj/alpha',
    });
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));

    ghost.enabled = false;
    disabled = true;
    changeBus.emit('gmail', { source: 'workdir_policy' });

    await expect(waiting).resolves.toMatchObject({
      ok: false,
      errorCode: 'GHOST_DISABLED_IN_WORKDIR',
    });
    expect(bridge.pendingSnapshots()).toEqual([]);
  });

  it.each([
    { kind: 'run_action' as const, assessment: required() },
    { kind: 'inline_form' as const, assessment: requiredInline() },
  ])(
    'revalidates the captured workdir immediately before $kind side effects',
    async ({ kind, assessment }) => {
      const changeBus = new GhostSetupChangeBus();
      const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
      const executeAction = vi.fn(async (): Promise<GhostSetupActionResult> => ({ ok: true }));
      const executeInlineAction = vi.fn(async (): Promise<GhostSetupActionResult> => ({
        ok: true,
      }));
      let disabled = false;
      const coordinator = new GhostSetupCoordinator({
        changeBus,
        bridge,
        assess: () => assessment,
        validateTarget: (_ghostId, _tool, workingDir) =>
          disabled && workingDir === '/proj/alpha'
            ? {
                ok: false,
                errorCode: 'GHOST_DISABLED_IN_WORKDIR',
                message: '用户已在当前工作目录停用该插件;不要重试。',
              }
            : { ok: true },
        getGhostIdentity: () => ({ id: 'api', name: 'API' }),
        executeAction,
        executeInlineAction,
        terminalGraceMs: 0,
      });
      const waiting = coordinator.ensureReady({
        sessionId: 'session-1',
        ghostId: 'api',
        tool: 'call',
        workingDir: '/proj/alpha',
      });
      await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));
      const snapshot = bridge.pendingSnapshots()[0].request;
      const actionId = snapshot.steps[0]?.action?.id;
      if (!actionId) throw new Error('expected an actionable setup step');

      disabled = true;
      if (kind === 'run_action') {
        bridge.resolve(snapshot.requestId, {
          kind: 'plugin_setup',
          action: 'run_action',
          actionId,
          expectedRevision: snapshot.revision,
        });
      } else {
        bridge.submitInline(snapshot.requestId, {
          actionId,
          expectedRevision: snapshot.revision,
          value: 'must-not-be-stored',
        });
      }

      await expect(waiting).resolves.toEqual({
        ok: false,
        errorCode: 'GHOST_DISABLED_IN_WORKDIR',
        message: '用户已在当前工作目录停用该插件;不要重试。',
      });
      expect(executeAction).not.toHaveBeenCalled();
      expect(executeInlineAction).not.toHaveBeenCalled();
    },
  );

  it('does not let deferred verification overwrite a cancel terminal state', async () => {
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
    let releaseVerify!: (value: GhostSetupAssessment) => void;
    const assess = vi
      .fn()
      .mockReturnValueOnce(required())
      .mockImplementationOnce(
        () =>
          new Promise<GhostSetupAssessment>((resolve) => {
            releaseVerify = resolve;
          }),
      );
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess,
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      createRequestId: () => 'request-1',
      terminalGraceMs: 0,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(bridge.pendingSnapshots()).toHaveLength(1));
    changeBus.emit('gmail', { source: 'oauth' });
    await vi.waitFor(() => expect(assess).toHaveBeenCalledTimes(2));
    const revision = bridge.pendingSnapshots()[0].request.revision;
    bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: revision,
    });
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      errorCode: 'SETUP_CANCELLED',
    });

    releaseVerify(ready(2));
    await Promise.resolve();
    expect(bridge.pendingSnapshots()).toEqual([]);
  });

  it('returns INTERNAL and cleans up when opening the interaction card fails', async () => {
    const changeBus = new GhostSetupChangeBus();
    const assess = vi.fn(() => required());
    const bridge = new GhostSetupInteractionBridge({
      broadcast: () => {
        throw new Error('renderer unavailable');
      },
    });
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess,
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      terminalGraceMs: 0,
    });

    await expect(
      coordinator.ensureReady({
        sessionId: 'session-1',
        ghostId: 'gmail',
        tool: 'search',
      }),
    ).resolves.toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(bridge.pendingSnapshots()).toEqual([]);
    changeBus.emit('gmail', { source: 'oauth' });
    expect(assess).toHaveBeenCalledOnce();
  });

  it('keeps waiting_external after verification still reports required', async () => {
    const h = harness(required());
    h.executeAction.mockResolvedValue({ ok: true, waitingExternal: true });
    void h.coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.waitFor(() => expect(h.bridge.pendingSnapshots()).toHaveLength(1));
    const revision = h.bridge.pendingSnapshots()[0].request.revision;
    h.bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth_connect:secret:google',
      expectedRevision: revision,
    });
    await vi.waitFor(() => {
      expect(h.bridge.pendingSnapshots()[0].request.steps[0].phase).toBe('waiting_external');
    });
  });

  it('shows cancelled during terminal grace but resolves the original promise immediately', async () => {
    vi.useFakeTimers();
    const changeBus = new GhostSetupChangeBus();
    const broadcast = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast });
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess: () => required(),
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      createRequestId: () => 'request-1',
      terminalGraceMs: 700,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.pendingSnapshots()).toHaveLength(1);
    bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: 0,
    });
    await expect(waiting).resolves.toMatchObject({ errorCode: 'SETUP_CANCELLED' });
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_REQUEST, {
      sessionId: 'session-1',
      request: expect.objectContaining({
        terminal: true,
        steps: [expect.objectContaining({ phase: 'cancelled' })],
      }),
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: 'session-1',
      requestId: 'request-1',
      reason: 'cancelled',
    });
    vi.useRealTimers();
  });

  it('marks every pending step cancelled after an action has selected one active step', async () => {
    vi.useFakeTimers();
    const changeBus = new GhostSetupChangeBus();
    const broadcast = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast });
    let releaseAction!: () => void;
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess: () => requiredTwoGroups(),
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: () =>
        new Promise((resolve) => {
          releaseAction = () => resolve({ ok: true, waitingExternal: true });
        }),
      createRequestId: () => 'request-1',
      timeoutMs: 5_000,
      terminalGraceMs: 700,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.advanceTimersByTimeAsync(0);
    const initial = bridge.pendingSnapshots()[0].request;
    bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'run_action',
      actionId: 'oauth_connect:secret:google',
      expectedRevision: initial.revision,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.pendingSnapshots()[0].request.steps.map((step) => step.phase)).toEqual([
      'action_running',
      'pending',
    ]);

    bridge.resolve('request-1', {
      kind: 'plugin_setup',
      action: 'cancel',
      expectedRevision: bridge.pendingSnapshots()[0].request.revision,
    });
    await expect(waiting).resolves.toMatchObject({ errorCode: 'SETUP_CANCELLED' });
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_REQUEST, {
      sessionId: 'session-1',
      request: expect.objectContaining({
        terminal: true,
        steps: [
          expect.objectContaining({ phase: 'cancelled' }),
          expect.objectContaining({ phase: 'cancelled' }),
        ],
      }),
    });

    releaseAction();
    await vi.advanceTimersByTimeAsync(700);
    expect(bridge.pendingSnapshots()).toEqual([]);
    vi.useRealTimers();
  });

  it('publishes a timeout failure before resolving and keeps it visible for terminal grace', async () => {
    vi.useFakeTimers();
    const changeBus = new GhostSetupChangeBus();
    const broadcast = vi.fn();
    const bridge = new GhostSetupInteractionBridge({ broadcast });
    const coordinator = new GhostSetupCoordinator({
      changeBus,
      bridge,
      assess: () => required(),
      validateTarget: () => ({ ok: true }),
      getGhostIdentity: () => ({ id: 'gmail', name: 'Gmail' }),
      executeAction: vi.fn(),
      createRequestId: () => 'request-1',
      timeoutMs: 100,
      terminalGraceMs: 700,
    });
    const waiting = coordinator.ensureReady({
      sessionId: 'session-1',
      ghostId: 'gmail',
      tool: 'search',
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toMatchObject({ errorCode: 'TIMEOUT' });
    expect(bridge.pendingSnapshots()).toEqual([]);
    expect(broadcast).toHaveBeenLastCalledWith(MAKER_PUSH.INTERACTION_REQUEST, {
      sessionId: 'session-1',
      request: expect.objectContaining({
        terminal: true,
        steps: [
          expect.objectContaining({
            phase: 'failed',
            errorCode: 'TIMEOUT',
          }),
        ],
      }),
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(bridge.pendingSnapshots()).toEqual([]);
    vi.useRealTimers();
  });
});
