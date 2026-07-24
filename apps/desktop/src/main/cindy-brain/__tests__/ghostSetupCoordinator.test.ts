import { describe, expect, it, vi } from 'vitest';

import type { GhostSetupAssessment, GhostSetupPlan } from '../../../shared/ghost';
import { GhostSetupChangeBus } from '../ghostSetupChangeBus';
import {
  GhostSetupCoordinator,
  type GhostSetupActionResult,
  type GhostSetupTargetValidation,
} from '../ghostSetupCoordinator';
import {
  GhostSetupInteractionBridge,
  type GhostSetupInteractionCommand,
} from '../ghostSetupInteractionBridge';

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

function harness(initial: GhostSetupAssessment) {
  const changeBus = new GhostSetupChangeBus();
  const broadcast = vi.fn();
  const bridge = new GhostSetupInteractionBridge({ broadcast });
  let assessment = initial;
  let targetValidation: GhostSetupTargetValidation = { ok: true };
  const executeAction = vi.fn(async (): Promise<GhostSetupActionResult> => ({ ok: true }));
  const executeInlineAction = vi.fn(async (): Promise<GhostSetupActionResult> => ({ ok: true }));
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
    createRequestId: () => 'request-1',
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
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
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
    expect(bridge.pendingSnapshots()[0].request.steps[0].phase).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(700);
    expect(bridge.pendingSnapshots()).toEqual([]);
    vi.useRealTimers();
  });

  it('marks every pending step cancelled after an action has selected one active step', async () => {
    vi.useFakeTimers();
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
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
    expect(bridge.pendingSnapshots()[0].request.steps.map((step) => step.phase)).toEqual([
      'cancelled',
      'cancelled',
    ]);

    releaseAction();
    await vi.advanceTimersByTimeAsync(700);
    expect(bridge.pendingSnapshots()).toEqual([]);
    vi.useRealTimers();
  });

  it('publishes a timeout failure before resolving and keeps it visible for terminal grace', async () => {
    vi.useFakeTimers();
    const changeBus = new GhostSetupChangeBus();
    const bridge = new GhostSetupInteractionBridge({ broadcast: vi.fn() });
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
    expect(bridge.pendingSnapshots()[0].request.steps[0]).toMatchObject({
      phase: 'failed',
      errorMessage: '等待超时',
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(bridge.pendingSnapshots()).toEqual([]);
    vi.useRealTimers();
  });
});
