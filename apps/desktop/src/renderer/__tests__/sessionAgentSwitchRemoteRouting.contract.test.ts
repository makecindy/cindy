// Guard tier (engineering-conventions section 3.2): cross-file capability,
// CAS/ack, owner-race, and model-selection interaction contracts cannot be
// isolated by importing the full composer tree. Behavioral transport, store,
// coordinator, and extracted callback tests stay in the unit tier.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';


describe('ChatInput 的入口门控与调用路由', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/components/new-chat/ChatInput.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const storeSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/lib/makerChatStore.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('切换 IPC 走传输层(远程会话隧道到被控端),不再硬打本机 maker', () => {
    expect(source).toContain('switchApi.switchSessionAgent(');
    expect(source).toContain(': makerApiFor(sourceSessionId);');
    expect(source).not.toContain('window.electronAPI.maker.switchSessionAgent(');
  });

  it('入口按被控端能力位门控:device-link 不再被排除,SSH 远程仍排除', () => {
    // 2026-08-12 统一模型选择器(M6):会话内换引擎有了两种形态,门禁必须**逐字一致** ——
    //   · 统一面板(现在的常态):sessionEngineFilter 提供跨引擎入口;
    //   · 旧两步分段(仅 device-link 老被控端 capabilities-only 降级时还会渲染):agentSwitch。
    // 任一处放松,SSH 远程或缺 CAS 能力的被控端就会露出一个必然失败的切换入口。
    expect(source).toContain(
      '!sessionId || !vendorKey || remoteHostId || !sessionAgentSwitchSupported',
    );
    expect(source).toMatch(
      /!unifiedPanelActive &&\s*\n\s*sessionId &&\s*\n\s*vendorKey &&\s*\n\s*!remoteHostId &&\s*\n\s*sessionAgentSwitchSupported/,
    );
    expect(source).toContain('hostCcCaps.capabilities?.supportsSessionAgentSwitch === true');
    expect(source).toContain('hostCcCaps.capabilities.supportsSessionAgentSwitchCas === true');
    expect(source).toContain('hostCodexCaps.capabilities?.supportsSessionAgentSwitch === true');
    expect(source).toContain('hostCodexCaps.capabilities.supportsSessionAgentSwitchCas === true');
    // 能力位读**任务所在的被控电脑**,不跟模型目录走(2026-10-09 review P1):Agent 在离线的
    // 第三台电脑时目录读不到,入口不能因此消失,否则改不回被控电脑。
    expect(source).toMatch(
      /const hostCcCaps = useAgentCapabilities\(\s*deviceLinkDeviceId \? 'claude-code' : null,\s*deviceLinkDeviceId \?\? undefined,\s*\);/,
    );
    expect(source).toMatch(
      /const hostCodexCaps = useAgentCapabilities\(\s*deviceLinkDeviceId \? 'codex' : null,\s*deviceLinkDeviceId \?\? undefined,\s*\);/,
    );
    expect(source).toContain(
      "hostCcCaps.capabilities?.supportsSessionAgentSwitchCas === true ||\n    hostCodexCaps.capabilities?.supportsSessionAgentSwitchCas === true;",
    );
    const hostSource = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    expect(hostSource).toContain('supportsSessionAgentSwitchCas: true');
  });

  it('lazy-create 从 DB 对齐原子模型选择的 effort 与 Fast,不复用旧排队快照', () => {
    const hostSource = readFileSync(
      resolve(process.cwd(), 'src/main/maker-ipc/register.ts'),
      'utf8',
    );
    const start = hostSource.indexOf('async function reconcileCreateOptsAgainstDb(');
    const end = hostSource.indexOf('const agentSwitchDeps:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = hostSource.slice(start, end);
    expect(body).toContain('effort: sessions.effort,');
    expect(body).toContain('fastMode: sessions.fastMode,');
    expect(body).toContain('permissionMode: sessions.permissionMode,');
    expect(body).toContain("co.effort = (row.effort ?? undefined) as CreateOpts['effort'];");
    expect(body).toContain('co.fastMode = !!row.fastMode;');
    expect(body).toContain('co.permissionMode = permissionModeOrAsk(row.permissionMode);');
  });

  it('本地与远程会话打开时都读回 main 权威意图,并经新鲜度守卫过滤过期响应', () => {
    expect(source).toContain('if (!sessionId || remoteHostId) return;');
    expect(source).toContain('const switchApi = deviceLinkDeviceId');
    expect(source).toContain('? makerApiForDevice(deviceLinkDeviceId)');
    expect(source).toContain(': makerApiFor(sessionId);');
    expect(source).toContain('.getSessionAgentSwitchIntent(sessionId)');
    expect(source).toContain('isAgentSwitchResponseFresh({');
    expect(source).toContain(
      'makerChatStore.mirrorAgentSwitchIntent(sessionId, authoritativeIntent)',
    );
    // 每次点选都要推进写序号,外部变更靠 store 修订号 —— 少任一个 ABA 守卫都失效。
    expect(source).toContain('nextAgentSwitchWriteSeq(sourceSessionId)');
    expect(source).toContain('makerChatStore.getAgentSwitchIntentRev(sessionId)');
    // deviceId 跨重连不变,不把重连代际放进依赖就永远不会重试(断链期间的读回失败
    // 与错过的 sessions:patched 都靠这一跳补回)。
    expect(source).toContain(
      '}, [sessionId, deviceLinkDeviceId, remoteHostId, remoteReconnectEpoch]);',
    );
    expect(source).toContain("remoteConnStatus === 'connected'");
  });

  it('切换 ack 走分派决策:发起时捕获写序号与修订号,按分支判定而非一刀切 return', () => {
    expect(source).toContain('const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);');
    expect(source).toContain(
      'const intentRevAtSend = makerChatStore.getAgentSwitchIntentRev(sourceSessionId);',
    );
    expect(source).toContain('const ackAction = resolveAgentSwitchAckAction({');
    // `return false` = 「这次选择没落地」(见「切换事务返回真实结果」一条)。
    expect(source).toContain("if (ackAction === 'discard') return false;");
    expect(source).toContain("if (ackAction === 'same-engine-reselect') {");
    expect(source).toContain('sameEngineRevision: result.sameEngineRevision,');
    expect(source).toContain('sameEngineSuperseded: result.sameEngineSuperseded,');
  });

  it('切换写入走模块级协调层(串行链与写序号按 session,不随组件卸载归零)', () => {
    expect(source).toContain('const exclusiveTurn = reserveAgentSwitchExclusive(sourceSessionId);');
    expect(source).toContain('await exclusiveTurn.ready;');
    expect(source).toContain('exclusiveTurn.release();');
    expect(source).toContain('const writeSeq = nextAgentSwitchWriteSeq(sourceSessionId);');
    expect(source).toContain('writeSeqNow: getAgentSwitchWriteSeq(sourceSessionId),');
    // 组件内不得再持有队列/序号 ref,否则重挂后又会分叉出第二条空队列。
    expect(source).not.toContain('agentSwitchWriteSeqRef');
    expect(source).not.toContain('agentSwitchQueueRef');

    const selectorSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ModelSelector.tsx'),
      'utf8',
    );
    expect(selectorSource).not.toContain('agentSwitchQueueRef');
    expect(selectorSource).toContain(
      'void agentSwitch.onSwitch(targetAgentKind, targetModelId, targetProviderId);',
    );
  });

  it('同引擎重选与前置 invoke 共占一个串行位置，并在用最新 ref 前校验会话', () => {
    const reservation = source.indexOf(
      'const exclusiveTurn = reserveAgentSwitchExclusive(sourceSessionId);',
    );
    const invoke = source.indexOf(
      // 带可选参数与不带参数的调用都必须在同一串行位置内完成。
      'await switchApi.switchSessionAgent(',
      reservation,
    );
    const invokeWithoutOptions = source.indexOf('await switchApi.switchSessionAgent(', invoke + 1);
    const scopeGuard = source.indexOf(
      'if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return false;',
      invoke,
    );
    const reselect = source.indexOf('const applied = providerId', scopeGuard);
    const staleGuard = source.indexOf('if (applied === false) return false;', reselect);
    const release = source.indexOf('exclusiveTurn.release();', reselect);
    expect(reservation).toBeGreaterThanOrEqual(0);
    expect(invoke).toBeGreaterThan(reservation);
    expect(invokeWithoutOptions).toBeGreaterThan(invoke);
    expect(scopeGuard).toBeGreaterThan(invokeWithoutOptions);
    expect(reselect).toBeGreaterThan(scopeGuard);
    expect(staleGuard).toBeGreaterThan(reselect);
    expect(release).toBeGreaterThan(reselect);
  });

  it('同引擎重选把 host 因果 token 带回 SET_MODEL，且遇到 superseded 不落后续状态', () => {
    expect(source).toContain('expectedAgentSwitchRevision?: number');
    expect(source).toContain('expectedAgentSwitchRevision === undefined &&');
    expect(source.split('expectedAgentSwitchRevision === undefined &&')).toHaveLength(3);
    expect(source).toContain('remoteAtomicModelSelectionSupported');
    expect(source).toContain(
      'expectedAgentSwitchRevision !== undefined || remoteAtomicModelSelectionSupported',
    );
    expect(source).toContain('effort: newEffort,');
    expect(source).toContain('effort: targetEffort,');
    expect(source).toContain('fastMode: restoredFast,');
    expect(source).toContain('if (!useAtomicSelection) {');
    expect(source).toContain('if (remoteSetModelResult?.superseded) {');
    expect(source).not.toContain('if (!accepted || remoteSetModelResult?.superseded) {');
    expect(source).toContain('if (setModelResult?.superseded) {');
    expect(source).toContain('result.sameEngineRevision,');
  });

  it('切换意图登记完成前所有发送入口都被同步门禁，组件重挂后 pending 仍可见', () => {
    expect(source).toContain('const agentSwitchInFlight = useSyncExternalStore(');
    expect(source).toContain('const finishAgentSwitchOperation = beginAgentSwitchOperation(');
    expect(source).toContain('finishAgentSwitchOperation();');
    expect(source).toContain('? tryBeginAgentSendDispatch(sourceSessionId)');
    expect(source).toContain('agentSwitchInFlight ||');

    // composer 之外的继续 / 编辑重发等入口最终都经过共享 store 边界，不能要求每个
    // UI 调用点记得手工登记 token。
    const sendMessage = storeSource.indexOf('function sendMessage(');
    const sendMessageBegin = storeSource.indexOf('return withAgentSendDispatch(', sendMessage);
    const sendUiTrigger = storeSource.indexOf('function sendUiTrigger(');
    const uiTriggerBegin = storeSource.indexOf('return withAgentSendDispatch(', sendUiTrigger);
    const retryLastError = storeSource.indexOf('function retryLastError(');
    const retryBegin = storeSource.indexOf(
      'return runAgentDispatchProjectionOperation(',
      retryLastError,
    );
    const compactSession = storeSource.indexOf('function compactSession(');
    const compactBegin = storeSource.indexOf(
      'return runAgentDispatchProjectionOperation(',
      compactSession,
    );
    const resumeQueue = storeSource.indexOf('function resumeQueue(');
    const resumeBegin = storeSource.indexOf('runAgentDispatchProjectionOperation(', resumeQueue);
    const steerMessage = storeSource.indexOf('function steerMessage(');
    const steerBegin = storeSource.indexOf('return withAgentSendDispatch(', steerMessage);
    const steerQueuedMessage = storeSource.indexOf('function steerQueuedMessage(');
    const queuedSteerBegin = storeSource.indexOf(
      'return withAgentSendDispatch(',
      steerQueuedMessage,
    );
    const resendBlockedMessage = storeSource.indexOf('async function resendBlockedMessage(');
    const blockedResendBegin = storeSource.indexOf(
      'const finishAgentSendDispatch = tryBeginAgentSendDispatch(sessionId);',
      resendBlockedMessage,
    );
    const sharedBegin = storeSource.indexOf(
      'const finishAgentSendDispatch = tryBeginAgentSendDispatch(sessionId);',
    );
    const sharedFinish = storeSource.indexOf(
      'return task().finally(finishAgentSendDispatch);',
      sharedBegin,
    );
    expect(sendMessageBegin).toBeGreaterThan(sendMessage);
    expect(uiTriggerBegin).toBeGreaterThan(sendUiTrigger);
    expect(retryBegin).toBeGreaterThan(retryLastError);
    expect(compactBegin).toBeGreaterThan(compactSession);
    expect(resumeBegin).toBeGreaterThan(resumeQueue);
    expect(steerBegin).toBeGreaterThan(steerMessage);
    expect(queuedSteerBegin).toBeGreaterThan(steerQueuedMessage);
    expect(blockedResendBegin).toBeGreaterThan(resendBlockedMessage);
    expect(sharedBegin).toBeGreaterThanOrEqual(0);
    expect(sharedFinish).toBeGreaterThan(sharedBegin);
  });

  it('引用水合期间发送与切换双向互斥，并在真正发送前复核切换状态', () => {
    const sendBegin = source.indexOf('tryBeginAgentSendDispatch(sourceSessionId)');
    const hydrate = source.indexOf('await resolveSessionMessageReferencesForSend(editor);');
    const sendRecheck = source.indexOf(
      'if (sourceSessionId && hasPendingAgentSwitchOperation(sourceSessionId)) return;',
      hydrate,
    );
    const onSend = source.indexOf('result = await onSend(', sendRecheck);
    const sendFinish = source.indexOf('finishAgentSendDispatch();', onSend);
    const sendSelfGuard = source.indexOf(
      'if (sessionId && hasPendingAgentSendDispatch(sessionId)) return;',
    );
    const switchGuard = source.indexOf(
      'if (hasPendingAgentSendDispatch(sessionId)) return false;',
      sendFinish,
    );

    expect(sendSelfGuard).toBeGreaterThanOrEqual(0);
    expect(sendBegin).toBeGreaterThan(sendSelfGuard);
    expect(hydrate).toBeGreaterThan(sendBegin);
    expect(sendRecheck).toBeGreaterThan(hydrate);
    expect(onSend).toBeGreaterThan(sendRecheck);
    expect(sendFinish).toBeGreaterThan(onSend);
    expect(switchGuard).toBeGreaterThan(sendFinish);
    expect(source).toContain(
      'disabled || settingsLocked || agentSendDispatchInFlight || agentSwitchInFlight',
    );
  });

  it('远程分支用稳定 deviceId 直连隧道:relay 瞬时重连会清空 sessionId→deviceId 索引', () => {
    expect(source).toContain('const switchApi = deviceLinkDeviceId');
    expect(source).toContain('? makerApiForDevice(deviceLinkDeviceId)');
    expect(source).toContain(': makerApiFor(sourceSessionId);');
  });

  it('远程只切模型沿用当前 provider,避免 JSON optional 占位清除来源', () => {
    const start = source.indexOf('const performModelChange = useCallback(');
    const end = source.indexOf('const handleModelChange = useCallback(', start);
    const body = source.slice(start, end);
    expect(body).toMatch(
      /remoteMaker\.setModel\(\s*sessionId,\s*newModelId,\s*selectedProviderId,\s*expectedAgentSwitchRevision,/,
    );
  });

  it('await 返回后做会话作用域校验:旧会话响应不得借最新 ref 写进当前会话', () => {
    // `return false` 而不是裸 return:见下一条 —— 这是「没把选择落到会话上」的出口之一。
    expect(source).toContain(
      'if (!isSessionScopeCurrent(sourceSessionId, currentSessionIdRef.current)) return false;',
    );
    // 读回同理:往返期间被切走就丢弃。
    expect(source).toContain(
      'cancelled: cancelled || !isSessionScopeCurrent(sessionId, currentSessionIdRef.current),',
    );
  });

  /**
   * 2026-08-17 review 第二项:`performAgentSwitch` 必须把**真实结果**交出去。
   *
   * 病根:统一面板的跨引擎链路(`sessionEngineFilter.onCrossEngineSelect`)此前
   * fire-and-forget 之后立即 `return true` —— 那个 true 只表示「确认框过了」。面板侧把
   * 「成功才做」的清理挂在它上面(恢复推荐清 override / 删除当前选中的收藏),于是
   * `switchSessionAgent` 抛错、或 pending send 把切换挡下时,用户的 override / 收藏已经
   * 被清掉,原配置无从恢复。
   *
   * 锁三件事:① 所有「没落地」的出口返 false;② 登记 / 应用成功的出口返 true;
   * ③ 跨引擎回调 await 并原样透传,不再自己造布尔。
   */
  it('切换事务返回真实结果:失败 / 被拒返 false,登记成功才返 true', () => {
    const start = source.indexOf('const performAgentSwitch = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(
      start,
      source.indexOf('const performAgentSwitchRef = useRef(', start),
    );
    // 签名显式声明 Promise<boolean> —— 返回值是契约的一部分,不靠推断。
    expect(body).toContain('): Promise<boolean> => {');
    // 「没落地」的出口:无会话或设置只读 / pending send 拒绝 / 会话已切走 / ack 被超车。
    expect(body).toContain('if (!sessionId || settingsLocked) return false;');
    expect(body).toContain('if (hasPendingAgentSendDispatch(sessionId)) return false;');
    expect(body).toContain("if (ackAction === 'discard') return false;");
    // 同引擎重选被修订号守卫拒下 = 没落地。
    expect(body).toContain('if (applied === false) return false;');
    // 事务抛错(toast 之外)也必须让调用方知道「没切」。
    expect(body).toMatch(/\} catch \(err\) \{[\s\S]*?return false;\s*\} finally \{/);
    // 无条件 `return true;` 只剩同引擎重选成功 / 立即切换两条;apply-intent 的成功出口
    // 经完整配置一致性判据返回(2026-08-19 review P2 收口,见下一条锁)。
    expect(body.match(/return true;/g)?.length).toBe(2);
    // 登记成功 ≠ 完整配置落地:回声匹配路径的返回值必须过 effort / Fast 一致性判据 ——
    // 另一控制端在往返期间只改同一意图的档位 / Fast 时,本端请求没有原样落地,按 false
    // 上报,调用方挂在成功上的持久化收尾(onApplied 清 override / 提交・删除收藏编辑 /
    // 写收藏锚点)一律不做。
    expect(body).toContain('return isAgentSwitchEchoConfigConsistent({');
    expect(body).toContain('requestedEffort: newEffort,');
    expect(body).toContain('requestedFastMode: targetFast,');
  });

  it('统一面板的跨引擎回调 await 并透传事务结果,不再返回「确认框过了」', () => {
    const start = source.indexOf('const sessionEngineFilter = useMemo(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('}, [', start));
    // 取消确认 = false(现状,不变)。**有意变更**(Chris 2026-08-20):确认只认任务真实引擎,
    // 挂着的意图不算已经确认过 —— Claude 任务点了 Pi 收藏再点另一条,仍要弹框。
    expect(body).toContain('if (!(await confirmAgentBrowseSwitch(targetAgent))) return false;');
    expect(body).toContain('runtimeAgent: runtimeAgentKind ?? undefined,');
    // 真实结果原样交出去;绝不再出现 fire-and-forget + 提前 true。
    expect(body).toContain('const applied = await performAgentSwitchRef.current(');
    expect(body).toContain('return applied;');
    expect(body).not.toContain('void performAgentSwitchRef.current(');
    expect(body).not.toContain('return true;');
    // 收藏锚点也挂在**真实结果**上(2026-08-17 review 第三轮 G4):取消 / 失败不记锚点。
    expect(body).toContain('if (applied) {');
    expect(body).toContain('setSessionFavoriteAnchor(');
  });

  it('ack 判定带上「当前权威值就是本次登记那一份」,意图期改选一律 await 并透传结果', () => {
    // 1a:main 先广播 patched、后回 ack,push 必然先到并推走修订号 —— 缺这个判据,每一次
    // 正常登记都被自己的回声判成 stale(乐观呈现 / 草稿同步 / 收藏锚点全不落,而 main 的
    // 意图还在,下一条消息照样切引擎)。
    expect(source).toContain('registeredIntentMatchesCurrent,');
    expect(source).toContain('registeredIntent.target === targetAgentKind');
    expect(source).toContain('registeredIntent.model === newModelId');
    expect(source).toContain('registeredIntent.providerId === providerId');
    // providerId=null(跟随默认路由)时只认 target+model 的通配出口 —— main 可能把 null
    // 解析成具体来源再登记(2026-08-19 review P1 的前半)。
    expect(source).toContain('providerId === null ||');
    // ★ 回声已匹配时 apply-intent **整个跳过 note**(2026-08-19 两轮 P1 的合并收口):
    // store 里已是权威快照,任何本端旧值(null providerId / 旧 newEffort / 旧 targetFast)
    // 盖上去都会与被控端分叉 —— 覆盖「另一控制端只改 effort」「只改 Fast」「两者均改」
    // 与「main 归一化本端登记」全部场景;回声已到过,不会再有第二次权威回流纠正。
    expect(source).toContain('if (!registeredIntentMatchesCurrent) {');
    expect(source).not.toContain('appliedProviderId');
    // ★ 偏好同步同族(2026-08-19 review P2):回声已匹配时 syncSessionDraftModelPrefs 也必须
    // 用权威快照的 effort/fastMode/providerId —— 覆盖 effort-only / Fast-only / 两者均改 /
    // provider 归一化四种场景;权威快照缺某字段时该维不写,不回落本端旧值。
    expect(source).toContain(
      'const authoritative = registeredIntentMatchesCurrent ? registeredIntent : null;',
    );
    expect(source).toContain(
      'const syncedEffort = authoritative ? authoritative.effort : newEffort;',
    );
    expect(source).toContain(
      'const syncedFast = authoritative ? authoritative.fastMode : targetFast;',
    );
    expect(source).toContain(
      'const syncedProviderId = authoritative ? authoritative.providerId : providerId;',
    );
    expect(source).toContain('activeProviderId: syncedProviderId,');
    expect(source).toContain('memoryProviderId: syncedProviderId,');
    // (立即切换 apply-switched 分支仍可用本端值 —— 它以修订号未变为前提,没有已消费的
    // 权威回声,不在本锁范围内。)
    // 1d:意图期改选模型 / 来源必须 await 并把结果交回去,不能 fire-and-forget 返回
    // undefined 让上游读成「已应用」。
    expect(source).not.toContain('void performAgentSwitch(');
    expect(source).toContain(
      'return await performAgentSwitch(intent.target, newModelId, null, {',
    );
    expect(source).toContain('intent.effort ? { effort: intent.effort as Effort }');
    // 意图期改选带来的 Fast override 必须过目标能力门,不能把旧 Fast 写进不支持的模型。
    expect(source).toContain('overrides.fastMode && fastCapable');
  });

  /**
   * Chris 2026-08-19「面板原地刷新」+ 2026-08-20「改思维闪关菜单」:
   * disabled 不得参与 popover 开关。`(open && !disabled) || keepOpen` 只保住确认框那条路,
   * 改思维走 performAgentSwitch 时 keepOpen 是 false,选单照关。
   */
  it('ModelSelector 的保命锁不被 disabled 压穿(两个 popover 分支同一表达式)', () => {
    const selectorSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/ModelSelector.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const matches = selectorSource.match(/open=\{open \|\| keepOpenForAgentConfirmation\}/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(selectorSource).not.toContain('(open || keepOpenForAgentConfirmation) && !disabled');
    expect(selectorSource).not.toContain('(open && !disabled) || keepOpenForAgentConfirmation');
    // 配置切引擎保持展开；选中模型行成功后收起。disabled 仍不得参与开关。
    expect(selectorSource).toContain('setOpenWithoutAutoRefresh(configuring || applied === false)');
    expect(selectorSource).toContain(
      "onProviderChange(args.providerId, args.wireModelId, args.effort ?? '', args.config.fast)",
    );
  });

  it('换引擎确认:回原引擎或点已确认的意图目标不再弹,换第三家仍要问', () => {
    expect(source).toContain('runtimeAgentKind === targetAgent');
    expect(source).toContain('agentSwitchIntent?.target === targetAgent');
  });

  it('会话传入历史收藏 uid，由统一面板校验完整配置后显示选中态', () => {
    expect(source).toContain('sessionFavoriteAnchor?.uid ?? null');
    expect(source).not.toContain('sessionFavoriteAnchor.wireModelId === activeModel');
  });

  it('跨引擎选中拿任务真实引擎比,不拿意图目标', () => {
    const actions = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/useUnifiedRowActions.ts'),
      'utf8',
    );
    expect(actions).toContain('const runtimeAgent = sessionEngineFilter?.runtimeAgent;');
    expect(actions).not.toContain(
      'const runtimeAgent = sessionEngineFilter?.runtimeAgent ?? sessionAgent;',
    );
    expect(actions).toContain('if (runtimeAgent === undefined) return true;');
    expect(actions).toContain('shouldCrossEngine(config.agent)');
    expect(actions).toContain('pendingSwitch');
    expect(actions).toContain('favoriteCopyIsLive');
    expect(actions).not.toContain('config.agent !== sessionAgent');
  });

  it('打开选单只滚动选中行,不把焦点从搜索框抢走', () => {
    const panel = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/new-chat/UnifiedModelPanel.tsx'),
      'utf8',
    );
    const ensure = panel.slice(
      panel.indexOf('const ensureSelectedVisible = useCallback'),
      panel.indexOf('  useEffect(() => {', panel.indexOf('const ensureSelectedVisible = useCallback')),
    );
    expect(ensure).not.toContain('row.focus');
    expect(ensure).toContain('computeSelectedRowScrollTop');
  });

  it('preserves Orca role and remote-worker provenance across the view and composer', () => {

    const remoteOptions = source.slice(source.indexOf('const sessionRemoteAgentOptions ='),
      source.indexOf('// composer pill 尾部引擎小标'));

    expect(source).not.toContain('sessionOrcaRole === null &&');

    expect(remoteOptions).toContain('    sessionOrcaRole,');

    expect(remoteOptions).toContain('    sessionOrcaRemoteWorker,');

    // 会话视图必须保留 undefined 未知态，避免在完整 session 回流前冒充具体身份。
    const viewSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/features/cc-agent/CCAgentSessionView.tsx'),
      'utf8',
    );

    expect(viewSource).toContain(
      'sessionOrcaRole={session ? (session.orcaRole ?? null) : undefined}',
    );

    expect(viewSource).toContain('sessionOrcaRemoteWorker={!!session?.orcaRemoteLead}');
  });
});


