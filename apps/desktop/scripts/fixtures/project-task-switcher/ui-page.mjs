import assert from 'node:assert/strict';

const projectDir = '/demo/projects/ledger';
const worktreePath = '/demo/worktrees/reconcile-invoices';
const worktreeBranch = 'cindy/reconcile-invoices';
const worktreeTitle = 'Reconcile nightly ledger';
const currentTitle = 'Review the billing ledger release and coordinate follow-up across the entire reporting project';
const archivedTitle = 'Review earlier reporting changes';
const taskDefaults = {
  userId: 'fixture-user',
  source: 'desktop',
  workspaceKind: 'project',
  workingDir: projectDir,
  projectDir,
  model: 'fixture-model',
  effort: 'medium',
  permissionMode: 'default',
  sdkSessionId: null,
  totalTokenUsage: 0,
  totalCostUsd: 0,
  contextTokens: 0,
  contextWindow: 0,
  fastMode: false,
  clearedAt: null,
  pinnedAt: null,
  userSendAt: null,
  agentKind: 'codex',
  status: 'active',
  extraDirs: [],
  createdAt: '2026-11-05T08:00:00.000Z',
  updatedAt: '2026-11-06T08:00:00.000Z',
};
const sessions = [
  { id: 'current-task', title: currentTitle },
  { id: 'parallel-task', title: 'Investigate export timeouts', userSendAt: '2026-11-06T10:00:00.000Z' },
  { id: 'worktree-task', title: worktreeTitle, workingDir: worktreePath, worktreePath,
    source: 'bot', companion: { id: 'fixture-bot', role: 'routine' },
    userSendAt: '2026-11-06T11:00:00.000Z' },
  { id: 'archived-task', title: archivedTitle, status: 'archived',
    source: 'bot', companion: { id: 'fixture-bot', role: 'channel' } },
  { id: 'other-project', title: 'Unrelated reporting workspace', workingDir: `${projectDir}-tools`, projectDir: `${projectDir}-tools` },
  { id: 'remote-ssh', title: 'Remote SSH invoice task', remoteHostId: 'fixture-host' },
  { id: 'remote-device', title: 'Other computer invoice task', deviceLinkDeviceId: 'fixture-device' },
].map((task) => ({ ...taskDefaults, ...task }));
const worktrees = {
  'worktree-task': {
    sessionId: 'worktree-task', name: 'reconcile-invoices', path: worktreePath,
    baseRepo: projectDir, branch: worktreeBranch, sourceBranch: 'main',
    createdAt: '2026-11-06T09:00:00.000Z',
  },
};

const data = 'window.__uiPage.ctx.data';
const triggerSelector = '[data-testid="project-task-switcher-trigger"]';

function fitsHorizontally(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = range.getBoundingClientRect();
  if (text.width === 0) return false;
  for (let parent = element; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflowX === 'visible') continue;
    const bounds = parent.getBoundingClientRect();
    if (text.left < bounds.left - 1 || text.right > bounds.right + 1) return false;
  }
  return true;
}

