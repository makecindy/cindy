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
    const agentSwitchPending = new Map();
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
        };
    });
    ipcMain.handle(MAKER_INVOKE.SET_MODEL, async (_e, sessionId, model, providerId) => {
        if (typeof sessionId !== 'string' || typeof model !== 'string') {
            throwIpcError('INVALID_PARAMS', 'sessionId + model required');
        }
        if (providerId !== undefined &&
            providerId !== null &&
            typeof providerId !== 'string') {
            throwIpcError('INVALID_PARAMS', 'providerId must be string, null, or undefined');
        }
        // 与 send 事务共用 session 锁:发送时刻执行的跨引擎切换必须先落定,
        // 后到的 SET_MODEL 才能写 route。否则切换 DB await 恢复后会用旧 provider
        // 覆盖用户刚选的新 route，形成 DB 与进程内路由分叉。
        return withSendToSessionLock(sessionId, async () => {
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
                    const reroute = await assertModelRouteUsable(dbAgentKind === 'cc' ? 'claude-code' : 'codex', model, typeof providerId === 'string' ? providerId : null);
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
                return { deferred: result.status === 'deferred' };
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
