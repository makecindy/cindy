import assert from 'node:assert/strict';

/** 会话标题栏的 DAG 开关：复用真实 SessionContentHeader / ChromeIconButton 与 ContentHeader 槽位。 */
export default {
  name: 'session-dag-header',
  entry: './dag-header-fixture.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'SessionContentHeader, ChromeIconButton (GitFork + Ellipsis), ContentHeader shell, theme and translations',
  notCovered: 'DagWorkspace canvas, plugin enablement IPC, session data and agent runtime',
  stubs: {
    'src/renderer/hooks/useCCSessions': `export const useCCSessions=()=>({sessions:[],patchLocal:()=>{}});`,
    'src/renderer/features/device-link/remoteProjectsStore': {
      partial: `export const useRemoteProjectSessions=()=>[];`,
    },
    'src/renderer/hooks/useSessionRunningStatus': `export const useSessionRunningStatus=()=>({runningSessionIds:new Set()});`,
    'src/renderer/components/ui/confirm-dialog-provider': {
      partial: `export const useConfirmDialog=()=>({confirm:async()=>true});`,
    },
    'src/renderer/features/cc-agent/hooks/useConfirmTaskArchive': `export const useConfirmTaskArchive=()=>async()=>true;`,
    'src/renderer/features/cc-agent/hooks/useSessionLifecycleActions': `export const useSessionLifecycleActions=()=>({runSessionAction:async()=>{},unarchiveSession:async()=>{}});`,
    'src/renderer/hooks/useProjectPickerOptions': `export const useProjectPickerOptions=()=>[];`,
    'src/renderer/features/scheduler/lib/scheduleSessionBinding': {
      partial: `export const useSessionBoundSchedules=()=>[];`,
    },
    // PR/分支徽标与迁移状态不属于本次标题栏开关；用空组件隔离它们的 Git watcher。
    'src/renderer/features/cc-agent/GitContextBadge': `export const GitContextBadge=()=>null;`,
    'src/renderer/features/cc-agent/TaskMigrationStatus': `export const TaskMigrationStatus=()=>null;`,
  },
  cases: {
    default: { about: 'Task title bar with the DAG icon toggle before the ellipsis' },
  },
  async ready(page) {
    await page.getByRole('button', { name: 'DAG' }).waitFor();
  },
  async check(page, ui) {
    const header = page.locator('header').first();
    const dag = page.getByRole('button', { name: 'DAG' });
    const more = page.getByRole('button', { name: await ui.t('ccAgent.sessionHeader.moreActions') });
    const title = header.getByTitle('季度复盘与发布计划');
    assert.equal(await title.count(), 1, 'real session title remains in the injected header');
    assert.equal(await more.count(), 1, 'ellipsis menu stays beside the DAG toggle');
    const headerBox = await header.boundingBox();
    const dagBox = await dag.boundingBox();
    const moreBox = await more.boundingBox();
    assert.ok(dagBox.x < moreBox.x, 'DAG toggle sits before the ellipsis');
    assert.ok(dagBox.x >= headerBox.x && moreBox.x + moreBox.width <= headerBox.x + headerBox.width,
      'both controls stay inside the real title bar');
    assert.equal(await dag.getAttribute('aria-pressed'), 'false');
    await ui.capture('closed');
    await dag.click();
    assert.equal(await page.getByTestId('dag-state').innerText(), '会话图');
    assert.equal(await dag.getAttribute('aria-pressed'), 'true');
    assert.equal(await title.count(), 1, 'title is not lost while the canvas is open');
    await ui.capture('open');
    await dag.click();
    assert.equal(await page.getByTestId('dag-state').innerText(), '原生聊天');
    assert.equal(await dag.getAttribute('aria-pressed'), 'false');
    assert.equal(await title.count(), 1, 'title is still present after closing');
    await dag.click();
    await page.getByRole('button', { name: '停用插件' }).click();
    assert.equal(await dag.count(), 0);
    assert.equal(await page.getByTestId('dag-state').innerText(), '原生聊天');
    assert.equal(await title.count(), 1);
    assert.equal(await more.count(), 1);
  },
};
