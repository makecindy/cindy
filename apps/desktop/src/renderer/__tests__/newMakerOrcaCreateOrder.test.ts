import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
  'utf8',
);

const remoteCollabHandoffSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'remoteCollabHandoff.ts'),
  'utf8',
);

describe('NewMakerDraftRoute Orca worker create order', () => {
  it('delegates worker creation to enableOrca and defers tab reveal until the new route is current', () => {
    const collabBranch = source.indexOf('if (shouldEnableCollab)');
    const enableOrca = source.indexOf('const result = await window.electronAPI.maker.enableOrca', collabBranch);
    const revealState = source.indexOf('orcaWorkersRevealState = { focusWorkerSessionId: result.workerSessionId };', enableOrca);
    const navigate = source.indexOf('navigate(orcaNavTarget ?? `/cc-agent/${newSession.id}`', revealState);

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

  it('uses the shared collaboration error i18n mapper for all six draft enable paths', () => {
    // 本机 / SSH 侧四条草稿起 Worker 路径都走同一个错误映射器:Send 普通、Send worktree、
    // 新建目标(2026-07-23 新增 New Goal 路径也 honor 协同,codex P2)、以及 SSH 添加远程
    // 项目(2026-07-28 remote 协同接通, codex-connector P2)。
    const mappedFallbacks = source.match(/getCollaborationStartErrorMessage\(err, t, \{ continueAsSingleSession: true \}\)/g) ?? [];
    expect(mappedFallbacks).toHaveLength(4);

    // device-link 的 Send / 新建目标两条(issue #1170)用 remoteDevice 口径:错误来自
    // **被控设备**,文案必须指向那台机器(`*_REMOTE`),不能说成「已改为单对话继续」那种
    // 本机语气 —— 用户要去被控端改配置才修得好。
    const mappedRemote = source.match(/getCollaborationStartErrorMessage\(err, t, \{ remoteDevice: true \}\)/g) ?? [];
    expect(mappedRemote).toHaveLength(2);

    expect(source).not.toContain("toast.error(t('newChat.collaboration.startFailed'");
  });

  it('enables collaboration on the controlled device for both device-link draft paths', () => {
    // #1170:device-link 草稿此前完全没有 enableOrca —— 建完会话直接 navigate,于是
    // 「草稿开了协同」这件事被静默丢弃,进会话页才发现没有 Worker。两条路径都必须
    // 隧道到被控端起 Worker,并带 reveal 跳转。
    const sendBranch = source.slice(
      source.indexOf('if (isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {'),
    );
    const enableOrca = sendBranch.indexOf('await enableRemoteCollabForSession({');
    const setPending = sendBranch.indexOf('setPending(remoteSessionId, {', enableOrca);
    expect(enableOrca).toBeGreaterThan(-1);
    // enableOrca 必须排在首条消息交接**之前**:Lead 的第一个 turn 就要带上协同 MCP,
    // 否则用户开了协同却发现首轮 Lead 根本没有 cindy_orca 工具(与本机分支同口径)。
    expect(setPending).toBeGreaterThan(enableOrca);
    expect(sendBranch).toContain('state: dlOrcaReveal ? { orcaWorkersReveal: dlOrcaReveal } : undefined');

    const goalHandler = source.slice(source.indexOf('const handleCreateGoal = useCallback('));
    const goalEnable = goalHandler.indexOf('await enableRemoteCollabForSession({');
    const goalSetPending = goalHandler.indexOf('setPendingGoal(remoteSessionId', goalEnable);
    expect(goalEnable).toBeGreaterThan(-1);
    expect(goalSetPending).toBeGreaterThan(goalEnable);
    expect(goalHandler).toContain(
      'state: remoteGoalOrcaReveal ? { orcaWorkersReveal: remoteGoalOrcaReveal } : undefined',
    );
  });

  it('keeps both device-link enable paths on the shared remote collab helper', () => {
    // 两条路径逐字重复这段收尾正是 #807 反复踩的坑(漏改一处没有任何编译/测试信号)。
    // 收敛后组件里只剩调用,时序不变量(等 enableOrca、**不等**镜像回流 —— 后者对瞬态
    // 错误有最长约 6.75 秒退避重试,挡在交接前面就会丢掉用户的首条消息/目标文案)住在
    // remoteCollabHandoff 里,只有一处可改。
    expect(source.match(/await enableRemoteCollabForSession\(\{/g)).toHaveLength(2);
    expect(source).not.toContain('refreshRemoteDeviceSessions');
    expect(remoteCollabHandoffSource).toContain('void refreshRemoteDeviceSessions(p.deviceId)');
    expect(remoteCollabHandoffSource).not.toContain('await refreshRemoteDeviceSessions(');
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
        /draftEnableOrcaOptions\(effectiveCollab, localProviders, !localProvidersLoading\)/g,
      ) ?? [],
    ).toHaveLength(4);
  });

  it('blocks new-goal creation until a selected collaboration policy is available', () => {
    const goalHandler = source.slice(source.indexOf('const handleCreateGoal = useCallback('));
    expect(goalHandler).toContain("let policyEnabled = collabPolicy.enabled");
    expect(goalHandler).toContain("if (collabPolicy.loading)");
    expect(goalHandler).toContain("if (collabPolicy.unavailable)");
    expect(goalHandler).toContain("collabPolicy.refresh()");
    expect(goalHandler).toContain("policyEnabled = refreshed.enabled");
    expect(goalHandler).toContain("if (!policyEnabled)");
    expect(goalHandler.indexOf("if (collabPolicy.loading)")).toBeLessThan(
      goalHandler.indexOf('const newSession = await createSession'),
    );
  });

  it('carries a successful policy refresh into all collaboration creation branches', () => {
    expect(source.match(/const shouldEnableCollab =/g)).toHaveLength(2);
    // 5 = Send 普通 + Send worktree + 本机/SSH 新建目标 + device-link Send + device-link 新建目标。
    expect(source.match(/if \(shouldEnableCollab\)/g)).toHaveLength(5);
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
});
