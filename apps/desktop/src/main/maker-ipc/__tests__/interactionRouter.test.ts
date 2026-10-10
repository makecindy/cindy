import { describe, expect, it, vi } from 'vitest';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import { buildInteractiveCardV1 } from '../../../../../../packages/lizi-im/src/feishu/cards';
import { createCardBuilders } from '../../im/shared/cardBuilders';
import { ui as feishuUi } from '../../im/feishu/uiText';

vi.mock('../../i18n', () => ({ t: (key: string) => key }));

import {
  beginInteractionRoute,
  requestHostInteraction,
  installDesktopInteractionHandler,
  installInteractionLifecycleObserver,
  type InteractionHandler,
} from '../interactionRouter';

function permission(requestId: string): InteractionRequest {
  return {
    kind: 'permission',
    requestId,
    toolName: 'Read',
    input: {},
  } as InteractionRequest;
}

function ask(requestId: string): InteractionRequest {
  return {
    kind: 'ask_user_question',
    requestId,
    questions: [{ question: 'Which?', options: [{ label: 'yes', description: '' }] }],
  } as InteractionRequest;
}

function makeSession() {
  let listener: InteractionHandler | null = null;
  const setInteractionListener = vi.fn((next: InteractionHandler | null) => {
    listener = next;
  });
  return {
    session: { id: 'session-1', setInteractionListener },
    setInteractionListener,
    dispatch: (request: InteractionRequest) => {
      if (!listener) throw new Error('listener not installed');
      return listener(request);
    },
  };
}