export default {
  name: 'project-task-switcher',
  entry: './fixture.tsx',
  viewport: { width: 420, height: 460 },
  real: 'SessionContentHeader registration, ContentHeader and drag regions, ProjectTaskSwitcher, shared Radix dropdown, canonical task route resolution, themes and translations',
  notCovered: 'Local database and Worktree discovery, branch probes, schedule and teammate loading, full task page after navigation, native window drag gestures; task and Worktree snapshots are synthetic.',
  stubs: {
    'src/renderer/hooks/useCCSessions': `
      const allSessions = ${data}.sessions;
      const activeSessions = allSessions.filter((session) => session.status === 'active');
      export const useCCSessions = (options) => ({ sessions: options?.includeArchived === 'all' ? allSessions : activeSessions });
    `,
    'src/renderer/contexts/WorktreeContext': {
      partial: `export const useWorktrees = () => ${data}.worktrees; export const useObservedWorktreeForSession = () => null;`,
    },
    'src/renderer/features/bots/botStore': {
      partial: 'export const useBotProfiles = () => []; export const ensureBotProfilesLoaded = async () => [];',
    },
    'src/renderer/features/bots/botFollowScopes': { partial: 'export const useSessionDelegatingBot = () => null;' },
    'src/renderer/features/scheduler/lib/scheduleSessionBinding': { partial: 'export const useSessionBoundSchedules = () => [];' },
    'src/renderer/hooks/useProjectPickerOptions': { partial: 'export const useProjectPickerOptions = () => [];' },
    'src/renderer/hooks/useSessionRunningStatus': `
      const runningSessionIds = new Set(${data}.runningSessionIds);
      export const useSessionRunningStatus = () => ({ runningSessionIds });
    `,
    'src/renderer/hooks/useSessionGitContext': { partial: `
      const prRefs = [];
      const prStatuses = new Map();
      export const useSessionGitContext = (session) => {
        const tree = ${data}.worktrees[session.id];
        const head = session.workspaceKind === 'project' ? { kind: 'branch', branch: tree?.branch ?? 'main' } : null;
        return { head, branchSource: tree ? 'worktree' : 'workingDir', prRefs, prStatuses };
      };
    ` },
  },
  cases: {
    default: {
      about: 'A task outside a project keeps the ordinary title bar.',
      data: {
        sessions: [{ ...sessions[0], workspaceKind: 'dialogue', workingDir: null, projectDir: null }],
        worktrees: {},
        runningSessionIds: [],
      },
    },
    'same-project-switch': {
      about: 'Switch between local tasks in the same project from a narrow header, including a teammate routine in a Worktree and an archived channel task. Unrelated and remote tasks stay out.',
      data: { sessions, worktrees, runningSessionIds: ['worktree-task'] },
    },
  },
  async ready(page) {
    await page.locator('header').getByText(currentTitle, { exact: true }).waitFor();
  },
  async check(page, ui) {
    const trigger = page.getByTestId('project-task-switcher-trigger');
    if (ui.case === 'default') {
      assert.equal(await trigger.count(), 0, 'ordinary dialogue tasks do not show the project switcher');
      return;
    }
    await trigger.waitFor();
    const title = page.locator('header').getByText(currentTitle, { exact: true });
    const triggerBox = await trigger.boundingBox();
    const titleBox = await title.boundingBox();
    assert.ok(triggerBox && titleBox && triggerBox.x >= titleBox.x + titleBox.width,
      'the long task title leaves a separate switcher target');
    assert.ok(triggerBox.x + triggerBox.width <= ui.viewport.width, 'the switcher remains within the window');
    if (ui.viewport.width <= 500) {
      assert.equal(await title.evaluate((element) => element.scrollWidth > element.clientWidth), true,
        'the long title truncates in the narrow header');
    }

    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByTestId('project-task-switcher-menu');
    await menu.waitFor();
    await ui.capture('project-menu');
    const items = menu.getByRole('menuitemradio');
    assert.equal(await items.count(), 4, 'the menu contains only this project’s local tasks');
    const current = items.filter({ hasText: currentTitle });
    assert.equal(await current.getAttribute('aria-checked'), 'true');
    assert.equal(await items.first().getAttribute('aria-checked'), 'true', 'the current task comes first');
    const checkout = items.filter({ hasText: worktreeTitle });
    assert.equal(await checkout.count(), 1, 'the same-project teammate routine is available');
    assert.equal(await checkout.getByText(worktreeBranch, { exact: true }).count(), 1, 'the task shows its managed branch');
    const runningLabel = checkout.getByText(await ui.t('ccAgent.sidebar.status.running'), { exact: true });
    const archivedLabel = items.filter({ hasText: archivedTitle })
      .getByText(await ui.t('ccAgent.sidebar.taskStatus.archived'), { exact: true });
    assert.equal(await runningLabel.count(), 1, 'the running task shows its status');
    assert.equal(await archivedLabel.count(), 1,
      'the archived teammate channel task remains reachable and labeled');
    if (ui.viewport.width <= 500) {
      assert.equal(await runningLabel.evaluate(fitsHorizontally), true, 'the running label fits beside the Worktree details');
      assert.equal(await archivedLabel.evaluate(fitsHorizontally), true, 'the archived label fits in the menu');
    }
    assert.equal(await items.filter({ hasText: /Unrelated reporting workspace|Remote SSH invoice task|Other computer invoice task/ }).count(), 0);
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= ui.viewport.width + 1,
      'the menu fits inside the narrow viewport');

    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), triggerSelector);
    assert.equal(await page.getByTestId('fixture-route').textContent(), '/cc-agent/current-task');

    await page.keyboard.press('ArrowDown');
    await menu.waitFor();
    const checkoutIndex = await items.evaluateAll((rows, label) => rows.findIndex((row) => row.textContent.includes(label)), worktreeTitle);
    assert.ok(checkoutIndex >= 0);
    await page.keyboard.press('Home');
    for (let index = 0; index <= checkoutIndex; index += 1) {
      if (index > 0) await page.keyboard.press('ArrowDown');
      await page.waitForFunction((position) => document.activeElement === document.querySelectorAll(
        '[data-testid="project-task-switcher-menu"] [role="menuitemradio"]',
      )[position], index);
    }
    await page.waitForFunction((label) => document.activeElement?.textContent.includes(label), worktreeTitle);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="fixture-route"]')?.textContent === '/cc-agent/worktree-task');
    await menu.waitFor({ state: 'hidden' });
    await page.locator('header').getByText(worktreeTitle, { exact: true }).waitFor();

    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await menu.waitFor();
    assert.equal(await items.count(), 4, 'the same project tasks are available from the teammate routine header');
    assert.equal(await items.first().getAttribute('aria-checked'), 'true');
    assert.equal(await checkout.getAttribute('aria-checked'), 'true', 'the switched task becomes the current selection');
    assert.equal(await checkout.getByText(worktreeBranch, { exact: true }).count(), 1);
    assert.equal(await archivedLabel.count(), 1);
  },
};
