import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const sessionViewSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSessionView.tsx'),
  'utf8',
);

const pendingHandoffSource = readFileSync(
  resolve(__dirname, '..', 'state', 'pendingFirstMessage.ts'),
  'utf8',
);

const remoteCollabHandoffSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'remoteCollabHandoff.ts'),
  'utf8',
);

describe('NewMakerDraftRoute Orca worker create order', () => {
  it('delegates worker creation to enableOrca and defers tab reveal until the new route is current', () => {
    const collabBranch = source.indexOf('if (shouldEnableCollab)');
    const enableOrca = source.indexOf(
      'const result = await window.electronAPI.maker.enableOrca',
      collabBranch,
    );
    const revealState = source.indexOf(
      'orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };',
      enableOrca,
    );
    const navigate = source.indexOf(
      'navigate(orcaNavTarget ?? `/cc-agent/${newSession.id}`',
      revealState,
    );

    expect(collabBranch).toBeGreaterThan(-1);
    expect(enableOrca).toBeGreaterThan(collabBranch);
    expect(revealState).toBeGreaterThan(enableOrca);
    expect(navigate).toBeGreaterThan(revealState);
    expect(source).toContain('state: orcaWorkersRevealState');
    expect(source).toContain('orcaWorkersReveal: orcaWorkersRevealState');
    expect(source).not.toContain('/cc-agent/orca/${newSession.id}');
    expect(source).not.toContain('workerAgent=${workerAgent}');
    expect(source).not.toContain('window.electronAPI.localDb.orcaWorkflows.addWorker');
    expect(source).not.toContain('markOrcaRole(worker.sessionId');
  });

  it('uses the shared collaboration error i18n mapper for every draft enable path', () => {
    // 本机 / SSH 侧四条草稿起 Worker 路径都走同一个错误映射器:Send 普通、Send worktree、
    // 新建目标(2026-07-23 新增 New Goal 路径也 honor 协同,codex P2)、以及 SSH 添加远程
    // 项目(2026-07-28 remote 协同接通, codex-connector P2)。
    const mappedFallbacks =
      source.match(
        /getCollaborationStartErrorMessage\(err, t, \{ continueAsSingleSession: true \}\)/g,
      ) ?? [];
    expect(mappedFallbacks).toHaveLength(4);

    // device-link 两条(issue #1170)的失败提示已随「等待挪到导航之后」一起搬进
    // CCAgentSessionView 的 pending 消费,draft route 不再自己 toast。
    expect(source).not.toContain('remoteDevice: true');
    expect(source).not.toContain("toast.error(t('newChat.collaboration.startFailed'");
  });

  it('hands the collab intent to the session view instead of awaiting it before navigation', () => {
    // #1170 三轮 review 的收敛结果:两条约束方向相反 ——
    //  · 首轮必须排在协同之后(否则 Lead 首个 turn 没有 cindy_orca 工具);
    //  · 提交点之后不得插入远程等待(隧道往返可能走到 invoke 默认 30s 超时,挡在 navigate
    //    前面既让新建页卡住半分钟,又把「对端会话已建好、用户输入还只在内存里」的窗口拉到
    //    同样长度,窗口内应用被关掉就永久丢消息)。
    // 只能靠「登记完立刻导航、等待挪到会话视图」同时满足。所以 draft route 里:
    //  ① 不得再 await 开协同;② 协同意图随 pending 载荷交出去;③ 导航紧跟登记。
    expect(source).not.toContain('enableRemoteCollabForSession');

    const sendBranch = source.slice(
      source.indexOf('if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {'),
    );
    const sendPending = sendBranch.indexOf('setPending(remoteSessionId, {');
    const sendCollab = sendBranch.indexOf('remoteCollab: {', sendPending);
    const sendNavigate = sendBranch.indexOf('navigate(`/cc-agent/${remoteSessionId}`', sendPending);
    expect(sendPending).toBeGreaterThan(-1);
    // 协同意图必须在 pending 载荷内(而不是 navigate state):它要被 consumePending 一起取走。
    expect(sendCollab).toBeGreaterThan(sendPending);
    expect(sendNavigate).toBeGreaterThan(sendCollab);

    const goalHandler = source.slice(source.indexOf('const handleCreateGoal = useCallback('));
    const goalPending = goalHandler.indexOf('setPendingGoal(remoteSessionId, {');
    const goalCollab = goalHandler.indexOf('remoteCollab: {', goalPending);
    expect(goalPending).toBeGreaterThan(-1);
    expect(goalCollab).toBeGreaterThan(goalPending);
  });

  it('keeps both device-link enable paths on the shared remote collab helper', () => {
    // 两条路径逐字重复这段收尾正是 #807 反复踩的坑(漏改一处没有任何编译/测试信号)。
    // 收敛后:draft route 只登记意图,SessionView 的两处 pending 消费共用同一个入口,
    // 时序不变量(等 enableOrca、**不等**镜像回流)住在 remoteCollabHandoff 里一处可改。
    expect(sessionViewSource.match(/consumePendingRemoteCollab\(/g)).toHaveLength(2);
    expect(source).not.toContain('refreshRemoteDeviceSessions');
    expect(remoteCollabHandoffSource).toContain('void refreshRemoteDeviceSessions(p.deviceId)');
    expect(remoteCollabHandoffSource).not.toContain('await refreshRemoteDeviceSessions(');
  });

  it('tells the user the turn still goes out when remote collab fails', () => {
    // `_REMOTE` 文案只讲「去那台机器修好再重试」,没说这一条仍然会发出去 —— 用户据此
    // 可能以为没发、再提交一次(codex review P2)。两处消费都必须带 continueAsSingleSession。
    expect(
      sessionViewSource.match(/remoteDevice: true,\s*\n\s*continueAsSingleSession: true,/g),
    ).toHaveLength(2);
  });

  it('locks the composer for the whole remote handoff, not just the collab wait', () => {
    // 交接期间(可能数十秒)会话看起来是空的,用户很容易以为没发出去而再打一条 —— 那条会
    // 先进 Lead,草稿提交的首条反而排到它后面,顺序倒置,首轮还可能在协同未就绪时跑掉
    // (codex review P2 ×2)。按 worktree 创建同款处理:交接**全程**锁住发送。
    //
    // 名字不叫 remoteCollabPreparing:它现在也覆盖没开协同的远程起目标路径,
    // 叫 collab 会误导下一个人以为只在开协同时为真。
    expect(sessionViewSource).toContain(
      'const [remoteHandoffPreparing, setRemoteHandoffPreparing]',
    );
    // 两处 pending 消费都要置位,且都用 finally 解锁(任何终态都不能把 composer 锁死)。
    expect(sessionViewSource.match(/setRemoteHandoffPreparing\(true\)/g)).toHaveLength(2);
    expect(sessionViewSource.match(/setRemoteHandoffPreparing\(false\)/g)).toHaveLength(2);
    const finallyUnlocks = sessionViewSource.match(
      /\} finally \{\s*\n\s*(?:if \(holdComposer\) )?setRemoteHandoffPreparing\(false\);/g,
    );
    expect(finallyUnlocks).toHaveLength(2);

    // 「会话正在准备」只允许有一个下游判据:handleSend 拦截读合并值,ChatInput 也禁用。
    expect(sessionViewSource).toContain(
      'const sessionHandoffPreparing = worktreePreparing || remoteHandoffPreparing;',
    );
    expect(sessionViewSource).toContain('if (sessionHandoffPreparing) return false;');
    expect(sessionViewSource).not.toContain('if (worktreePreparing) return false;');
    expect(sessionViewSource).toContain(
      'disabled={remoteSessionUnavailable || remoteHandoffPreparing}',
    );
  });

  it('refreshes the remote mirror even when the remote enableOrca reports failure', () => {
    // 控制端的 invoke 超时**不会取消**被控端正在跑的 enableOrca,所以「控制端报失败、
    // 对端稍后仍建成 team」是真实终态(codex review P1)。回流放在 finally 里,让
    // orcaRole 尽快回流、由 external-enable 边沿检测把协同 tab 补开,UI 最终与被控端收敛。
    const body = remoteCollabHandoffSource.slice(
      remoteCollabHandoffSource.indexOf('export async function enableRemoteCollabForSession('),
    );
    const returnAt = body.indexOf('return { focusWorkerSessionId:');
    const finallyAt = body.indexOf('} finally {');
    expect(returnAt).toBeGreaterThan(-1);
    expect(finallyAt).toBeGreaterThan(returnAt);
    expect(body.indexOf('void refreshRemoteDeviceSessions(')).toBeGreaterThan(finallyAt);
  });

  it('narrows the device-link worker source against the controlled device catalog', () => {
    // 草稿里持久化的来源/模型按**目标设备**的目录收窄:device-link 分支必须用
    // deviceProviders,拿控制端的 localProviders 收窄等于用错机器的目录。
    const collapsed = source.replace(/\s+/g, ' ');
    const remoteNarrowing =
      collapsed.match(
        /draftEnableOrcaOptions\( effectiveCollab, deviceProviders, !deviceProvidersLoading, \)/g,
      ) ?? [];
    expect(remoteNarrowing).toHaveLength(2);
    // 本机 / SSH 的四条路径仍按控制端目录收窄,不能被一起改掉。
    expect(
      collapsed.match(
        /draftEnableOrcaOptions\(\s*effectiveCollab,\s*localProviders,\s*!localProvidersLoading,?\s*\)/g,
      ) ?? [],
    ).toHaveLength(4);
  });

  it('re-validates the worker agent against the target device catalog', () => {
    // Worker 类型也是设备作用域的(codex review P2):在只连 Codex 的设备 A 选了 Codex
    // Worker,切到只连 Claude 的设备 B 时 workerConfig 虽被清空,collab.worker 仍是 codex,
    // 透传过去必撞被控端 NO_PROVIDER_FOR_AGENT,协同又静默降级成单会话。
    const fn = source.slice(
      source.indexOf('function draftEnableOrcaOptions('),
      source.indexOf('const createAgentQuickStarts'),
    );
    expect(fn).toContain('const preferredAgent');
    // 按目标设备目录判断:首选 agent 无已连接供应商时,从三种 agent 中找可用回退。
    expect(fn).toContain('connectedProvidersForAgent(providers, preferredAgent).length > 0');
    expect(fn).toContain("(['claude-code', 'codex', 'pi'] as const).find(");
    expect(fn).toContain(
      'agent !== preferredAgent && connectedProvidersForAgent(providers, agent).length > 0',
    );
    // 目录未就绪时不收窄(空快照会误判成"都没有"),与 providerId 同一条口径。
    expect(fn).toContain('if (!providersReady) return preferredAgent;');
    // 换了 agent 就必须丢掉属于旧 agent 的 model / providerId,否则改撞 INVALID_PARAMS。
    expect(fn).toContain('if (workerAgent !== preferredAgent)');
  });

  it('blocks new-goal creation until a selected collaboration policy is available', () => {
    const goalHandler = source.slice(source.indexOf('const handleCreateGoal = useCallback('));
    expect(goalHandler).toContain('let policyEnabled = collabPolicy.enabled');
    expect(goalHandler).toContain('if (collabPolicy.loading)');
    expect(goalHandler).toContain('if (collabPolicy.unavailable)');
    expect(goalHandler).toContain('collabPolicy.refresh()');
    expect(goalHandler).toContain('policyEnabled = refreshed.enabled');
    expect(goalHandler).toContain('if (!policyEnabled)');
    expect(goalHandler.indexOf('if (collabPolicy.loading)')).toBeLessThan(
      goalHandler.indexOf('const newSession = await createSession'),
    );
  });

  it('carries a successful policy refresh into all collaboration creation branches', () => {
    expect(source.match(/const shouldEnableCollab =/g)).toHaveLength(2);
    // 3 = Send 普通 + Send worktree + 本机/SSH 新建目标;device-link 两条改为在 pending
    // 载荷里按 shouldEnableCollab 决定是否带 remoteCollab,不再有独立分支。
    expect(source.match(/if \(shouldEnableCollab\)/g)).toHaveLength(3);
    expect(source.match(/\.\.\.\(shouldEnableCollab/g)).toHaveLength(2);
    expect(source).not.toContain('effectiveCollabEnabled');
  });

  it('treats an out-of-date controlled device as a terminal reason, not a retryable one', () => {
    // 老被控端没有 maker:plugins:get-state → CHANNEL_NOT_ALLOWED。给「稍后重试」是误导:
    // 重试永远不会成功。所以 unsupported 单独分类,且排在 unavailable 之前;
    // onDisabledActivate(重试入口)仍然只挂在 unavailable 上。
    expect(source).toContain("t('newChat.collaboration.unsupportedRemoteHint')");
    expect(source).toContain('collabPolicy.unsupported');
    expect(source).not.toContain('onDisabledActivate: collabPolicy.unsupported');
    const disabledReason = source.slice(source.indexOf('disabledReason:'));
    expect(disabledReason.indexOf('collabPolicy.unsupported')).toBeLessThan(
      disabledReason.indexOf('collabPolicy.unavailable'),
    );
  });

  it('surfaces initial policy loading and retries an unavailable draft toggle', () => {
    expect(source).toContain("toast.warning(t('newChat.collaboration.loadingHint'))");
    expect(source).toContain('onDisabledActivate: collabPolicy.unavailable');
    expect(source).toContain('void collabPolicy.refresh().then((policy) => {');
    expect(source).toContain('if (policy.enabled && !policy.unavailable) {');
  });

  // 远程交接期间用户输入必须有第二份副本(greptile P1 + codex P1)。
  // 关键是副本落在**登记那一刻**,不是消费那一刻:消费 effect 要等 historyLoaded,
  // 而被控端离线 / 首次拉历史超过 PENDING_TTL_MS(60s)时它根本轮不到跑,
  // 内存项却已被 TTL 删掉 —— 副本落在消费处等于没落。
  describe('远程交接的可恢复副本', () => {
    const messageBranch = () => {
      const start = sessionViewSource.indexOf('const pending = consumePending(sessionId);');
      const end = sessionViewSource.indexOf('const pendingGoalConsumedRef', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return sessionViewSource.slice(start, end);
    };
    const goalBranch = () => {
      const start = sessionViewSource.indexOf('const pendingGoal = consumePendingGoal(sessionId);');
      expect(start).toBeGreaterThan(-1);
      return sessionViewSource.slice(start, start + 4000);
    };

    it('副本在草稿路由登记 pending 的同一刻落下,不等会话视图消费', () => {
      // 两条 device-link 分支都要落,且必须排在各自的 setPending / setPendingGoal 之后、
      // navigate 之前 —— 登记完就有副本,后面无论多久没被消费都捞得回来。
      const sendRemember = source.indexOf(
        "rememberRecoverableHandoff(remoteSessionId, 'message', message)",
      );
      const goalRemember = source.indexOf(
        "rememberRecoverableHandoff(remoteSessionId, 'goal', objective)",
      );
      expect(sendRemember).toBeGreaterThan(-1);
      expect(goalRemember).toBeGreaterThan(-1);
      // 副本要**紧贴提交点**:排在 commitRemoteSessionHandoff 之后,但在附件迁移那次
      // await 之前 —— 提交点之后每多一次 await,「对端会话已建好、正文却还没有第二份」
      // 的窗口就长一分(codex P2 第五轮)。
      const sendCommit = source.lastIndexOf("logTag: 'draft send',", sendRemember);
      const rehome = source.indexOf('await rehomeDraftAttachments(', sendCommit);
      expect(sendCommit).toBeGreaterThan(-1);
      expect(sendCommit).toBeLessThan(sendRemember);
      expect(sendRemember).toBeLessThan(rehome);
      expect(source.lastIndexOf('setPendingGoal(remoteSessionId, {', goalRemember)).toBeGreaterThan(
        -1,
      );
      expect(sendRemember).toBeLessThan(
        source.indexOf('navigate(`/cc-agent/${remoteSessionId}`', sendRemember),
      );
      // 只落一次,别两处都落。
      expect(source.match(/rememberRecoverableHandoff\(remoteSessionId, 'message'/g)).toHaveLength(
        1,
      );
      // 会话视图不再自己落副本(落在那里要等 historyLoaded,等于没落)。
      expect(sessionViewSource).not.toContain('rememberRecoverableHandoff(');
    });

    it('首条消息:等协同 → 经 deliver 发送 → 锁覆盖整条交接', () => {
      const branch = messageBranch();
      const lock = branch.indexOf('if (holdComposer) setRemoteHandoffPreparing(true)');
      const awaitCollab = branch.indexOf('await consumePendingRemoteCollab(pending.remoteCollab');
      const send = branch.indexOf('sendMessage(');
      const unlock = branch.indexOf('if (holdComposer) setRemoteHandoffPreparing(false)');

      expect(lock).toBeGreaterThan(-1);
      expect(awaitCollab).toBeLessThan(send);
      // 解锁必须排在 sendMessage **之后**:提前解锁的话,命令派发那次 await 里
      // 用户补发的消息会抢在草稿提交的首条之前。
      expect(lock).toBeLessThan(awaitCollab);
      expect(send).toBeLessThan(unlock);
      // sendMessage 失败时 resolve false 而不抛错 —— 必须 await 且经 deliver 判定,
      // 裸调 + 立刻丢副本会让正文从界面和磁盘上一起消失(codex P1 第五轮)。
      expect(branch).toContain('await deliverRecoverableHandoff(sessionId, () =>');
      expect(branch).toContain('sendMessage(');
    });

    it('新建目标:锁从消费一路盖到 setGoal 结束,setGoal 成功后才清副本', () => {
      const branch = goalBranch();
      const lock = branch.indexOf('setRemoteHandoffPreparing(true)');
      const awaitSubscribe = branch.indexOf('await window.electronAPI.deviceLink.subscribe(');
      // 归属走粘滞解析:非粘滞版在 relay 瞬断窗口会返回 undefined → 跳过订阅,
      // 而 goalApiFor 仍按粘滞归属把 setGoal 发到被控端(greptile P1,不变量 #3)。
      expect(branch).toContain('const deviceId = getStickySessionDeviceId(sessionId);');
      const awaitCollab = branch.indexOf(
        'await consumePendingRemoteCollab(pendingGoal.remoteCollab',
      );
      const setGoal = branch.indexOf('await goalApiFor(sessionId).setGoal(');
      const forget = branch.indexOf('deliverRecoverableHandoff(sessionId, async () => {');
      const unlock = branch.indexOf('setRemoteHandoffPreparing(false)');

      // subscribe 与 setGoal 同样是隧道 invoke、同样可能 30s;锁必须把它们都包住。
      expect(lock).toBeLessThan(awaitSubscribe);
      expect(lock).toBeLessThan(awaitCollab);
      expect(awaitCollab).toBeLessThan(setGoal);
      // setGoal 抛错时副本必须留着 → 它必须包在 deliver 的回调里(抛错就到不了 forget)。
      expect(forget).toBeLessThan(setGoal);
      expect(setGoal).toBeLessThan(unlock);
    });

    it('删除副本只有一条路:deliverRecoverableHandoff', () => {
      // 本 PR 的 review 里,"这算交付了吧"被三个调用点各自判断、各自判错过一次。
      // 收进 deliver 之后 forgetRecoverableHandoff 不再导出,裸调直接编译不过。
      expect(sessionViewSource).not.toContain('forgetRecoverableHandoff(');
      expect(pendingHandoffSource).toContain('function forgetRecoverableHandoff(');
      expect(pendingHandoffSource).not.toContain('export function forgetRecoverableHandoff(');
      // 三处交接(命令派发 / 首轮发送 / 起目标)都要走它。
      expect(sessionViewSource.match(/deliverRecoverableHandoff\(sessionId,/g)).toHaveLength(3);
    });

    it('内存里没有 pending 时才走恢复,且只回填输入框、不自动补发', () => {
      expect(sessionViewSource).toContain("restoreRecoverableHandoff('message')");
      expect(sessionViewSource).toContain("restoreRecoverableHandoff('goal')");
      // 恢复走 composer 草稿的既有外部写入通道,而不是偷偷再 sendMessage 一次。
      const restore = sessionViewSource.slice(
        sessionViewSource.indexOf('const restoreRecoverableHandoff = useCallback('),
      );
      const body = restore.slice(0, restore.indexOf('[sessionId, t]'));
      expect(body).toContain('saveComposerDraft(sessionId,');
      expect(body).not.toContain('sendMessage(');
      // 输入框已有内容时先让路,且必须在 take 之前判断 —— 否则副本已被取走,
      // 让路就变成了直接丢弃。
      expect(body.indexOf('getComposerDraftPresence(sessionId)')).toBeLessThan(
        body.indexOf('takeRecoverableHandoff(sessionId, kind)'),
      );
    });
  });
});