describe('CCAgentSessionView 上下文环压缩入口按 agent 能力分流(#1927)', () => {
  const viewSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/features/cc-agent/CCAgentSessionView.tsx'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('onCompact 门控:通道存在 + pi 排除 SSH 远程(remoteHostId) + pi running 禁用,codex 无通道不开放', () => {
    // 门控不再硬编码 agentKind 排除列表:以 compactChannel(能力判定)为准;
    // pi 的 SSH 远程会话(remoteHostId)无 compact-session 路由 → 显式排除
    // (与 SessionContentHeader 压缩菜单仅本地/device-link 一致,Copilot P2)。
    expect(viewSource).toContain('compactChannel !== null');
    expect(viewSource).toContain("!(realAgentKind === 'pi' && !!session?.remoteHostId)");
    // pi 回合运行中会拒绝压缩 → compact-session 通道 running 时禁用(与
    // SessionContentHeader 的 runningSessionIds 一致,codex P1);claude-input 保留旧行为。
    expect(viewSource).toContain(
      "!(compactChannel === 'compact-session' && agentStatus.isRunning)",
    );
    // codex(无 manualCompact)→ compactChannel null → 不开放(纯展示)。
  });

  it('compact-session 分支:粘滞路由 + 确认框后重新分流 + 失败反馈', () => {
    // 分流以当前 render 的 compactChannel 判定(channelNow),确认框返回后重新解析——
    // 同会话在其它窗口/远程被切换 agent 时捕获值会过期(codex P1)。
    expect(viewSource).toContain("if (channelNow === 'compact-session') {");
    // workingDir 只对 claude-input 是硬前提:compact-session(pi 原生压缩)不依赖它。
    expect(viewSource).toContain(
      "if (sourceCompactChannel === 'claude-input' && !sourceSession.workingDir) return;",
    );
    // device-link 远程 pi:粘滞归属路由到被控端,relay 重连窗口内不退回本机(greptile P1)。
    expect(viewSource).toContain('const sourceSessionId = sourceSession.id;');
    expect(viewSource).toContain('const maker = makerApiForSticky(sourceSessionId);');
    expect(viewSource).toContain('await maker.compactSession(sourceSessionId)');
    // 在途期间切换会话 / 登出 / 切回(换代):旧响应不得在当前视图弹 toast(并发收口)。
    expect(viewSource).toContain('const committedSessionId = sessionId ?? null;');
    expect(viewSource).toContain('compactRequestGuard.setCurrentSession(committedSessionId)');
    // 代校验:sessionId 当前 + 请求代一致;finally 里 release(不再按 sessionId finish)。
    expect(viewSource).toContain('const begun = compactRequestGuard.tryBegin(sourceSessionId);');
    expect(viewSource).toContain('if (!begun) return;');
    expect(viewSource).toContain('compactRequestGuard.isCurrent(sourceSessionId, begun.epoch)');
    expect(viewSource).toContain('begun.release();');
    // 真实 reject 必须 catch 并显示 compactFailed。
    expect(viewSource).toContain("toast.warning(t('ccAgent.sidebar.sessionMenu.compactFailed'))");
  });

  it('claude-code 分支保持 inputCoordinator compactSession(model,...),不误入 compact-session', () => {
    // compact-session 分支以 return 结束;return 之前只有 makerApiForSticky 通道,
    // 不调用 inputCoordinator 的 compactSession(model, effort, ...)(即 maker:input:compact)。
    const csStart = viewSource.indexOf("if (channelNow === 'compact-session')");
    expect(csStart).toBeGreaterThan(-1); // 定位必须命中,否则断言形同虚设(copilot review)
    const csEnd = viewSource.indexOf('return;', csStart);
    const csBranch = viewSource.slice(csStart, csEnd);
    expect(csBranch).not.toContain('await compactSession(');
    // 确认框返回后若 channel 已消失(能力被撤/agent 切换)则放弃,不静默误调。
    // 关键:重分流必须读 compactChannelRef.current(useCallback 闭包固定捕获旧值,
    // 旧 async 函数 await 期间重新 render 也不会更新闭包——greptile review)。
    expect(viewSource).toContain('const compactChannelRef = useRef(compactChannel);');
    expect(viewSource).toContain('compactChannelRef.current = compactChannel;');
    expect(viewSource).toContain('const channelNow = compactChannelRef.current;');
    expect(viewSource).toContain('if (channelNow === null) return;');
    // claude 通道执行前才校验 workingDir(输入协调器硬前提),且参数必须来自**最新**
    // session 快照——同会话切换 agent 后 model/effort/permission/workingDir 已变化,
    // 旧快照会按错误配置执行(greptile P1 / codex P2)。
    expect(viewSource).toContain('const sessionRef = useRef(session);');
    expect(viewSource).toContain('sessionRef.current = session;');
    expect(viewSource).toContain('const sessionNow = sessionRef.current;');
    expect(viewSource).toContain("if (channelNow !== 'claude-input') return;");
    expect(viewSource).toContain('if (!sessionNow?.workingDir) return;');
    expect(viewSource).toContain('sessionNow.model,');
    // 确认框期间 turn 可能已从其它窗口/远程启动:render 时 isRunning 守卫失效,重读
    // 最新 running ref,活跃 turn 的 pi 拒绝压缩 → 放弃(codex P2);claude-input 保留旧行为。
    expect(viewSource).toContain('const isRunningRef = useRef(agentStatus.isRunning);');
    expect(viewSource).toContain('isRunningRef.current = agentStatus.isRunning;');
    expect(viewSource).toContain(
      "if (channelNow === 'compact-session' && isRunningRef.current) return;",
    );
  });
});
