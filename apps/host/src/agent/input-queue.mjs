/**
 * Input queue for the browser client.
 *
 * The renderer's composer enqueues messages (`maker.input.enqueue`) instead of
 * calling `maker.send`. One runtime owns one turn per task, so this queue keeps
 * the real semantics: the next item starts when the previous turn reaches its
 * terminal event, and `stop` aborts the running turn while leaving the rest of
 * the queue in place.
 */

function toMakerAgentKind(kind) {
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'claude-code';
}

function toDbAgentKind(kind) {
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'cc';
}

/**
 * @param {{
 *   getMaker: () => any,
 *   hub: {publish: (event: unknown) => void},
 *   readSession: (sessionId: string) => Promise<{
 *     id: string, agentKind: string, model: string, workingDir: string, providerId: string | null
 *   }>,
 *   sent: (sessionId: string) => void,
 * }} deps
 */
export function createInputQueue(deps) {
  /** @type {Map<string, {items: Array<{clientId: string, text: string}>, running: boolean, unsubscribe: (() => void) | null}>} */
  const sessions = new Map();

  function stateFor(sessionId) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { items: [], active: null, running: false, unsubscribe: null };
      sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Full `AgentInputProjection`. The renderer's store reads every field, so a
   * partial object makes it rebuild state on each render and trips React's
   * update-depth guard.
   */
  function projection(sessionId) {
    const state = sessions.get(sessionId);
    return {
      sessionId,
      turnInProgress: state?.running === true,
      // Project the renderer's own queued item back verbatim: the queue UI reads
      // persistedContent/model/effort/permissionMode and the attachment lists.
      pendingQueue: [...(state?.items ?? [])],
      clearBoundaryMs: null,
      continuationInFlightClientId: null,
      continuationTurnClientId: null,
      steeringQueueClientIds: [],
      queuePaused: false,
      queueExpanded: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      error: null,
      recovery: null,
      errorRetryText: null,
      usageLimitWait: null,
      credentialSwitchWait: null,
    };
  }

  async function dispatch(sessionId) {
    const state = stateFor(sessionId);
    if (state.running) return;
    // The running message leaves the queue: the projection's pendingQueue is
    // what is still waiting, matching the desktop renderer's expectation.
    const next = state.items.shift();
    if (!next) return;
    state.active = next;

    const stored = await deps.readSession(sessionId);
    const maker = deps.getMaker();
    const makerKind = toMakerAgentKind(next.agentKind || stored.agentKind);
    const dbKind = toDbAgentKind(next.agentKind || stored.agentKind);
    const session = maker.getSession(sessionId) ?? await maker.createSession({
      id: sessionId,
      agentKind: makerKind,
      workingDir: next.workingDir || stored.workingDir,
      // The composer owns the route for this message; the row only supplies the
      // fallback when the item does not name one.
      model: next.model || stored.model,
      effort: next.effort || undefined,
      permissionMode: next.permissionMode || undefined,
      providerId: stored.providerId ?? undefined,
    });

    // Permission prompts and questions must reach a client before the turn can
    // continue; the broker owns that handshake.
    deps.interactions?.attach(session, sessionId);

    state.running = true;

    state.unsubscribe?.();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      state.running = false;
      state.unsubscribe?.();
      state.unsubscribe = null;
      state.active = null;
      // A turn stopped before its final event still leaves what the user saw.
      if (!finalTextPersisted && assistantText.trim() && deps.persistMessage) {
        void deps.persistMessage(sessionId, {
          clientId: `partial-${Date.now()}`,
          role: 'assistant',
          content: assistantText,
          agentKind: dbKind,
        }).catch(() => {});
      }
      // Start the next queued item from a microtask so the terminal event of
      // this turn is delivered first.
      void Promise.resolve().then(() => dispatch(sessionId)).catch(() => {});
    };

    let assistantText = '';
    let finalTextPersisted = false;
    state.unsubscribe = session.onEvent((event) => {
      deps.hub.publish({ sessionId, ...event });
      if (event.type === 'text' && typeof event.data?.text === 'string') {
        if (event.data.isFinal) {
          // Final text carries the complete assistant answer for this turn.
          if (deps.persistMessage) {
            void deps.persistMessage(sessionId, {
              clientId: event.agentMeta?.uuid ?? `${Date.now()}-assistant`,
              role: 'assistant',
              content: event.data.text,
              agentMeta: event.agentMeta ?? null,
              agentKind: dbKind,
            }).catch(() => {});
          }
          assistantText = '';
          finalTextPersisted = true;
        } else {
          assistantText += event.data.text;
        }
      }
      if (event.type === 'done' || (event.type === 'error' && event.turnScope !== 'background')) {
        finish();
      }
    });

    try {
      const result = await session.send(next.text);
      if (!result || result.accepted !== true) {
        deps.hub.publish({
          type: 'error',
          sessionId,
          reason: 'send_rejected',
          detail: result ?? null,
        });
        finish();
        return;
      }
      deps.sent(sessionId);
      if (deps.persistMessage) {
        await deps.persistMessage(sessionId, {
          clientId: next.clientId,
          role: 'user',
          content: next.persistedContent || next.text,
          createdAt: next.createdAt,
          agentKind: dbKind,
        }).catch(() => {});
      }
    } catch (error) {
      deps.hub.publish({
        type: 'error',
        sessionId,
        reason: 'send_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      finish();
    }
  }

  return {
    projection,
    async enqueue(sessionId, item) {
      const state = stateFor(sessionId);
      const text = typeof item?.text === 'string' ? item.text : '';
      if (!text.trim()) throw new Error('message text is required');
      const clientId = typeof item?.clientId === 'string' && item.clientId
        ? item.clientId
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      state.items.push({
        ...item,
        clientId,
        text,
        persistedContent: typeof item?.persistedContent === 'string' ? item.persistedContent : text,
        model: typeof item?.model === 'string' ? item.model : '',
        effort: typeof item?.effort === 'string' ? item.effort : '',
        permissionMode: typeof item?.permissionMode === 'string' ? item.permissionMode : '',
        workingDir: typeof item?.workingDir === 'string' ? item.workingDir : '',
      });
      await dispatch(sessionId);
      return projection(sessionId);
    },
    async stop(sessionId) {
      const session = deps.getMaker().getSession(sessionId);
      if (session) await session.abort().catch(() => {});
      const state = sessions.get(sessionId);
      if (state) {
        state.running = false;
        state.unsubscribe?.();
        state.unsubscribe = null;
      }
      return projection(sessionId);
    },
    async steer(sessionId, item) {
      const session = deps.getMaker().getSession(sessionId);
      if (!session) return false;
      const text = typeof item?.text === 'string' ? item.text : '';
      if (!text.trim()) return false;
      const result = await session.steer(text).catch(() => null);
      return Boolean(result && result.accepted !== false);
    },
    async remove(sessionId, clientId) {
      const state = sessions.get(sessionId);
      if (state) state.items = state.items.filter((entry) => entry.clientId !== clientId);
      return projection(sessionId);
    },
    async resume(sessionId) {
      await dispatch(sessionId);
      return projection(sessionId);
    },
  };
}
