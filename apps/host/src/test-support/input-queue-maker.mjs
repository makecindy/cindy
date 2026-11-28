export function createFakeMaker() {
  const sessions = new Map();
  // Told of every message a runtime of this fake receives (the enqueue helper waits on it).
  const sendListeners = new Set();
  return {
    sessions,
    onSent(listener) { sendListeners.add(listener); return () => sendListeners.delete(listener); },
    getSession(id) {
      return sessions.get(id) ?? null;
    },
    async getSessionMeta(id) {
      return { id, agentKind: 'claude-code', model: 'stored-model', workDir: '/tmp' };
    },
    // As Maker (maker.ts listActiveSessions): the live runtimes; the shared agent switch reads it.
    listActiveSessions() { return [...sessions.values()]; },
    async closeSession(id) { sessions.delete(id); },
    async closeSessionIfCurrent(session) {
      if (sessions.get(session.id) === session) sessions.delete(session.id);
    },
    async createSession(opts) {
      const listeners = new Set();
      const session = {
        id: opts.id,
        instanceId: `runtime-${opts.id}-${Math.random()}`,
        agentKind: opts.agentKind,
        capabilities: { sameTurnSteer: { supported: true } },
        workDir: opts.workingDir,
        remoteHostId: opts.remoteHostId ?? null,
        running: false,
        generation: 0,
        get stablePermissionModeState() { return { mode: session.options.permissionMode ?? 'ask', generation: 0 }; },
        get stablePlanModeState() { return { enabled: session.options.planMode ?? false, generation: 0 }; },
        isTurnRunning() { return session.running; },
        getTurnGeneration() { return session.generation; },
        options: opts,
        get model() { return session.options.model; },
        sent: [],
        sendOptions: [],
        steerOptions: [],
        steerMessages: [],
        aborted: 0,
        async setModel(model, settings) { Object.assign(session.options, { model }, settings); },
        async setEffort(effort) { session.options.effort = effort; },
        async setPermissionMode(permissionMode) { session.options.permissionMode = permissionMode; },
        async setFastMode(fastMode) { session.options.fastMode = fastMode; },
        async setPlanMode(planMode) { session.options.planMode = planMode; },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        emit(event) {
          if (event.type === 'done' || event.type === 'error') session.running = false;
          for (const listener of [...listeners]) listener(event);
        },
        async send(text, opts = {}) {
          opts.onTurnReserved?.(++session.generation);
          await opts.beforeProviderStart?.();
          await opts.onAccepted?.(opts.signal);
          await opts.resolveAutoReviewUserIntent?.();
          opts.onDispatching?.();
          session.running = true;
          session.sent.push(typeof text === 'string' ? text : text.content);
          session.sendOptions.push(opts);
          for (const listener of [...sendListeners]) listener(session.id);
          return { accepted: true };
        },
        async abort() {
          session.aborted += 1;
          session.running = false;
          session.continuationClaim = null;
        },
        // As the maker-core Session (session.ts): the Host's claim on a generation for a silent-stop
        // continuation (released by its settle or a stop), and the continuation's send.
        continuationClaim: null,
        claimHostTurnContinuation(generation) { if (generation === session.generation) session.continuationClaim = generation; },
        settleHostTurnContinuation(generation) { if (session.continuationClaim === generation) session.continuationClaim = null; },
        sendHostTurnContinuation(text, opts) { return session.send(text, opts); },
        async steer(text, options = {}) {
          await options.beforeProviderStart?.();
          session.steerMessages.push(text);
          session.steerOptions.push(options);
          session.sent.push(`steer:${typeof text === 'string' ? text : text.content}`);
        },
      };
      sessions.set(opts.id, session);
      return session;
    },
  };
}
