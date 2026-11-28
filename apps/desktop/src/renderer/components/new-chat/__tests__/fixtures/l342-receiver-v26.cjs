const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
function createLegacyReceiver(input) {
    const { id, model, providerId, effort, fastMode, models } = input;
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE task (id TEXT PRIMARY KEY, model TEXT, providerId TEXT, effort TEXT, fastMode INTEGER)');
    db.prepare('INSERT INTO task VALUES (?, ?, ?, ?, ?)').run(id, model, providerId, effort, Number(fastMode));
    const read = () => {
        const row = db.prepare('SELECT model, providerId, effort, fastMode FROM task WHERE id = ?').get(id);
        return { ...row, fastMode: Boolean(row.fastMode) };
    };
    const writes = [];
    const candidate = new Map();
    const intentPushes = [];
    const live = {
        id, model, agentKind: 'codex', codexProxyActive: false, isTurnRunning: () => true,
        setModel() { throw new Error('should not set the live model mid-turn'); },
        setEffort() { throw new Error('should not set live effort mid-turn'); },
        setFastMode() { throw new Error('should not set live Fast mid-turn'); },
    };
    const maker = {
        getSession: sessionId => sessionId === id ? live : undefined,
        listActiveSessions: () => [live],
        getCapabilities: () => ({ availableModels: models, hasFastMode: true }),
        closeSession() { throw new Error('should not close a busy session'); },
    };
    const channels = new Map();
    const ipcMain = { handle: (channel, callback) => channels.set(channel, callback) };
    const MAKER_INVOKE = {
        GET_CAPABILITIES: 'maker:get-capabilities',
        SWITCH_SESSION_AGENT: 'maker:switch-session-agent', GET_SESSION_AGENT_SWITCH_INTENT: 'maker:get-session-agent-switch-intent',
        SET_MODEL: 'maker:set-model', SET_EFFORT: 'maker:set-effort', SET_FAST_MODE: 'maker:set-fast-mode',
    };
    // App-owned ports for a synthetic busy local Codex task. No account or old native app is needed.
    const withSendToSessionLock = async (sessionId, action) => {
        assert.equal(sessionId, id);
        return action();
    };
    const assertModelRouteUsable = async (agent, requestedModel) => {
        assert.equal(agent, 'codex');
        assert.ok(models.some(m => m.id === requestedModel), requestedModel);
    };
    const getSessionDbAgentKind = () => 'codex';
    const requireAgentKind = agent => agent;
    const isSessionInTurn = () => true;
    const registerPendingCredentialSwitchForSession = (taskId, target) => { candidate.set(taskId, target); };
    const clearPendingCredentialSwitchForSession = taskId => { candidate.delete(taskId); };
    const getPendingCredentialSwitchTarget = taskId => candidate.get(taskId);
    const pendingCredentialSwitchHolder = candidate;
    const getCodexProxyAuthInjectionState = () => null;
    const wakeSessionInputAfterCredentialSwitch = () => { throw new Error('busy task cannot wake'); };
    const withRehydrateCloseSuppressed = () => { throw new Error('busy task cannot close'); };
    const broadcastSessionPatched = (taskId, patch) => { intentPushes.push([taskId, patch]); };
    const throwIpcError = (code, message) => { throw Object.assign(new Error(message), { code }); };
    const log = { info() { }, debug() { } };
    function resolveAgentCredentialMode(options) {
        const providerId = options.providerId?.trim() || null;
        if (providerId === 'xd')
            return 'gateway-key';
        if (options.agentKind === 'claude-code' && providerId === 'anthropic')
            return 'oauth-bearer';
        if (options.agentKind === 'codex' && providerId === 'openai')
            return 'oauth-bearer';
        if (providerId)
            return 'provider-oauth';
        const model = options.model?.trim() ?? '';
        if (model.startsWith('codex/'))
            return 'gateway-key';
        if (model.startsWith('chatgpt/') || model.startsWith('xai/'))
            return 'provider-oauth';
        return undefined;
    }
    function resolveEffectiveCredentialModeFromAuthSource(requested, authSource) {
        if (requested)
            return requested;
        if (authSource === 'oauth')
            return 'oauth-bearer';
        if (authSource === 'api-key')
            return 'gateway-key';
        return undefined;
    }
    function canReuseHostForCredentialMode(currentMode, requestedMode) {
        if (requestedMode === 'provider-oauth' && currentMode !== undefined)
            return true;
        return currentMode === requestedMode;
    }
    function canReuseCodexHostForCredentialMode(currentMode, requestedMode) {
        if (requestedMode === 'gateway-key' && currentMode === 'oauth-bearer')
            return true;
        return canReuseHostForCredentialMode(currentMode, requestedMode);
    }
    const { getSessionProvider, setSessionProvider, normalizeSessionProviderId } = (() => {
        const bySession = new Map();
        function normalizeSessionProviderId(providerId) {
            if (providerId === undefined)
                return undefined;
            if (typeof providerId !== 'string')
                return null;
            return providerId.trim() || null;
        }
        function setSessionProvider(sessionId, providerId) {
            bySession.set(sessionId, normalizeSessionProviderId(providerId) ?? null);
        }
        function getSessionProvider(sessionId) {
            return bySession.get(sessionId) ?? null;
        }
        function hydrateSessionProvider(sessionId, providerId) {
            if (!bySession.has(sessionId)) {
                bySession.set(sessionId, normalizeSessionProviderId(providerId) ?? null);
            }
        }
        function clearSessionProvider(sessionId) {
            bySession.delete(sessionId);
        }
        return { getSessionProvider, setSessionProvider, normalizeSessionProviderId };
    })();
    const { getSessionEffort, setSessionEffort, getSessionFastMode, setSessionFastMode } = (() => {
        const bySession = new Map();
        const fastBySession = new Set();
        function setSessionEffort(sessionId, effort) {
            if (effort && effort.trim())
                bySession.set(sessionId, effort.trim());
        }
        function getSessionEffort(sessionId) {
            return bySession.get(sessionId) ?? null;
        }
        function setSessionFastMode(sessionId, enabled) {
            if (enabled)
                fastBySession.add(sessionId);
            else
                fastBySession.delete(sessionId);
        }
        function getSessionFastMode(sessionId) {
            return fastBySession.has(sessionId);
        }
        return { getSessionEffort, setSessionEffort, getSessionFastMode, setSessionFastMode };
    })();
    function credentialFamilyFromAuthInjection(injection) {
        if (injection === 'oauth-bearer')
            return 'oauth-bearer';
        if (injection === 'env-key')
            return 'gateway-key';
        if (injection === 'provider-oauth')
            return 'provider-oauth';
        return undefined;
    }
    class CredentialModeSwitchBusyError extends Error {
        sessionIds;
        constructor(sessionIds, message = `Cannot switch credential mode while local session(s) are busy: ${sessionIds.join(', ')}`) {
            super(message);
            this.name = 'CredentialModeSwitchBusyError';
            this.sessionIds = sessionIds;
        }
    }
    class CodexCredentialModeSwitchBusyError extends CredentialModeSwitchBusyError {
        constructor(sessionIds, modes) {
            // 方向必须进 message:排查"为什么要切"时日志里只有这一条现场证据
            // (2026-07-03 排队假死实报中因缺方向信息多绕了一轮)。fromMode 是原始登记值,
            // 隐式来源会显示成 fallback、掩盖 host 实际钥匙形态 —— 归一化形态可用且与原始
            // 值不同时以它为主、原始值括注(2026-07-04 实排:"fallback -> gateway-key"还得
            // 靠 ps 看进程参数才能确认 host 实际是 OAuth)。
            const fromRaw = modes?.fromMode ?? 'fallback';
            const fromDisplay = modes?.fromModeEffective && modes.fromModeEffective !== modes?.fromMode
                ? `${modes.fromModeEffective}(registered: ${fromRaw})`
                : fromRaw;
            const direction = modes?.fromMode || modes?.fromModeEffective || modes?.toMode
                ? ` (${fromDisplay} -> ${modes?.toMode ?? 'fallback'})`
                : '';
            super(sessionIds, `Cannot switch Codex credential mode${direction} while local Codex session(s) are busy: ${sessionIds.join(', ')}`);
            this.name = 'CodexCredentialModeSwitchBusyError';
        }
    }
    function isCredentialModeSwitchBusyError(err) {
        return err instanceof CredentialModeSwitchBusyError;
    }
    function normalizeProviderId(providerId) {
        const trimmed = providerId?.trim();
        return trimmed || null;
    }
    function isLocalSession(session) {
        return !session.remoteHostId;
    }
    function isLocalCodexSession(session) {
        return session.agentKind === 'codex' && !session.remoteHostId;
    }
    function isLocalSessionBusy(session, isSessionInTurn) {
        return session.isTurnRunning?.() === true || isSessionInTurn?.(session.id) === true;
    }
    const isSessionBusy = isLocalSessionBusy;
    function throwIfCredentialSwitchAborted(signal) {
        if (signal?.aborted) {
            throw new Error('credential mode switch aborted');
        }
    }
    function shouldCloseSessionForCredentialSwitch(input) {
        if (input.remoteHostId)
            return false;
        const currentProviderId = normalizeProviderId(input.currentProviderId);
        const nextProviderId = normalizeProviderId(input.nextProviderId);
        const currentMode = resolveAgentCredentialMode({
            agentKind: input.agentKind,
            providerId: currentProviderId,
            model: input.currentModel,
        });
        const nextMode = resolveAgentCredentialMode({
            agentKind: input.agentKind,
            providerId: nextProviderId,
            model: input.nextModel,
        });
        // ── 远端压缩身份边界(codex, proxy-active)────────────────────────────────
        // oauth spawn 的订阅直连 thread 以 OpenAI 身份 provider 创建(codex 据此走
        // OpenAI 远端压缩),而 provider 身份是 thread 级冻结、settings/update 改不了;
        // 网关 / xAI 等上游不支持远端压缩且失败无本地回退。因此凡切换跨过
        // oauth-bearer(订阅直连)家族边界,必须关会话、由下一次发送按新路由 resume
        // 重建 thread(resume 会按新家族重新决定 provider 身份)。这有意收窄了
        // 方案 A 的「oauth 超集 host 热切 gateway-key / provider-oauth 会话」范围:
        // host 仍复用不重建,只是该会话自身要走关闭重建。隐式来源解析不出家族且
        // 未提供 codexAuthInjection 时按未知处理 → 与另一侧不同即保守关闭。
        if (input.agentKind === 'codex' && input.currentCodexProxyActive === true) {
            const fallbackFamily = credentialFamilyFromAuthInjection(input.codexAuthInjection);
            const effCurrent = currentMode ?? fallbackFamily;
            const effNext = nextMode ?? fallbackFamily;
            const mayTouchRemoteCompaction = effCurrent === 'oauth-bearer' || effNext === 'oauth-bearer' ||
                effCurrent === undefined || effNext === undefined;
            if (effCurrent !== effNext && mayTouchRemoteCompaction)
                return true;
        }
        if (input.agentKind === 'codex' &&
            nextMode === 'provider-oauth' &&
            currentMode !== 'provider-oauth' &&
            input.currentCodexProxyActive !== true) {
            return true;
        }
        if (input.agentKind === 'codex' &&
            nextMode === 'provider-oauth' &&
            input.currentCodexProxyActive === true) {
            return false;
        }
        if (input.agentKind === 'codex' && input.currentCodexProxyActive === true) {
            // 方案 A:proxy-active 的 oauth-bearer host 是订阅超集,可直接承载 gateway-key
            // 会话；反向仍不成立。provider-oauth 的既有热切语义由上方分支保留。
            return !canReuseCodexHostForCredentialMode(currentMode, nextMode);
        }
        return !canReuseHostForCredentialMode(currentMode, nextMode);
    }
    async function prepareLocalSessionCredentialModeSwitch(input) {
        throwIfCredentialSwitchAborted(input.signal);
        const session = input.maker
            .listActiveSessions()
            .find((candidate) => candidate.id === input.sessionId);
        if (!session || !isLocalSession(session))
            return { closedSessionIds: [] };
        if (isSessionBusy(session, input.isSessionInTurn)) {
            throw new CredentialModeSwitchBusyError([session.id]);
        }
        await withRehydrateCloseSuppressed(session.id, async () => {
            throwIfCredentialSwitchAborted(input.signal);
            await input.maker.closeSession(session.id);
        });
        return { closedSessionIds: [session.id] };
    }
    async function prepareLocalCodexCredentialModeSwitch(input) {
        throwIfCredentialSwitchAborted(input.signal);
        const localCodexSessions = input.maker
            .listActiveSessions()
            .filter(isLocalCodexSession);
        const busySessions = localCodexSessions.filter((session) => isSessionBusy(session, input.isSessionInTurn));
        if (busySessions.length > 0) {
            throw new CodexCredentialModeSwitchBusyError(busySessions.map((session) => session.id), {
                fromMode: input.fromMode,
                fromModeEffective: input.fromModeEffective,
                toMode: input.toMode,
            });
        }
        const closedSessionIds = [];
        for (const session of localCodexSessions) {
            throwIfCredentialSwitchAborted(input.signal);
            await withRehydrateCloseSuppressed(session.id, async () => {
                throwIfCredentialSwitchAborted(input.signal);
                await input.maker.closeSession(session.id);
            });
            closedSessionIds.push(session.id);
        }
        return { closedSessionIds };
    }
    async function applyRuntimeSetModelChange(input) {
        const { maker, sessionId, model, providerId, isSessionInTurn, logger } = input;
        const normalizedProviderId = normalizeSessionProviderId(providerId);
        const sess = maker.getSession(sessionId);
        const currentProviderId = getSessionProvider(sessionId);
        // model-only 调用以 pending 的 providerId 为「当前来源意图」:用户先 deferred 选了
        // 新来源、再换模型时,决策与登记都要沿用那个来源,不能回落到 store 里的旧值
        // (否则会把 pending 的来源覆盖丢)。
        const pendingTarget = normalizedProviderId === undefined
            ? input.getPendingCredentialSwitch?.(sessionId)
            : undefined;
        const nextProviderId = normalizedProviderId !== undefined
            ? normalizedProviderId
            : pendingTarget !== undefined
                ? pendingTarget.providerId
                : currentProviderId;
        const shouldCloseSession = sess
            ? shouldCloseSessionForCredentialSwitch({
                agentKind: sess.agentKind,
                remoteHostId: sess.remoteHostId,
                currentProviderId,
                nextProviderId,
                currentModel: sess.model,
                nextModel: model,
                currentCodexProxyActive: sess.codexProxyActive,
                codexAuthInjection: input.codexAuthInjection,
            })
            : false;
        let selfBusyMemo;
        const isSelfBusy = () => {
            if (selfBusyMemo !== undefined)
                return selfBusyMemo;
            const active = maker
                .listActiveSessions()
                .find((candidate) => candidate.id === sessionId);
            selfBusyMemo = active
                ? isLocalSessionBusy(active, isSessionInTurn)
                : isSessionInTurn?.(sessionId) === true;
            return selfBusyMemo;
        };
        if (sess?.agentKind === 'codex' &&
            !sess.remoteHostId &&
            !shouldCloseSession &&
            currentProviderId !== nextProviderId &&
            isSelfBusy()) {
            // 超集 host 可以跨来源复用，不代表 route 可以在 turn 中途热切。Codex 的一个
            // turn 可能包含多次上游请求；立即改 provider store 会让后续工具回合带着旧
            // wire model 命中新来源，造成同 turn 跨计费，甚至因模型不受支持而 4xx。
            // 把 route/model 的生效边界固定在 turn 结束；pending 收口只关闭本 Session，
            // shared host 保留，不重新 spawn app-server。
            if (input.registerPendingCredentialSwitch) {
                await input.registerPendingCredentialSwitch(sessionId, {
                    model,
                    providerId: nextProviderId,
                });
                logger?.info('set-model: Codex provider route switch deferred until turn end', {
                    sessionId,
                    currentProviderId,
                    nextProviderId,
                    fromModel: sess.model,
                    toModel: model,
                });
                return { status: 'deferred' };
            }
            throw new CredentialModeSwitchBusyError([sessionId], `Cannot switch Codex provider route while the session is busy: ${sessionId}`);
        }
        if (sess && shouldCloseSession) {
            if (isSelfBusy() && input.registerPendingCredentialSwitch) {
                await input.registerPendingCredentialSwitch(sessionId, {
                    model,
                    providerId: nextProviderId,
                });
                logger?.info('set-model: credential switch deferred until turn end', {
                    sessionId,
                    agentKind: sess.agentKind,
                    currentProviderId,
                    nextProviderId,
                    fromModel: sess.model,
                    toModel: model,
                });
                return { status: 'deferred' };
            }
            // 关会话前先清可能存在的 stale pending(后选覆盖先选):close 会触发宿主的
            // onSessionClosed 钩子,pending 若还在会被它以**旧目标**抢先 finalize 并广播,
            // 与本次显式选择打架(review P1 2026-07-04 第三轮);先清让两条 apply 路径读到
            // undefined 提前返回,本分支随后同步写入新 route。wake:false —— 此刻唤醒会让
            // drain 趁下面 await close 的窗口把队首派发到旧会话/旧凭证上,唤醒挪到收尾。
            // 记下清除前的值:后续失败(非 busy)时恢复,不让用户的待定选择随异常丢失
            // (Greptile review #1035)。
            const clearedPending = input.getPendingCredentialSwitch?.(sessionId);
            input.clearPendingCredentialSwitch?.(sessionId, { wake: false });
            try {
                await prepareLocalSessionCredentialModeSwitch({
                    maker,
                    sessionId,
                    isSessionInTurn,
                });
            }
            catch (err) {
                // 空闲判定与 close 之间的竞态(恰好起了新 turn):有 pending 通道就转延迟,
                // 没有(老调用方)保持抛 busy 的旧语义。
                if (isCredentialModeSwitchBusyError(err) && input.registerPendingCredentialSwitch) {
                    input.registerPendingCredentialSwitch(sessionId, {
                        model,
                        providerId: nextProviderId,
                    });
                    logger?.info('set-model: credential switch deferred after busy race', {
                        sessionId,
                        agentKind: sess.agentKind,
                    });
                    return { status: 'deferred' };
                }
                // 非 busy 失败:恢复被清除的 pending,用户的待定来源选择不随异常丢失。
                if (clearedPending && input.registerPendingCredentialSwitch) {
                    input.registerPendingCredentialSwitch(sessionId, clearedPending);
                }
                throw err;
            }
            if (providerId !== undefined)
                setSessionProvider(sessionId, nextProviderId);
            // close + route 都落定后再唤醒队列:排队消息按新凭证形态 lazy-create 派发。
            input.wakeSessionInputQueue?.(sessionId);
            logger?.info('set-model: closed live session after credential mode switch', {
                sessionId,
                agentKind: sess.agentKind,
                currentProviderId,
                nextProviderId,
                fromModel: sess.model,
                toModel: model,
            });
            return { status: 'applied' };
        }
        if (providerId !== undefined) {
            setSessionProvider(sessionId, nextProviderId);
            // 显式选源且无需切换 → 取消尚未兑现的 pending(后选覆盖先选)。
            input.clearPendingCredentialSwitch?.(sessionId);
        }
        else if (pendingTarget !== undefined) {
            // model-only 变更 + 已有 pending:能走到无需切换分支,说明按 pending 来源 +
            // 新模型评估后凭证形态已与当前进程同族(典型:折扣模型 pending 后切回普通
            // 模型)→ 切换意图不复存在,取消 pending(review P1)。
            input.clearPendingCredentialSwitch?.(sessionId);
            logger?.info('set-model: cancelled stale pending credential switch after model-only change', {
                sessionId,
                pendingProviderId: pendingTarget.providerId,
                toModel: model,
            });
        }
        if (!sess) {
            logger?.debug('set-model: session not found, no-op', { sessionId });
            return { status: 'applied' };
        }
        try {
            await sess.setModel(model, { providerId: nextProviderId });
        }
        catch (err) {
            if (providerId !== undefined) {
                setSessionProvider(sessionId, currentProviderId);
            }
            // 热切失败:仅 model-only 分支(pendingTarget)恢复 pending —— 显式选源
            // (providerId !== undefined)时旧 pending 已被本次明确选择覆盖,恢复它会静默
            // 撤销用户最后一次选择(Greptile review #1035 七轮)。
            if (pendingTarget && input.registerPendingCredentialSwitch) {
                input.registerPendingCredentialSwitch(sessionId, pendingTarget);
            }
            throw err;
        }
        return { status: 'applied' };
    }
    async function applySetModelThenCancelAgentSwitchIntent(pendingSwitches, sessionId, applySetModel, broadcastCanceled) {
        const result = await applySetModel();
        pendingSwitches.clear(sessionId);
        broadcastCanceled(sessionId);
        return result;
    }
    function projectPendingAgentSwitchIntent(intent) {
        if (!intent)
            return null;
        return {
            targetAgentKind: intent.targetAgentKind,
            model: intent.model,
            providerId: intent.providerId ?? null,
            ...(intent.effort ? { effort: intent.effort } : {}),
            ...(typeof intent.fastMode === 'boolean' ? { fastMode: intent.fastMode } : {}),
        };
    }
    function throwIfAgentSwitchAborted(signal) {
        if (signal?.aborted) {
            throw new Error('agent switch aborted');
        }
    }
    function createPendingAgentSwitchRegistry() {
        const pending = new Map();
        const revisions = new Map();
        const bump = (sessionId) => {
            const next = (revisions.get(sessionId) ?? 0) + 1;
            revisions.set(sessionId, next);
            return next;
        };
        return {
            set: (sessionId, intent) => {
                pending.set(sessionId, intent);
                bump(sessionId);
            },
            get: (sessionId) => pending.get(sessionId),
            clear: (sessionId) => {
                pending.delete(sessionId);
                bump(sessionId);
            },
            revision: (sessionId) => revisions.get(sessionId) ?? 0,
            clearIfRevision: (sessionId, expectedRevision) => {
                if ((revisions.get(sessionId) ?? 0) !== expectedRevision)
                    return null;
                pending.delete(sessionId);
                return bump(sessionId);
            },
        };
    }
    async function performSessionAgentSwitch(deps, params) {
        const { sessionId, targetAgentKind, model, providerId, signal } = params;
        throwIfAgentSwitchAborted(signal);
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throwIpcError('INVALID_PARAMS', 'sessionId required');
        }
        if (targetAgentKind !== 'claude-code' && targetAgentKind !== 'codex' && targetAgentKind !== 'pi') {
            throwIpcError('INVALID_PARAMS', 'targetAgentKind must be claude-code | codex | pi');
        }
        if (typeof model !== 'string' || model.length === 0) {
            throwIpcError('INVALID_PARAMS', 'model required');
        }
        if (providerId !== undefined && providerId !== null && typeof providerId !== 'string') {
            throwIpcError('INVALID_PARAMS', 'providerId must be string | null');
        }
        // 必须在第一个 await 前快照：跨窗口 / 跨设备写入即使 set→clear 回到同值，修订号也会变化。
        const pendingRevisionAtStart = deps.pendingSwitches?.revision?.(sessionId);
        let normalizedProviderId = typeof providerId === 'string' ? providerId.trim() || null : providerId;
        // 停用轴准入(PR #744 review):意图登记与 applyNow 提交都要过裁决(applyNow 重入
        // 本函数时按最新目录再判一次)。目标路由被停用 → 抛错;隐式默认落点被停用而有
        // 启用替代拷贝 → 直接以显式来源落地(后续意图/提交/内存路由全部用改后的值)。
        if (deps.assertModelRouteUsable) {
            const reroute = await deps.assertModelRouteUsable(targetAgentKind, model, typeof normalizedProviderId === 'string' ? normalizedProviderId : null);
            if (reroute && typeof normalizedProviderId !== 'string')
                normalizedProviderId = reroute;
        }
        const row = await deps.getSessionRow(sessionId);
        throwIfAgentSwitchAborted(signal);
        if (!row || row.status === 'deleted') {
            throwIpcError('NOT_FOUND', `Session ${sessionId} not found`);
        }
        if (row.remoteHostId) {
            // SSH 远程会话:agent 进程在远端机器,cc-manager 链路仅覆盖 Claude,v1 不支持切换。
            throwIpcError('UNSUPPORTED_CAPABILITY', 'agent switch is not supported for remote sessions');
        }
        if (row.orcaRole) {
            // Orca lead/worker:协同运行时对 agent 形态有独立契约(docs/dev-rules/orca-team-architecture.md),不掺和。
            throwIpcError('UNSUPPORTED_CAPABILITY', 'agent switch is not supported for Orca sessions');
        }
        const fromDbKind = normalizeDbAgentKind(row.agentKind);
        const toDbKind = makerToDbAgentKind(targetAgentKind);
        if (fromDbKind === toDbKind) {
            // 同引擎 = 纯模型切换,调用方应走 SET_MODEL;这里按 no-op 成功返回。
            // 顺带清 pending:用户先登记了跨引擎切换、又选回当前引擎 = 改主意取消。
            let sameEngineRevision;
            if (deps.pendingSwitches?.clearIfRevision && pendingRevisionAtStart !== undefined) {
                const clearedRevision = deps.pendingSwitches.clearIfRevision(sessionId, pendingRevisionAtStart);
                if (clearedRevision === null) {
                    return {
                        switched: false,
                        agentKind: targetAgentKind,
                        model,
                        engineReady: true,
                        sameEngineSuperseded: true,
                    };
                }
                sameEngineRevision = clearedRevision;
            }
            else {
                // 最小测试 harness / 旧内嵌调用方没有修订能力时维持原 no-op 清除语义。
                deps.pendingSwitches?.clear(sessionId);
            }
            deps.onPendingSwitchChanged?.(sessionId, null);
            return {
                switched: false,
                agentKind: targetAgentKind,
                model,
                engineReady: true,
                ...(sameEngineRevision !== undefined ? { sameEngineRevision } : {}),
            };
        }
        // 跨引擎选择比此前登记的凭证切换更新；即使旧切换已在 await close，清掉登记后
        // 它也会在收口前重读并放弃，避免 DB 已是新 agent、内存 route 却被旧 provider 覆盖。
        deps.supersedePendingCredentialSwitch?.(sessionId);
        // 意图制:外部调用(非 applyNow)一律只登记意图——空闲/运行中同一语义,
        // 用户反复改选零成本;renderer 乐观显示意图,真切换在下一条消息发送时刻执行。
        // 重复登记 = 覆盖(同一意图的最新表达)。
        if (!params.applyNow && deps.pendingSwitches) {
            const intent = {
                targetAgentKind,
                model,
                providerId: normalizedProviderId,
                ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
                ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
            };
            deps.pendingSwitches.set(sessionId, intent);
            deps.onPendingSwitchChanged?.(sessionId, projectPendingAgentSwitchIntent(intent));
            deps.log.info('agent-switch: intent registered (applies on next send)', {
                sessionId,
                targetAgentKind,
                model,
            });
            return { switched: false, agentKind: targetAgentKind, model, engineReady: true, deferred: true };
        }
        const live = deps.getLiveSession(sessionId);
        if (live?.isTurnRunning()) {
            // applyNow 只应在空闲时被调用(applyPendingAgentSwitchIfIdle 已前置检查);
            // 竞态兜底:仍在跑就拒绝,绝不打断进行中的 turn。
            throwIpcError('SESSION_RUNNING', `Session ${sessionId} is running a turn`);
        }
        // 交接注册表代次:必须在读历史**之前**取。下面到 setPendingHandoff 之间全是异步活,
        // 期间用户可能 /clear——带上它,过期的写入会被 registry 丢弃而不是盖掉墓碑。
        const handoffGeneration = deps.readPendingHandoffGeneration?.(sessionId);
        // 交接素材与停泊绑定先于任何状态变更取得(失败不留半切换状态)。
        // Phase 2:目标引擎有停泊原生会话 → resume + 增量交接(只补离开期间的进展,
        // 工作状态区仍按全量历史提取);无绑定 → v1 全量交接 + 全新原生会话。
        const parked = deps.findParkedEngineSession
            ? await deps.findParkedEngineSession(sessionId, toDbKind)
            : null;
        const fullSourceMessages = await deps.listMessagesForHandoff(sessionId);
        throwIfAgentSwitchAborted(signal);
        const handoffOptsBase = {
            fromLabel: agentEngineLabel(fromDbKind),
            toLabel: agentEngineLabel(toDbKind),
            // 附带早期原文检索指引(get_chat_history / search_chat_history 定向到本会话)。
            sessionId,
        };
        const buildFullHandoff = () => buildHandoffText(fullSourceMessages, handoffOptsBase);
        let handoff;
        if (parked) {
            const deltaMessages = await deps.listMessagesForHandoff(sessionId, {
                createdAt: parked.watermarkCreatedAt,
                rowid: parked.watermarkRowid,
            });
            handoff = buildHandoffText(deltaMessages, {
                ...handoffOptsBase,
                mode: 'delta',
                workStateMessages: fullSourceMessages,
            });
        }
        else {
            handoff = buildFullHandoff();
        }
        return deps.withCloseSuppressed(sessionId, async () => {
            throwIfAgentSwitchAborted(signal);
            if (live) {
                await deps.closeSession(sessionId);
            }
            // 停用轴:提交点重裁决(PR #744 review 第十五轮)—— parked 数据加载、handoff
            // 构建、closeSession 都是长 await,入口裁决可能已过期。此刻拒绝仍安全:DB 未写,
            // 旧会话即使已关也只是下一次发送按旧路由懒重建,不产生新的停用路由请求。
            if (deps.assertModelRouteUsable) {
                const rerouteAtCommit = await deps.assertModelRouteUsable(targetAgentKind, model, typeof normalizedProviderId === 'string' ? normalizedProviderId : null);
                if (rerouteAtCommit && typeof normalizedProviderId !== 'string') {
                    normalizedProviderId = rerouteAtCommit;
                }
            }
            // ---- commit point:此后切换生效 ----
            await deps.applyAgentSwitchToDb(sessionId, {
                agentKind: toDbKind,
                model,
                providerId: normalizedProviderId,
                sdkSessionId: parked?.sdkSessionId ?? null,
                ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
                ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
            });
            if (normalizedProviderId !== undefined) {
                deps.setSessionProvider(sessionId, normalizedProviderId);
            }
            const boundaryContent = {
                fromAgentKind: fromDbKind,
                toAgentKind: toDbKind,
                fromModel: row.model,
                toModel: model,
                fromSdkSessionId: row.sdkSessionId,
                handoff,
                resumed: !!parked,
                consumed: false,
            };
            let boundaryClientId = null;
            try {
                boundaryClientId = await deps.insertBoundaryMessage(sessionId, boundaryContent);
            }
            catch (err) {
                // 降级:分隔条缺失是外观问题;注入语义由下面的内存 pending 保住(本进程内)。
                deps.log.warn('agent-switch: boundary message insert failed (degraded)', {
                    sessionId,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
            deps.setPendingHandoff(sessionId, handoff, handoffGeneration);
            let engineReady = true;
            let resumed = !!parked;
            let retryPending = false;
            // resume 模式无视 skipBootstrap:只有 eager spawn 才能确定性观测 resume 失败
            // 并在同一事务内回落全量交接;交给 lazy-create 的话,失效的停泊 id 会让之后
            // 每次发送反复失败且无人回落。
            if (parked || !params.skipBootstrap) {
                try {
                    await deps.bootstrapSwitchedSession(sessionId);
                }
                catch (err) {
                    if (parked) {
                        // ---- resume 回落:清停泊 id → 换全量交接 → 全新原生会话重试 ----
                        // 停泊原生会话可能已失效(transcript 被清理、CLI 升级不兼容等),这些
                        // 只有 spawn 时才暴露。回落是确定性代码路径,不留半 resume 状态。
                        deps.log.warn('agent-switch: resume parked session failed; fallback to fresh + full handoff', {
                            sessionId,
                            targetAgentKind,
                            parkedSdkSessionId: parked.sdkSessionId,
                            err: err instanceof Error ? err.message : String(err),
                        });
                        resumed = false;
                        const fullHandoff = buildFullHandoff();
                        const fallbackBoundaryContent = {
                            ...boundaryContent,
                            handoff: fullHandoff,
                            resumed: false,
                        };
                        let fallbackCommitted = false;
                        if (boundaryClientId) {
                            try {
                                await deps.applyResumeFallbackAtomically(sessionId, boundaryClientId, fallbackBoundaryContent);
                                fallbackCommitted = true;
                            }
                            catch (err2) {
                                // 清 id 与改边界必须同成同败。失败后重新登记完整意图与恢复载荷,
                                // 下一条消息先重试原子恢复尾段,而不是带半状态继续 lazy-create。
                                deps.pendingSwitches?.set(sessionId, {
                                    targetAgentKind,
                                    model,
                                    providerId: normalizedProviderId,
                                    ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
                                    ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
                                    resumeFallbackRecovery: {
                                        boundaryClientId,
                                        boundaryContent: fallbackBoundaryContent,
                                        handoff: fullHandoff,
                                        handoffClearEpoch: handoffGeneration,
                                    },
                                });
                                engineReady = false;
                                retryPending = true;
                                deps.log.warn('agent-switch: atomic resume fallback failed; intent retained for retry', {
                                    sessionId,
                                    err: err2 instanceof Error ? err2.message : String(err2),
                                });
                            }
                        }
                        else {
                            // 边界插入失败时无法原子保证“清 id + 改边界”。保留意图自愈,
                            // 避免只清 sdk id 后 DB pending 与实际注入内容分叉。
                            deps.pendingSwitches?.set(sessionId, {
                                targetAgentKind,
                                model,
                                providerId: normalizedProviderId,
                                ...(typeof params.effort === 'string' && params.effort ? { effort: params.effort } : {}),
                                ...(typeof params.fastMode === 'boolean' ? { fastMode: params.fastMode } : {}),
                                resumeFallbackRecovery: {
                                    boundaryClientId: null,
                                    boundaryContent: fallbackBoundaryContent,
                                    handoff: fullHandoff,
                                    handoffClearEpoch: handoffGeneration,
                                },
                            });
                            engineReady = false;
                            retryPending = true;
                            deps.log.warn('agent-switch: resume fallback has no boundary row; intent retained for retry', {
                                sessionId,
                            });
                        }
                        // 仍用最初那个纪元,**不要**在这里重读:纪元只由 /clear 推进,所以覆盖自己
                        // 先前写的增量交接本来就不会被挡;而重读会在"期间发生过 /clear、首次写入
                        // 已被正确拒绝"时拿到 clear 之后的新纪元,让这份基于清空前历史构造的全量
                        // 交接反而绕过墓碑写进去。
                        deps.setPendingHandoff(sessionId, fullHandoff, handoffGeneration);
                        if (fallbackCommitted) {
                            try {
                                await deps.bootstrapSwitchedSession(sessionId);
                            }
                            catch (err2) {
                                engineReady = false;
                                deps.log.warn('agent-switch: fresh bootstrap after resume fallback failed', {
                                    sessionId,
                                    targetAgentKind,
                                    err: err2 instanceof Error ? err2.message : String(err2),
                                });
                            }
                        }
                    }
                    else {
                        engineReady = false;
                        deps.log.warn('agent-switch: bootstrap new engine failed; next send will lazy-create', {
                            sessionId,
                            targetAgentKind,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }
            deps.log.info('agent-switch: switched', {
                sessionId,
                from: fromDbKind,
                to: toDbKind,
                model,
                engineReady,
                resumed,
                handoffChars: handoff.length,
            });
            return {
                switched: true,
                agentKind: targetAgentKind,
                model,
                engineReady,
                ...(retryPending ? { retryPending: true } : {}),
            };
        });
    }
    function registerMakerSessionAgentSwitchHandler(registry, deps) {
        registry.handle(MAKER_INVOKE.SWITCH_SESSION_AGENT, async (_e, sessionId, targetAgentKind, model, providerId, effort, fastMode) => {
            const run = () => performSessionAgentSwitch(deps, {
                sessionId,
                targetAgentKind,
                model,
                providerId,
                effort,
                fastMode,
            });
            return typeof sessionId === 'string' && sessionId && deps.withSessionLock
                ? deps.withSessionLock(sessionId, run)
                : run();
        });
        registry.handle(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, (_e, sessionId) => {
            if (typeof sessionId !== 'string' || sessionId.length === 0) {
                throwIpcError('INVALID_PARAMS', 'sessionId required');
            }
            return projectPendingAgentSwitchIntent(deps.pendingSwitches?.get(sessionId));
        });
    }
    const normalizeDbAgentKind = kind => kind === 'codex' ? 'codex' : 'cc';
    const makerToDbAgentKind = normalizeDbAgentKind;
    const dbToMakerAgentKind = kind => kind === 'cc' ? 'claude-code' : kind;
    const agentSwitchPending = createPendingAgentSwitchRegistry();
    registerMakerSessionAgentSwitchHandler(ipcMain, {
        assertModelRouteUsable, getSessionRow: async () => ({ agentKind: 'codex', status: 'active', ...read() }),
        pendingSwitches: agentSwitchPending,
        onPendingSwitchChanged: (id, intent) => broadcastSessionPatched(id, { agentSwitchIntent: intent }),
        withSessionLock: withSendToSessionLock,
    });
    const settingsPersistedInsideHandler = new WeakSet();
    function markRemoteSettingPersistedInsideHandler(result) {
        settingsPersistedInsideHandler.add(result);
    }
    const isDeviceLinkInvoke = () => true;
    let settingsPersist = null;
    function setRemoteSettingsPersist(fn) {
        settingsPersist = fn;
    }
    const SET_CHANNEL_FIELD = {
        'maker:set-model': 'model',
        'maker:set-effort': 'effort',
        'maker:set-permission-mode': 'permissionMode',
        'maker:set-fast-mode': 'fastMode',
        'maker:set-plan-mode': 'planModeEnabled',
        'maker:set-extra-dirs': 'extraDirs',
    };
    async function persistRemoteSetting(channel, args, result) {
        const field = SET_CHANNEL_FIELD[channel];
        if (!field || !settingsPersist)
            return;
        if (result !== null &&
            typeof result === 'object' &&
            settingsPersistedInsideHandler.has(result)) {
            return;
        }
        const sessionId = args[0];
        if (typeof sessionId !== 'string')
            return;
        // extraDirs 特例:set-extra-dirs handler 会按被控端 workingDir 校验、只应用 validation.valid,
        // 请求值 != 生效值(控制端选的路径在被控端常被拒或不存在)。必须持久化 handler 实际应用的子集
        // (其返回值),否则被控端 DB 会写进会话从未接受的目录,未来 resume 加载到不可用 extraDirs。
        // handler no-op(session 不在 / capability 不支持)时返回 undefined → 不持久化。
        if (channel === 'maker:set-extra-dirs') {
            if (!Array.isArray(result))
                return;
            await settingsPersist(sessionId, { extraDirs: result });
            return;
        }
        // set-model 特例:可携带第 3 参 providerId(per-session 来源选择,见 register.ts SET_MODEL handler)。
        // 必须把它一并持久化进被控端 DB.provider_id,否则远程切来源只进了 runtime store、跨重启/resume 丢
        // (G2)。与被控端 handler 同语义:args[2]===undefined(老 2 参调用)不动 provider_id;string→写;
        // null/''→清除(回落默认路由)。写进 DB 后 mapper 自动带进 sessions:patched → 回流控制端镜像。
        if (channel === 'maker:set-model') {
            // 同引擎重选的第二段带 host revision CAS。handler 返回 superseded 表示
            // 另一控制端已在两段之间更新过意图：runtime 未应用，DB 也必须同样不落
            // 这次请求参数，否则 sessions:patched 会把过期选择反向盖回控制端。
            if (result !== null &&
                typeof result === 'object' &&
                !Array.isArray(result) &&
                result.superseded === true) {
                return;
            }
            const patch = { model: args[1] };
            if (args.length > 2) {
                patch.providerId = normalizeSessionProviderId(typeof args[2] === 'string' ? args[2] : null);
            }
            await settingsPersist(sessionId, patch);
            return;
        }
        // 其余 set-*(effort/permissionMode/fastMode)原样存储(不 clamp/转换),请求值 == 生效值,
        // 直接持久化请求值,避免给热路径加一次回读。被控端 DB 始终是单一真相源。
        await settingsPersist(sessionId, { [field]: args[1] });
    }
    ipcMain.handle(MAKER_INVOKE.GET_CAPABILITIES, (_e, agentKind) => {
        return {
            ...maker.getCapabilities(requireAgentKind(agentKind)),
            // host 级 optional 能力；旧 desktop 缺省为 false。两个 agent 查询都带回，
            // 手机读取当前 agent 快照即可决定是否展示切换入口。
            supportsSessionAgentSwitch: true,
            // v2 因果能力：同引擎 no-op 返回 revision，后续 SET_MODEL 在 session 锁内 CAS。
            // 新 desktop 控制端据此与只有基础切换能力的旧 host 做安全兼容门控。
            supportsSessionAgentSwitchCas: true,
        };
    });
    ipcMain.handle(MAKER_INVOKE.SET_MODEL, async (_e, sessionId, model, providerId, expectedAgentSwitchRevision, selection) => {
        if (typeof sessionId !== 'string' || typeof model !== 'string') {
            throwIpcError('INVALID_PARAMS', 'sessionId + model required');
        }
        if (providerId !== undefined &&
            providerId !== null &&
            typeof providerId !== 'string') {
            throwIpcError('INVALID_PARAMS', 'providerId must be string, null, or undefined');
        }
        if (expectedAgentSwitchRevision !== undefined &&
            (typeof expectedAgentSwitchRevision !== 'number' ||
                !Number.isSafeInteger(expectedAgentSwitchRevision) ||
                expectedAgentSwitchRevision < 0)) {
            throwIpcError('INVALID_PARAMS', 'expectedAgentSwitchRevision must be a non-negative integer');
        }
        if (selection !== undefined &&
            (selection === null ||
                typeof selection !== 'object' ||
                Array.isArray(selection) ||
                typeof selection.effort !== 'string' ||
                typeof selection.fastMode !== 'boolean')) {
            throwIpcError('INVALID_PARAMS', 'selection must contain effort + fastMode');
        }
        const atomicSelection = selection;
        // 与 send 事务共用 session 锁:发送时刻执行的跨引擎切换必须先落定,
        // 后到的 SET_MODEL 才能写 route。否则切换 DB await 恢复后会用旧 provider
        // 覆盖用户刚选的新 route，形成 DB 与进程内路由分叉。
        return withSendToSessionLock(sessionId, async () => {
            // 同引擎重选是 switch ack 后的第二段写入。另一控制端若在两段之间更新（含
            // set→clear ABA），修订号已变化：旧 SET_MODEL 必须在任何 route/DB 副作用前让位。
            if (typeof expectedAgentSwitchRevision === 'number' &&
                agentSwitchPending.revision?.(sessionId) !== expectedAgentSwitchRevision) {
                return { deferred: false, superseded: true };
            }
            // 停用轴准入(PR #744 review;第十二轮移入锁内):切换模型是一次新的路由选择,
            // 不得切到用户停用的模型 / 来源(本机选择器已过滤,但本 channel 在 device-link
            // allowlist 内,老控制端可直接点名)。裁决必须在拿到会话锁**之后**执行 ——
            // 排队等待期间目标可能刚被停用,而同凭证族的变更即时生效、不经 deferred 收口
            // 的重裁决,锁前裁决结果可能已过期。会话当前正用着的停用模型不受影响,这里只
            // 拦「切过去」;隐式来源的原生默认落点被停用而有启用替代拷贝时,以显式来源
            // 落地(与 bootstrapSession 同语义)。agentKind 读不到(会话行缺失等)时不拦。
            // DB 存的是 'cc' | 'codex'(messages.agent_kind 口径),目录侧是 AgentKind。
            let effectiveProviderId = providerId;
            {
                const dbAgentKind = getSessionDbAgentKind(sessionId);
                if (dbAgentKind) {
                    const reroute = await assertModelRouteUsable(dbToMakerAgentKind(dbAgentKind), model, typeof providerId === 'string' ? providerId : null);
                    if (reroute && typeof providerId !== 'string')
                        effectiveProviderId = reroute;
                }
            }
            try {
                const result = await applySetModelThenCancelAgentSwitchIntent(agentSwitchPending, sessionId, () => applyRuntimeSetModelChange({
                    maker,
                    sessionId,
                    model,
                    providerId: effectiveProviderId,
                    isSessionInTurn,
                    registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
                    clearPendingCredentialSwitch: clearPendingCredentialSwitchForSession,
                    wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch,
                    getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
                    // 解析隐式来源的凭证家族,精确判定是否跨远端压缩身份边界(见
                    // shouldCloseSessionForCredentialSwitch.codexAuthInjection)。
                    codexAuthInjection: getCodexProxyAuthInjectionState(),
                    logger: log,
                }), (id) => broadcastSessionPatched(id, {
                    agentSwitchIntent: null,
                    agentSwitchIntentCanceled: true,
                }));
                // deferred = 会话自己在跑,选择已登记、turn 结束自动生效。renderer 据此提示
                // "任务结束后生效"而不是当成已即时切换。
                const response = { deferred: result.status === 'deferred', superseded: false };
                if (atomicSelection) {
                    // model/provider/effort/fast 是一次选择快照，必须在同一把 session 锁内收敛。
                    // applyRuntimeSetModelChange 可能 close + wake；若 effort/fast 留给 renderer
                    // 后续独立调用，queue drain 会用新 model + 旧偏好重建，跨控制端时还会发生
                    // 旧请求尾写覆盖新选择。
                    setSessionEffort(sessionId, atomicSelection.effort);
                    setSessionFastMode(sessionId, atomicSelection.fastMode);
                    const sess = maker.getSession(sessionId);
                    if (sess &&
                        result.status !== 'deferred' &&
                        !pendingCredentialSwitchHolder?.has(sessionId)) {
                        await sess.setEffort(atomicSelection.effort);
                        if (sess.agentKind === 'codex') {
                            await sess.setFastMode(atomicSelection.fastMode);
                        }
                    }
                }
                if (isDeviceLinkInvoke() || atomicSelection) {
                    // device-link 的通用持久化原本发生在 handler 返回、session 锁释放之后；
                    // 本地 renderer 的 sessionService.update 也有同一窗口。凡携带 selection 的
                    // 新调用都由 host 在解锁前一次落定全部字段。
                    const patch = { model };
                    if (effectiveProviderId !== undefined) {
                        patch.providerId = normalizeSessionProviderId(typeof effectiveProviderId === 'string' ? effectiveProviderId : null);
                    }
                    if (atomicSelection) {
                        patch.effort = atomicSelection.effort;
                        patch.fastMode = atomicSelection.fastMode;
                    }
                    await persistSessionFields(sessionId, patch);
                    if (isDeviceLinkInvoke()) {
                        // dispatch 继续兼容最小/旧 handler 的锁外回流；标记本结果避免重复写。
                        markRemoteSettingPersistedInsideHandler(response);
                    }
                }
                return response;
            }
            catch (err) {
                if (err instanceof CredentialModeSwitchBusyError) {
                    // 兜底(正常路径 busy 已转 deferred):切模型撞上凭证切换忙,独立 code,
                    // renderer toast 走 ipcError.CREDENTIAL_SWITCH_BUSY 专属文案。
                    throwIpcError('CREDENTIAL_SWITCH_BUSY', err.message);
                }
                throw err;
            }
        });
    });
    ipcMain.handle(MAKER_INVOKE.SET_EFFORT, async (_e, sessionId, effort) => {
        if (typeof sessionId !== 'string' || typeof effort !== 'string') {
            throwIpcError('INVALID_PARAMS', 'sessionId + effort required');
        }
        // 记下会话 effort:responses-bridge 模型(chatgpt/ / xai/)的 effort 无法经请求体流到 bridge,
        // 由 compat-proxy 路由决策从这里读出、闭包进订阅直连 handler 的 prefs(不影响 session 是否在跑)。
        setSessionEffort(sessionId, effort);
        const sess = maker.getSession(sessionId);
        if (!sess) {
            log.debug('set-effort: session not found, no-op', { sessionId });
            return;
        }
        // 有 pending 凭证切换 = 本会话的 model/effort 变更已整体延迟到 turn 结束重建:
        // 跳过对仍在跑的旧 turn 的 runtime 推送(与 renderer 本地分支的 deferred 守卫同因,
        // 这里是唯一 choke point,同时覆盖 device-link 远程入口;review P2 2026-07-04)。
        // 持久化不受影响:本地由 renderer sessionService.update 落盘,远程由 device-link
        // dispatch 的 persistRemoteSetting 按请求值落被控端 DB,重建时生效。
        if (pendingCredentialSwitchHolder?.has(sessionId)) {
            log.debug('set-effort: skipped live push (pending credential switch)', { sessionId });
            return;
        }
        await sess.setEffort(effort);
    });
    ipcMain.handle(MAKER_INVOKE.SET_FAST_MODE, async (_e, sessionId, enabled) => {
        if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
            throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
        }
        // 记下会话 Fast 态:responses-bridge 模型(chatgpt/ 前缀)的 fast 无法经请求体流到 bridge,
        // 由 compat-proxy 路由决策从这里读出、闭包进订阅直连 handler 的 prefs(与 SET_EFFORT 的 effort 同机制)。
        setSessionFastMode(sessionId, enabled);
        const sess = maker.getSession(sessionId);
        if (!sess) {
            log.debug('set-fast-mode: session not found, no-op', { sessionId });
            return;
        }
        if (sess.agentKind === 'pi') {
            // Pi 的 ChatGPT 请求不从 pi 请求体携带 Fast，而是由上面的 session store
            // 在 compat-proxy 决策点闭包进 responses bridge prefs。到这里已经即时生效，
            // 无需向 pi RPC 再发一份不存在的 set_fast_mode 控制命令。
            log.debug('set-fast-mode: pi responses bridge state updated', { sessionId, enabled });
            return;
        }
        if (sess.agentKind !== 'codex') {
            log.debug('set-fast-mode: agent does not implement fast mode, no-op', {
                sessionId,
                agentKind: sess.agentKind,
            });
            return;
        }
        // 同 set-effort:pending 凭证切换期间不触碰仍在跑的旧 turn,持久化走各自 DB 路径。
        if (pendingCredentialSwitchHolder?.has(sessionId)) {
            log.debug('set-fast-mode: skipped live push (pending credential switch)', { sessionId });
            return;
        }
        await sess.setFastMode(enabled);
    });
    setSessionProvider(id, providerId);
    setSessionEffort(id, effort);
    setSessionFastMode(id, fastMode);
    setRemoteSettingsPersist(async (taskId, patch) => {
        assert.equal(taskId, id);
        const next = { ...read(), ...patch };
        db.prepare('UPDATE task SET model = ?, providerId = ?, effort = ?, fastMode = ? WHERE id = ?')
            .run(next.model, next.providerId, next.effort, Number(next.fastMode), taskId);
        writes.push(patch);
    });
    const persistSessionFields = (...args) => settingsPersist(...args);
    return {
        capabilities: agent => channels.get('maker:get-capabilities')(undefined, agent),
        async invoke(channel, args) {
            const handle = channels.get(channel);
            if (!handle)
                return channel === 'maker:get-session-agent-switch-intent' ? null : undefined;
            const result = await handle(undefined, ...args);
            // Same success sequence as the archived dispatch (persist before invoke result).
            await persistRemoteSetting(channel, args, result);
            return result;
        },
        evidence: () => ({
            row: read(), writes, routePending: candidate.get(id), intentPushes,
            live: { model: live.model, providerId: getSessionProvider(id) },
            prefs: { effort: getSessionEffort(id), fastMode: getSessionFastMode(id) },
        }),
        close: () => db.close(),
    };
}
module.exports = { createLegacyReceiver };
