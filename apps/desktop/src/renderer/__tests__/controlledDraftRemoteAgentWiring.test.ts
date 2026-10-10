/**
 * 远程控制下新建任务:Agent 也能在第三台电脑运行(2026-10-09 用户反馈:新建任务时选了远程电脑,
 * 模型列表里选不到远程供应商,只有选本机才选得到;手机新建任务已经能选)。
 *
 * 场景:同账号 A(本机,控制端)、B(新任务建在这台)、C(开了「允许被远程调用」的电脑)。锁住
 * 草稿页与输入框的几条接线:
 *   1. 只有 B 的供应商目录带「允许被远程调用」标记(认得 create-session 的 agentDeviceId)时才开放,
 *      共享任务访客与 SSH 不开放;候选电脑去掉 B 本身,不并入 A 收到的分享;
 *   2. 选了 C 时草稿的模型目录跟着 C,B 的新建草稿记忆不被写进 C 的模型;
 *   3. 建任务时把 agentDeviceId 交给 B(普通发送与新建目标两条路径);
 *   4. 输入框的模型面板先列 B 的目录与它的镜像记忆,再列 C。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n');

const draftRouteSource = read('../features/cc-agent/NewMakerDraftRoute.tsx');
const chatInputSource = read('../components/new-chat/ChatInput.tsx');

describe('草稿页:建到被控电脑的任务也能选第三台电脑', () => {
  it('被控电脑认得 agentDeviceId 才开放;共享任务访客与 SSH 不开放', () => {
    const start = draftRouteSource.indexOf('const deviceLinkRemoteAgentSupported =');
    expect(start).toBeGreaterThan(0);
    const block = draftRouteSource.slice(start, draftRouteSource.indexOf(';\n', start));
    expect(block).toContain('!isSharedTaskPeer(effectiveDeviceLinkDeviceId)');
    expect(block).toContain('controlledComputerSupportsRemoteAgent(deviceLinkHostProviders)');
    // 已选好的另一台电脑在被控电脑目录暂时读不到时继续生效(不在两份目录之间来回重种)。
    expect(block).toContain('(draft.agentDeviceId != null && deviceLinkHostProviders.length === 0)');
    expect(draftRouteSource).toContain(
      'const { providers: deviceLinkHostProviders } = useDeviceProviders(effectiveDeviceLinkDeviceId);',
    );
    const agentStart = draftRouteSource.indexOf('const effectiveAgentDeviceId =');
    const agentBlock = draftRouteSource.slice(agentStart, draftRouteSource.indexOf(';\n', agentStart));
    expect(agentBlock).toContain('!effectiveRemoteHostId');
    expect(agentBlock).toContain('(!effectiveDeviceLinkDeviceId || deviceLinkRemoteAgentSupported)');
  });

  it('候选电脑去掉被控电脑本身,不并入本机收到的分享;不支持时不传', () => {
    const start = draftRouteSource.indexOf('const remoteAgentDevices = useMemo(() => {');
    expect(start).toBeGreaterThan(0);
    const branchEnd = draftRouteSource.indexOf(': undefined;', start);
    const controlledBranch = draftRouteSource.slice(start, branchEnd);
    expect(controlledBranch).toContain('if (effectiveDeviceLinkDeviceId) {');
    expect(controlledBranch).toContain('selectControlledTaskAgentDevices({');
    expect(controlledBranch).toContain('controlledDeviceId: effectiveDeviceLinkDeviceId,');
    expect(controlledBranch).not.toContain('providerShareDevices');
  });

  it('选了另一台电脑时模型目录跟着那台', () => {
    expect(draftRouteSource).toContain(
      'const catalogDeviceId = effectiveAgentDeviceId ?? effectiveDeviceLinkDeviceId;',
    );
  });

  it('不把另一台电脑的模型写进被控电脑的新建草稿记忆,也不跟被控电脑的档位推送', () => {
    const push = draftRouteSource.indexOf('const pushActiveDraftPref = useCallback(');
    expect(push).toBeGreaterThan(0);
    const guard = draftRouteSource.indexOf(
      'if (effectiveAgentDeviceId && !options?.taskComputerSelection) return;',
      push,
    );
    const invoke = draftRouteSource.indexOf("'maker:apply-new-maker-draft-pref'", push);
    expect(guard).toBeGreaterThan(push);
    expect(invoke).toBeGreaterThan(guard);
    expect(draftRouteSource).toContain('if (capabilities && !effectiveAgentDeviceId) {');
  });

  it('权限在被控电脑上生效:换 Agent 所在电脑沿用被控电脑草稿的权限档,被夹掉时也不掺本机偏好', () => {
    expect(draftRouteSource).toContain(
      "(isAgentDeviceDraft && !isDeviceLinkDraft) || remoteDraftState.status === 'ready';",
    );
    expect(draftRouteSource).toContain('? { ...recalled, permissionMode: taskComputerPermission }');
    expect(draftRouteSource).toContain(
      '...(taskComputerPermission ? { permissionMode: taskComputerPermission } : {}),',
    );
    const start = draftRouteSource.indexOf('const chatInitialPermissionMode = isDeviceLinkDraft');
    const block = draftRouteSource.slice(start, draftRouteSource.indexOf(';\n', start));
    const remote = block.indexOf('remoteDraftState.value?.permissionMode');
    const local = block.indexOf('chatPrefs.permissionMode)');
    expect(remote).toBeGreaterThan(0);
    expect(local).toBeGreaterThan(remote);
  });

  it('来源与协同 Worker 只用那台电脑开放了远程调用的供应商(那台是最终裁决方)', () => {
    expect(draftRouteSource).toContain(
      '() => (effectiveAgentDeviceId ? remoteAgentProviders(deviceProviders) : deviceProviders),',
    );
    // 两次提交给被控电脑 + 默认来源解析。
    expect(draftRouteSource.split('deviceProviders: agentCatalogProviders,').length - 1).toBe(2);
    const initialProvider = draftRouteSource.indexOf('const chatInitialProviderId = useMemo');
    expect(
      draftRouteSource.slice(initialProvider, initialProvider + 400),
    ).toContain('effectiveSourceIdForModel(\n      agentCatalogProviders,');
    // 远程协同(普通发送与新建目标)按同一份收窄。
    expect(
      draftRouteSource.match(/draftEnableOrcaOptions\(\s*effectiveCollab,\s*agentCatalogProviders,/g),
    ).toHaveLength(2);
  });

  it('选回被控电脑的模型:这次选择作为被控电脑目录的种子并写穿被控端,不写本机草稿', () => {
    const start = draftRouteSource.indexOf(
      'if (switchesAgentDevice && isDeviceLinkDraft && effectiveDeviceLinkDeviceId) {',
    );
    expect(start).toBeGreaterThan(0);
    const branch = draftRouteSource.slice(start, draftRouteSource.indexOf('return;', start));
    expect(branch).toContain('seedSwitchedCatalog(effectiveDeviceLinkDeviceId);');
    expect(branch).toContain('{ taskComputerSelection: true },');
    expect(branch).toContain('patchDraft({ agentDeviceId: null, agentDeviceName: null });');
    expect(branch).not.toContain('patchVendorPrefs(');
  });

  it('同一台被控电脑重新验证时不拿它的能力快照覆盖另一台电脑的选择', () => {
    expect(draftRouteSource).toContain(
      'if (req.remoteSnapshot && !deviceChanged && effectiveAgentDeviceId) {',
    );
  });

  it('普通发送与新建目标都把 agentDeviceId 交给被控电脑', () => {
    expect(draftRouteSource.split('agentDeviceId: effectiveAgentDeviceId,').length - 1).toBe(2);
  });

  it('两条标识都显示:上一条写任务在哪台,下一条写 Agent 在哪台', () => {
    expect(draftRouteSource).toContain("? 'ccAgent.draft.agentDeviceElsewhereBanner'");
    const deviceBanner = draftRouteSource.indexOf("t('ccAgent.draft.remoteDialogueBanner'");
    const agentBanner = draftRouteSource.indexOf("'ccAgent.draft.agentDeviceElsewhereBanner'");
    expect(agentBanner).toBeGreaterThan(deviceBanner);
  });
});

describe('输入框:草稿的模型面板', () => {
  it('建到被控电脑的草稿也给远程 Agent 入口,先列被控电脑的目录与它的镜像记忆', () => {
    const start = chatInputSource.indexOf(
      'const remoteAgentOptions = useMemo<RemoteAgentSelectorOptions | undefined>(',
    );
    expect(start).toBeGreaterThan(0);
    const block = chatInputSource.slice(start, chatInputSource.indexOf('\n  );\n', start));
    expect(block).toContain('!sessionId &&');
    expect(block).toContain('agentLocationAware &&');
    expect(block).not.toContain('!deviceLinkDeviceId');
    expect(block).toContain('...(deviceLinkDeviceId ? { homeDeviceId: deviceLinkDeviceId } : {}),');
    expect(block).toContain(
      '...(taskComputerModelMemory ? { localModelMemory: taskComputerModelMemory } : {}),',
    );
  });

  it('选回任务所在电脑时档位记进那份记忆(被控电脑的镜像),不写本机预设', () => {
    const start = chatInputSource.indexOf('const handleUnifiedDraftSelect = useCallback(');
    const block = chatInputSource.slice(start, chatInputSource.indexOf('onUnifiedDraftSelect?.({', start));
    expect(block).toContain(': taskComputerModelMemory;');
    expect(block).not.toContain(': LOCAL_MODEL_MEMORY;');
  });
});
