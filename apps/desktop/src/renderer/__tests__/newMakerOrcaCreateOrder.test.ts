import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'NewMakerDraftRoute.tsx'),
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

  it('uses the shared collaboration error i18n mapper for all three draft enable paths', () => {
    // 三条草稿起 Worker 路径都走同一个错误映射器:Send 普通、Send worktree、以及新建目标
    // (2026-07-23 新增 New Goal 路径也 honor 协同,codex P2)。
    const mappedFallbacks = source.match(/getCollaborationStartErrorMessage\(err, t, \{ continueAsSingleSession: true \}\)/g) ?? [];

    expect(mappedFallbacks).toHaveLength(3);
    expect(source).not.toContain("toast.error(t('newChat.collaboration.startFailed'");
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
    expect(source.match(/if \(shouldEnableCollab\)/g)).toHaveLength(3);
    expect(source).not.toContain('effectiveCollabEnabled');
  });

  it('surfaces initial policy loading and retries an unavailable draft toggle', () => {
    expect(source).toContain("toast.warning(t('newChat.collaboration.loadingHint'))");
    expect(source).toContain('onDisabledActivate: collabPolicy.unavailable');
    expect(source).toContain('void collabPolicy.refresh().then((policy) => {');
    expect(source).toContain('if (policy.enabled && !policy.unavailable) {');
  });
});
