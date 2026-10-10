import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

describe('mobile Orca collaboration wiring', () => {
  it('lets the session + panel open the team panel for Leads and the enable form otherwise', () => {
    const source = read('app/sessions/[sessionId].tsx');
    expect(source).toContain('useSessionOrcaCollab({');
    expect(source).toContain("contextSheetView === 'collab' && collab.isLead ? (\n            <OrcaTeamPanelView");
    expect(source).toContain('testID="session.contextSheetCollabRow"');
    expect(source).toContain('onPress={() => void collab.submitEnable()}');
    expect(source).toContain('onPress={() => void collab.submitCreate()}');
    // 点 Worker 直接进入;长按才弹管理操作。
    expect(source).toContain('onWorkerLongPress={collab.showWorkerActions}');
    expect(source).toContain('onWorkerPress={collab.openWorker}');
    expect(read('src/session/ContextSheetCollabView.tsx')).toContain('onLongPress={() => onWorkerLongPress(worker)}');
    // 「焦点」只是电脑端协同面板的展开状态,手机上不展示:协同面板既不读 focused 字段,也不引用焦点文案。
    const collabView = read('src/session/ContextSheetCollabView.tsx');
    expect(collabView).not.toMatch(/\.focused\b/);
    expect(collabView).not.toContain('session.collab.focused');
    // 运行设备不可达时状态未知:行内写「暂时无法获取状态」,右侧不再同时显示「空闲」。
    expect(collabView).toContain("trailing={worker.executionDevice?.reachable === false ? undefined : (");
  });

  it('keeps the Worker model picker separate from the task model', () => {
    const source = read('app/sessions/[sessionId].tsx');
    const start = source.indexOf('testID="session.collabModelSheet"');
    const block = source.slice(source.lastIndexOf('<ModelPickerSheet', start), start);
    expect(block).toContain('onSelect: collab.workerForm.modelPicker.select');
    expect(block).not.toContain('selectUnifiedComposerModel');
    expect(block).toContain('onClosed={collab.workerForm.modelPicker.closed}');
    expect(block).toContain('collab.workerForm.maker.getCapabilities(agent)');
    expect(block).toContain('providersReady={collabDeviceProviders.ready}');
    expect(block).toContain('pricing={collabModelPricing}');
  });

  it('wires execution-device selection and the target model catalog in both creation entry points', () => {
    for (const [file, form] of [['app/sessions/[sessionId].tsx', 'collab.workerForm'], ['app/sessions/new.tsx', 'collabForm']]) {
      const source = read(file!);
      expect(source).toContain(`executionDevices={${form}.executionDevices}`);
      expect(source).toContain(`const collabWorkerDeviceId = ${form}.form.executionDeviceId`);
      expect(source).toContain('useDeviceProviders(collabWorkerDeviceId');
      expect(source).toContain(`onPickDirectory={${form}.directoryPicker.openPicker}`);
      expect(source).toContain(`<OrcaWorkerDirectoryPicker picker={${form}.directoryPicker}`);
    }
    const source = read('src/session/ContextSheetCollabView.tsx');
    expect(source).toContain('<ContextSheetSelectRow');
    expect(source).toContain('session.collab.remoteDirChat');
    expect(source).toContain('session.collab.remoteDirPath');
  });

  it('shows a collaboration bar for Leads and a way back to the Lead for Workers', () => {
    const source = read('app/sessions/[sessionId].tsx');
    expect(source).toContain('testID="session.collabBar"');
    expect(source).toContain('collab.openLead();');
    // 断线期间首次查询失败时,重连后补查 Worker 所属 Lead 与团队。
    expect(source).toContain("prefsScope: outboxOwner.accountKey || null,\n    connectionEpoch,");
    expect(source).toContain('takeOrcaStartFailure(sessionId)');
    expect(source).toContain('return subscribeOrcaStartFailure((failedSessionId) => {');
  });

  it('gives Worker tasks a Worker-only header and details menu', () => {
    const page = read('app/sessions/[sessionId].tsx');
    // 右上角只留「更多」:不出远程桌面 / 文件夹。
    expect(page).toContain("const workerHeader = currentSession?.orcaRole === 'worker';");
    expect(page).toContain('detailsOnly={workerHeader}');
    expect(page).toContain('{workerHeader ? null : (');
    expect(page).toContain('worker={collab.isWorker ? {');
    const menu = read('src/session/SessionMenuSheet.tsx');
    expect(menu).toContain("const workerMode = !messageOnly && session.orcaRole === 'worker';");
    expect(menu).toContain('const listedActions = workerMode ? [] : mainActions;');
    expect(menu).toContain('{onOpenSearch && !workerMode ? (');
    expect(menu).toContain('{!messageOnly && !workerMode && (');
    expect(menu).toContain('{workerMode ? null : !messageOnly && isSharedTaskPeer');
    // 归档确认在面板仍展开时弹出(iOS 原生 sheet 收起中弹 Alert 会丢),确认后再收起。
    expect(menu).toContain('const archive = () => onArchive(onClose);');
    // Worker 详情只有归档:不再有返回 Lead / 设为焦点。
    expect(page).not.toContain('onOpenLead:');
    expect(page).not.toContain('onSetFocus:');
  });

  it('keeps Worker lifecycle on the Orca path instead of the generic task menu', () => {
    const source = read('src/session/SessionMenuSheet.tsx');
    expect(source).toContain("const lifecycleHidden = sharedGuest || session.orcaRole === 'worker';");
    expect(source).toContain("{!messageOnly && session.orcaRole !== 'worker' &&");
  });

  it('starts new-task collaboration after create with the pending Lead input as Worker context', () => {
    const source = read('app/sessions/new.tsx');
    expect(source).toContain('buildDraftWorkerInitialTask(collabDraft.initialTask, effectiveDraft.firstMessage)');
    expect(source).toContain('buildDraftWorkerInitialTask(collabDraft.initialTask, input.objective)');
    // 目标路径:协同在 goal.set 之前开启,首轮目标 Lead 才有协同工具。
    expect(source.indexOf('await enableOrcaTeam(maker, result.sessionId'))
      .toBeLessThan(source.indexOf('await maker.goal.set({ sessionId: result.sessionId'));
    expect(source).toContain('setCollabDraft(null);');
    // 目标路径:getSession 失败走兜底时也保留 Lead 身份。
    expect(source).toContain("if (collabEnabled && session.orcaRole !== 'lead') session = { ...session, orcaRole: 'lead' };");
    expect(source).toContain('prefsScope: outboxOwner.accountKey || null,');
    // create-failed「返回编辑」带回协同草稿;目标比对防止恢复时被「换目标即清」误清。
    expect(source).toContain('if (collabDraftTargetRef.current !== collabTargetKey) setCollabDraft(null);');
    expect(source).toContain('if (stashed.collabDraft && stashed.deviceId) {');
  });
});