describe('session interaction router', () => {
  it('collects every questionnaire answer from a first-question-only channel', async () => {
    const host = makeSession();
    const questions = Array.from({ length: 50 }, (_, index) => ({ question: `Question ${index}`, options: [{ label: 'yes', description: '' }] }));
    const channel = vi.fn<InteractionHandler>(async (request) => {
      if (request.kind !== 'ask_user_question') throw new Error('unexpected request');
      return { kind: 'ask_user_question', answers: { [request.questions[0].question]: 'yes' } };
    });
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'turn-1', origin: { kind: 'hook', source: 'slack' }, interactionSurface: 'channel-card' },
      handle: channel,
    });
    try {
      await expect(host.dispatch({ kind: 'ask_user_question', requestId: 'checklist', questions }))
        .resolves.toEqual({ kind: 'ask_user_question', answers: Object.fromEntries(questions.map(q => [q.question, 'yes'])) });
      expect(channel).toHaveBeenCalledTimes(50);
      const requests = channel.mock.calls.map(([request]) => request);
      expect(new Set(requests.map(request => request.requestId)).size).toBe(50);
      expect(requests.every(request => request.kind === 'ask_user_question' && request.questions.length === 1)).toBe(true);
    } finally { lease.release(); }
  });

  it.each([0, 1])('dismisses a questionnaire with free-text item %i before sending cards', async index => {
    const host = makeSession();
    const channel = vi.fn<InteractionHandler>();
    const questions = [0, 1].map(i => ({ question: `Question ${i}`, options: i === index ? [] : [{ label: 'yes', description: '' }] }));
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'turn-1', origin: { kind: 'im', channel: 'feishu' }, interactionSurface: 'channel-card' },
      handle: channel,
    });
    try {
      await expect(host.dispatch({ kind: 'ask_user_question', requestId: 'free-text', questions }))
        .resolves.toEqual({ kind: 'ask_user_question', answers: {}, dismissed: true });
      expect(channel).not.toHaveBeenCalled();
    } finally { lease.release(); }
  });

  it('keeps free-text questionnaires together for text input surfaces', async () => {
    const host = makeSession();
    const request: InteractionRequest = { kind: 'ask_user_question', requestId: 'text-input', questions: [{ question: 'Name?' }, { question: 'City?' }] };
    const channel = vi.fn<InteractionHandler>(async () => ({ kind: 'ask_user_question', answers: { 'Name?': 'Alice', 'City?': 'Paris' } }));
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'text-turn', origin: { kind: 'im', channel: 'dingtalk' }, interactionSurface: 'channel-card', supportsMultiQuestionInput: true },
      handle: channel,
    });
    try {
      await expect(host.dispatch(request)).resolves.toEqual({ kind: 'ask_user_question', answers: { 'Name?': 'Alice', 'City?': 'Paris' } });
      expect(channel).toHaveBeenCalledExactlyOnceWith(request);
    } finally { lease.release(); }
  });

  it.each(['timeout', 'release', 'abort'] as const)('retains completed pages on router %s', async stop => {
    vi.useFakeTimers();
    const host = makeSession();
    const controller = new AbortController();
    const channel = vi.fn<InteractionHandler>()
      .mockResolvedValueOnce({ kind: 'ask_user_question', answers: { 'First?': 'yes' } })
      .mockImplementation(() => new Promise(() => {}));
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'partial-turn', origin: { kind: 'im', channel: 'feishu' }, interactionSurface: 'channel-card', timeoutMs: 100 },
      handle: channel,
    });
    try {
      const pending = requestHostInteraction(host.session, { kind: 'ask_user_question', requestId: 'partial', questions: ['First?', 'Second?'].map(question => ({ question, options: [{ label: 'yes', description: '' }] })) }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(channel).toHaveBeenCalledTimes(2);
      if (stop === 'timeout') await vi.advanceTimersByTimeAsync(100);
      else if (stop === 'release') lease.release();
      else controller.abort();
      await expect(pending).resolves.toEqual({ kind: 'ask_user_question', answers: { 'First?': 'yes' }, dismissed: true });
    } finally { lease.release(); vi.useRealTimers(); }
  });

  it('routes Host download permissions through the active channel without replacing the listener', async () => {
    const host = makeSession();
    const desktop = vi.fn<InteractionHandler>((_request, shared) => shared!.result);
    const remote = vi.fn(async (): Promise<InteractionDecision> => ({ kind: 'permission', behavior: 'allow' }));
    installDesktopInteractionHandler(host.session, desktop);
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'turn-1', origin: { kind: 'im', channel: 'feishu' }, interactionSurface: 'channel-card' },
      handle: remote,
    });
    try {
      await expect(requestHostInteraction(host.session, permission('download-1'), new AbortController().signal))
        .resolves.toMatchObject({ behavior: 'allow' });
      expect(remote).toHaveBeenCalledOnce();
      expect(desktop).toHaveBeenCalledOnce();
      expect(host.setInteractionListener).toHaveBeenCalledOnce();
    } finally { lease.release(); }
  });

  it.each(['release', 'timeout', 'abort'] as const)('stops channel pagination on %s and ignores late answers', async (stop) => {
    vi.useFakeTimers();
    const host = makeSession();
    const controller = new AbortController();
    let answer!: (decision: InteractionDecision) => void;
    const channel = vi.fn<InteractionHandler>(() => new Promise(resolve => { answer = resolve; }));
    const onCancel = vi.fn(() => true);
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'turn-1', origin: { kind: 'hook', source: 'slack' }, interactionSurface: 'channel-card', timeoutMs: 100 },
      handle: channel,
      onCancel,
    });
    try {
      const pending = requestHostInteraction(host.session, {
        kind: 'ask_user_question', requestId: 'cancel-checklist',
        questions: [{ question: 'First?', options: [{ label: 'yes', description: '' }] }, { question: 'Second?', options: [{ label: 'yes', description: '' }] }],
      }, controller.signal);
      expect(channel).toHaveBeenCalledOnce();
      const surfaceSignal = channel.mock.calls[0][2];
      expect(surfaceSignal?.aborted).toBe(false);
      const pageId = channel.mock.calls[0][0].requestId;
      if (stop === 'release') lease.release();
      else if (stop === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ kind: 'ask_user_question', answers: {} });
      expect(surfaceSignal?.aborted).toBe(true);
      expect(onCancel).toHaveBeenCalledWith(pageId, expect.objectContaining({ kind: 'ask_user_question' }));
      answer({ kind: 'ask_user_question', answers: { 'First?': 'late' } });
      await vi.runAllTimersAsync();
      expect(channel).toHaveBeenCalledOnce();
    } finally {
      lease.release();
      vi.useRealTimers();
    }
  });

  it('keeps Desktop questionnaires together', async () => {
    const host = makeSession();
    const desktop = vi.fn<InteractionHandler>(async () => ({ kind: 'ask_user_question', answers: {} }));
    installDesktopInteractionHandler(host.session, desktop);
    const request: InteractionRequest = {
      kind: 'ask_user_question', requestId: 'desktop-checklist',
      questions: [{ question: 'First?', options: [{ label: 'yes', description: '' }] }, { question: 'Second?', options: [{ label: 'yes', description: '' }] }],
    };
    await host.dispatch(request);
    expect(desktop).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('keeps serialized Feishu cards below 30 KB for a 50-item questionnaire', async () => {
    const host = makeSession();
    const cards = createCardBuilders(feishuUi, () => 'high');
    const questions = Array.from({ length: 50 }, (_, index) => ({
      header: `Item ${index}`,
      question: `Question ${index}: ${'说明'.repeat(100)}`,
      options: ['A', 'B', 'C'].map(label => ({ label: `${label}: ${'选项'.repeat(15)}`, description: '' })),
      multiSelect: false,
    }));
    const request: Extract<InteractionRequest, { kind: 'ask_user_question' }> = {
      kind: 'ask_user_question', requestId: 'feishu-checklist', questions,
    };
    const bytes = (req: typeof request) => Buffer.byteLength(JSON.stringify(buildInteractiveCardV1(cards.buildAskUserCard(req)!)));
    expect(bytes(request)).toBeGreaterThan(30_000);
    const sizes: number[] = [];
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'turn-1', origin: { kind: 'im', channel: 'feishu' }, interactionSurface: 'channel-card' },
      handle: async req => {
        if (req.kind !== 'ask_user_question') throw new Error('unexpected request');
        sizes.push(bytes(req));
        return { kind: 'ask_user_question', answers: { [req.questions[0].question]: req.questions[0].options![0].label } };
      },
    });
    try {
      const result = await host.dispatch(request);
      expect(sizes).toHaveLength(50);
      expect(Math.max(...sizes)).toBeLessThan(30_000);
      expect(result.kind === 'ask_user_question' && Object.keys(result.answers)).toHaveLength(50);
    } finally { lease.release(); }
  });

  it('keeps a skipped item empty and stops on channel dismissal', async () => {
    const host = makeSession();
    const channel = vi.fn<InteractionHandler>()
      .mockResolvedValueOnce({ kind: 'ask_user_question', answers: {} })
      .mockResolvedValueOnce({ kind: 'ask_user_question', answers: { 'Second?': 'yes' } })
      .mockResolvedValueOnce({ kind: 'ask_user_question', answers: {}, dismissed: true });
    const lease = beginInteractionRoute(host.session, {
      route: { sessionId: host.session.id, turnId: 'turn-1', origin: { kind: 'im', channel: 'feishu' }, interactionSurface: 'channel-card' },
      handle: channel,
    });
    try {
      await expect(host.dispatch({
        kind: 'ask_user_question', requestId: 'skip-checklist',
        questions: ['First?', 'Second?', 'Third?', 'Fourth?'].map(question => ({ question, options: [{ label: 'yes', description: '' }] })),
      })).resolves.toEqual({ kind: 'ask_user_question', answers: { 'Second?': 'yes' }, dismissed: true });
      expect(channel).toHaveBeenCalledTimes(3);
    } finally { lease.release(); }
  });

  it('cancels the ordinary pending card when a Host permission is aborted', async () => {
    const host = makeSession();
    const controller = new AbortController();
    const cancel = vi.fn();
    installDesktopInteractionHandler(host.session, () => new Promise(() => {}), cancel);
    const pending = requestHostInteraction(host.session, permission('download-2'), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(cancel).toHaveBeenCalledWith('download-2', expect.objectContaining({ behavior: 'deny' }));
  });

  it('owns one listener and falls back to the Desktop handler', async () => {
    const harness = makeSession();
    const desktop = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));

    installDesktopInteractionHandler(harness.session, desktop);
    installDesktopInteractionHandler(harness.session, desktop);

    await expect(harness.dispatch(permission('desktop-1'))).resolves.toMatchObject({
      behavior: 'allow',
    });
    expect(harness.setInteractionListener).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledTimes(1);
  });

  it('routes only the admitted turn to its channel surface', async () => {
    const harness = makeSession();
    const desktop = vi.fn<InteractionHandler>(async (_request, shared) => shared ? shared.result : ({
      kind: 'permission',
      behavior: 'deny',
      reason: 'desktop',
    }));
    const channel = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));
    installDesktopInteractionHandler(harness.session, desktop);

    const lease = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'feishu-turn-1',
        origin: { kind: 'im', channel: 'feishu' },
        interactionSurface: 'channel-card',
      },
      handle: channel,
    });

    await expect(harness.dispatch(permission('channel-1'))).resolves.toMatchObject({
      behavior: 'allow',
    });
    lease.release();
    await expect(harness.dispatch(permission('desktop-2'))).resolves.toMatchObject({
      reason: 'desktop',
    });
    expect(channel).toHaveBeenCalledTimes(1);
    expect(desktop).toHaveBeenCalledTimes(2);
    expect(harness.setInteractionListener).toHaveBeenCalledTimes(1);
  });

  it('routes an admitted personal WeChat turn to Desktop without a channel handler', async () => {
    const harness = makeSession();
    const desktop = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));
    installDesktopInteractionHandler(harness.session, desktop);

    const lease = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'wechat-task-1',
        origin: { kind: 'im', channel: 'wechat', taskId: 'wechat-task-1' },
        interactionSurface: 'desktop',
      },
    });

    await expect(harness.dispatch(permission('wechat-1'))).resolves.toMatchObject({
      behavior: 'allow',
    });
    expect(desktop).toHaveBeenCalledOnce();
    lease.release();
  });

  it('fails a Desktop-routed confirmation closed when its turn timeout expires', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeSession();
      installDesktopInteractionHandler(
        harness.session,
        async () => new Promise<InteractionDecision>(() => {}),
      );
      const states: string[] = [];
      const lease = beginInteractionRoute(harness.session, {
        route: {
          sessionId: 'session-1',
          turnId: 'wechat-task-timeout',
          origin: {
            kind: 'im',
            channel: 'wechat',
            taskId: 'wechat-task-timeout',
          },
          interactionSurface: 'desktop',
          timeoutMs: 100,
          onStateChange: (state) => states.push(state),
        },
      });

      const decision = harness.dispatch(permission('wechat-timeout'));
      await vi.advanceTimersByTimeAsync(100);

      await expect(decision).resolves.toMatchObject({
        kind: 'permission',
        behavior: 'deny',
        reason: 'interaction_timeout',
      });
      expect(states).toEqual(['waiting', 'cancelled']);
      lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending requests with a kind-correct safe decision on release', async () => {
    const harness = makeSession();
    let keepPending!: () => void;
    const never = new Promise<void>((resolve) => {
      keepPending = resolve;
    });
    const onCancel = vi.fn();
    const states: string[] = [];
    const lease = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'slack-turn-1',
        origin: { kind: 'im', channel: 'slack' },
        interactionSurface: 'channel-card',
        onStateChange: (state) => states.push(state),
      },
      handle: async () => {
        await never;
        return { kind: 'ask_user_question', answers: { Which: 'late' } };
      },
      onCancel,
    });

    const decision = harness.dispatch(ask('ask-1'));
    await vi.waitFor(() => expect(states).toEqual(['waiting']));
    lease.release('turn_terminal');

    await expect(decision).resolves.toEqual({
      kind: 'ask_user_question',
      answers: {},
    });
    expect(onCancel).toHaveBeenCalledWith('ask-1', {
      kind: 'ask_user_question',
      answers: {},
    });
    expect(states).toEqual(['waiting', 'cancelled']);
    keepPending();
  });

  it('notifies lifecycle observer on resolve, timeout, release, and handler throw', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeSession();
      const starts: string[] = [];
      const ends: string[] = [];
      installInteractionLifecycleObserver(harness.session, {
        onStart: (request) => starts.push(request.requestId),
        onEnd: (request) => ends.push(request.requestId),
      });
      installDesktopInteractionHandler(harness.session, async (request) => {
        if (request.requestId === 'throw') throw new Error('boom');
        if (request.requestId === 'release' || request.requestId === 'timeout') {
          return new Promise<InteractionDecision>(() => {});
        }
        return { kind: 'permission', behavior: 'allow' };
      });

      await expect(harness.dispatch(permission('resolve'))).resolves.toMatchObject({ behavior: 'allow' });
      await expect(harness.dispatch(permission('throw'))).resolves.toMatchObject({
        reason: 'interaction_handler_failed',
      });
      const timeoutLease = beginInteractionRoute(harness.session, {
        route: {
          sessionId: 'session-1',
          turnId: 'timeout-observer',
          origin: { kind: 'im', channel: 'wechat' },
          interactionSurface: 'desktop',
          timeoutMs: 50,
        },
      });
      const timeoutPromise = harness.dispatch(permission('timeout'));
      await vi.advanceTimersByTimeAsync(50);
      await expect(timeoutPromise).resolves.toMatchObject({ reason: 'interaction_timeout' });
      timeoutLease.release();
      const releaseLease = beginInteractionRoute(harness.session, {
        route: {
          sessionId: 'session-1',
          turnId: 'release-observer',
          origin: { kind: 'im', channel: 'wechat' },
          interactionSurface: 'desktop',
        },
      });
      const releasePromise = harness.dispatch(permission('release'));
      await vi.waitFor(() => expect(starts).toContain('release'));
      releaseLease.release('turn_terminal');
      await expect(releasePromise).resolves.toMatchObject({ reason: 'turn_terminal' });
      expect(starts).toEqual(['resolve', 'throw', 'timeout', 'release']);
      expect(ends).toEqual(['resolve', 'throw', 'timeout', 'release']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects overlapping routes before provider dispatch', () => {
    const harness = makeSession();
    const handle = vi.fn(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'allow',
    }));
    const first = beginInteractionRoute(harness.session, {
      route: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        origin: { kind: 'hook', source: 'slack' },
        interactionSurface: 'channel-card',
      },
      handle,
    });

    expect(() =>
      beginInteractionRoute(harness.session, {
        route: {
          sessionId: 'session-1',
          turnId: 'turn-2',
          origin: { kind: 'im', channel: 'discord' },
          interactionSurface: 'channel-card',
        },
        handle,
      }),
    ).toThrow(/already active/);

    first.release();
  });
});
