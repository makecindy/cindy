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
      state = {
        items: [],
        active: null,
        running: false,
        unsubscribe: null,
        queueExpanded: false,
        queueInteractionLocks: [],
        queueEditLocks: [],
      };
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
      queuePaused: Boolean(state?.queuePaused),
      queueExpanded: Boolean(state?.queueExpanded),
      queueInteractionLocks: [...(state?.queueInteractionLocks ?? [])],
      queueEditLocks: [...(state?.queueEditLocks ?? [])],
      queueAbortPending: false,
      error: state?.error ?? null,
      recovery: null,
      errorRetryText: null,
      usageLimitWait: null,
      credentialSwitchWait: null,
    };
  }

  function emitProjection(sessionId) {
    const proj = projection(sessionId);
    deps.hub?.publish({ type: 'input_projection', sessionId, projection: proj });
    return proj;
  }

  async function dispatch(sessionId) {
    const state = stateFor(sessionId);
    if (state.running || state.queuePaused) return;
    // The running message leaves the queue: the projection's pendingQueue is
    // what is still waiting, matching the desktop renderer's expectation.
    const next = state.items.shift();
    if (!next) return;
    state.active = next;

    const stored = await deps.readSession(sessionId);
    const maker = deps.getMaker();
    const makerKind = toMakerAgentKind(next.agentKind || stored.agentKind);
    const dbKind = toDbAgentKind(next.agentKind || stored.agentKind);

    // Persist user message immediately so both browser SSE and device-link see it
    if (deps.persistMessage) {
      await deps.persistMessage(sessionId, {
        clientId: next.clientId,
        role: 'user',
        content: next.persistedContent || next.text,
        createdAt: next.createdAt,
        agentKind: dbKind,
      }).catch(() => {});
    }

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
    state.error = null;
    emitProjection(sessionId);

    state.unsubscribe?.();
    let finished = false;
    let turnAssistantClientId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let turnError = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      state.running = false;
      state.unsubscribe?.();
      state.unsubscribe = null;
      state.active = null;
      emitProjection(sessionId);
      // A turn stopped before its final event still leaves what the user saw.
      if (!finalTextPersisted && assistantText.trim() && deps.persistMessage) {
        void deps.persistMessage(sessionId, {
          clientId: turnAssistantClientId,
          role: 'assistant',
          content: assistantText,
          agentKind: dbKind,
        }).catch(() => {});
      } else if (!finalTextPersisted && turnError && deps.persistMessage) {
        void deps.persistMessage(sessionId, {
          clientId: turnAssistantClientId,
          role: 'error',
          content: JSON.stringify({ message: turnError }),
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
      if (!finalTextPersisted && event.agentMeta?.uuid && typeof event.agentMeta.uuid === 'string') {
        turnAssistantClientId = event.agentMeta.uuid;
      }
      if (event.type === 'error') {
        turnError = event.data?.message || event.message || (typeof event.data === 'string' ? event.data : 'Agent error');
        state.error = turnError;
      }
      deps.hub.publish({
        type: 'agent_event',
        sessionId,
        event,
        persistId: turnAssistantClientId,
        ...event,
      });
      if (event.type === 'text' && typeof event.data?.text === 'string') {
        if (event.data.isFinal) {
          // Final text carries the complete assistant answer for this turn.
          if (deps.persistMessage) {
            void deps.persistMessage(sessionId, {
              clientId: turnAssistantClientId,
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
        turnError = 'send_rejected';
        state.error = turnError;
        deps.hub.publish({
          type: 'error',
          sessionId,
          event: { type: 'error', reason: 'send_rejected', detail: result ?? null },
          reason: 'send_rejected',
          detail: result ?? null,
        });
        finish();
        return;
      }
      deps.sent(sessionId);
    } catch (error) {
      turnError = error instanceof Error ? error.message : String(error);
      state.error = turnError;
      deps.hub.publish({
        type: 'error',
        sessionId,
        event: {
          type: 'error',
          reason: 'send_failed',
          message: turnError,
        },
        reason: 'send_failed',
        message: turnError,
      });
      finish();
    }
  }

  return {
    projection,
    getProjection(sessionId) {
      return projection(sessionId);
    },
    async enqueue(sessionId, item) {
      const state = stateFor(sessionId);
      const text = (typeof item?.text === 'string' && item.text.trim())
        ? item.text
        : (typeof item?.content === 'string' && item.content.trim())
        ? item.content
        : (typeof item?.persistedContent === 'string' && item.persistedContent.trim())
        ? item.persistedContent
        : '';
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
      emitProjection(sessionId);
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
        state.queuePaused = state.items.length > 0;
      }
      return emitProjection(sessionId);
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
      return emitProjection(sessionId);
    },
    async updateContent(sessionId, clientId, item) {
      const state = stateFor(sessionId);
      const index = state.items.findIndex((entry) => entry.clientId === clientId);
      if (index !== -1) {
        state.items[index] = {
          ...state.items[index],
          ...item,
          clientId,
          text: typeof item?.text === 'string' ? item.text : state.items[index].text,
          persistedContent: typeof item?.persistedContent === 'string'
            ? item.persistedContent
            : typeof item?.text === 'string'
              ? item.text
              : state.items[index].persistedContent,
        };
      }
      return emitProjection(sessionId);
    },
    async updateText(sessionId, clientId, newText) {
      const state = stateFor(sessionId);
      const index = state.items.findIndex((entry) => entry.clientId === clientId);
      if (index !== -1) {
        state.items[index] = {
          ...state.items[index],
          text: String(newText ?? ''),
        };
      }
      return emitProjection(sessionId);
    },
    async move(sessionId, clientId, targetIndex) {
      const state = stateFor(sessionId);
      const index = state.items.findIndex((entry) => entry.clientId === clientId);
      if (index !== -1 && typeof targetIndex === 'number' && Number.isFinite(targetIndex)) {
        const [moved] = state.items.splice(index, 1);
        const clampedIndex = Math.max(0, Math.min(targetIndex, state.items.length));
        state.items.splice(clampedIndex, 0, moved);
      }
      return emitProjection(sessionId);
    },
    async setExpanded(sessionId, expanded) {
      const state = stateFor(sessionId);
      state.queueExpanded = Boolean(expanded);
      return emitProjection(sessionId);
    },
    async setInteractionLock(sessionId, lockId, locked) {
      const state = stateFor(sessionId);
      if (locked) {
        if (!state.queueInteractionLocks.includes(lockId)) {
          state.queueInteractionLocks.push(lockId);
        }
      } else {
        state.queueInteractionLocks = state.queueInteractionLocks.filter((id) => id !== lockId);
      }
      return emitProjection(sessionId);
    },
    async setEditLock(sessionId, clientId, locked) {
      const state = stateFor(sessionId);
      if (locked) {
        if (!state.queueEditLocks.includes(clientId)) {
          state.queueEditLocks.push(clientId);
        }
      } else {
        state.queueEditLocks = state.queueEditLocks.filter((id) => id !== clientId);
      }
      return emitProjection(sessionId);
    },
    async clearSession(sessionId) {
      const state = sessions.get(sessionId);
      if (state) state.items = [];
      return emitProjection(sessionId);
    },
    async resume(sessionId) {
      const state = stateFor(sessionId);
      state.queuePaused = false;
      await dispatch(sessionId);
      return emitProjection(sessionId);
    },
  };
}
