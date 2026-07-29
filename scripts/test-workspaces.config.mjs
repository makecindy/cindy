import os from 'node:os';

const vitestBin = (...args) => ({ type: 'packageBin', bin: 'vitest', args });
// Workspace-level parallelism owns the global process budget. Keep ordinary
// Vitest workspaces at one worker each so outer concurrency cannot multiply
// every child process's default CPU-sized pool.
const unitVitestCommand = (workers = 1) => vitestBin('run', `--maxWorkers=${workers}`);
const noCollectableTestsReason = 'No collectable tests yet. Add tests and mark a tier required when this workspace gains testable logic.';
const desktopDbInclude = [
  'src/main/localDb/**/__tests__/*.test.ts',
  'src/main/scheduler-host/__tests__/*.db.test.ts',
  'src/main/__tests__/schemaDriftRepair.test.ts',
  'src/main/__tests__/betterSqliteFactory.test.ts',
  'src/main/__tests__/codexHistoryPromptInit.test.ts',
  'src/main/__tests__/orcaStaleIndexCleanup.test.ts',
  'src/main/__tests__/*LocalSessions.test.ts',
];
const desktopDbExclude = [
  'src/main/localDb/__tests__/migrationReplay.test.ts',
  'src/main/localDb/__tests__/drizzle-proxy-perf.test.ts',
];
const desktopGitIntegrationInclude = [
  'src/main/**/*.git-integration.test.ts',
];

export function desktopUnitWorkerCount(
  availableParallelism = os.availableParallelism(),
) {
  const available = Number.isFinite(availableParallelism)
    ? Math.floor(availableParallelism)
    : 1;
  return Math.max(1, Math.min(8, available));
}

const noCollectableWorkspace = (name, cwd, reason = noCollectableTestsReason) => ({
  name,
  cwd,
  status: 'notApplicable',
  reason,
  tiers: {},
});

const requiredUnitWorkspace = (name, cwd, { workers = 1, execution } = {}) => ({
  name,
  cwd,
  status: 'required',
  tiers: {
    unit: {
      status: 'required',
      ...(execution ? { execution } : {}),
      command: unitVitestCommand(workers),
    },
  },
});

export default {
  workspaces: [
    {
      name: 'desktop',
      cwd: 'apps/desktop',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          execution: 'exclusive',
          // Desktop unit tests spawn many Git/filesystem subprocesses. Benchmarking
          // found eight workers to be the best complexity/resource tradeoff.
          // Lower-CPU hosts stay capped by their available parallelism.
          // It runs exclusively so these workers never overlap outer workspaces.
          command: vitestBin('run', `--maxWorkers=${desktopUnitWorkerCount()}`),
          exclude: [
            '**/*.git-integration.test.ts',
            'src/main/localDb/**',
            'src/main/__tests__/*Migration.test.ts',
            'src/main/__tests__/schemaDriftRepair.test.ts',
            'src/main/__tests__/betterSqliteFactory.test.ts',
            'src/main/__tests__/*LocalSessions.test.ts',
            'src/main/__tests__/codexHistoryPromptInit.test.ts',
            'src/main/__tests__/orcaStaleIndexCleanup.test.ts',
            'src/main/scheduler-host/__tests__/*.db.test.ts',
            'src/main/__tests__/directSessionSendGuard.test.ts',
            'src/main/__tests__/makerSendToSessionOrdering.test.ts',
            '**/*.bench.ts',
          ],
        },
        'git-integration': {
          status: 'manual',
          reason: 'Full real-Git coverage is explicit because it spawns hundreds of local subprocesses and is coordinated across worktrees.',
          execution: 'exclusive',
          coverage: 'allowlist',
          command: vitestBin('run', `--maxWorkers=${desktopUnitWorkerCount()}`),
          include: desktopGitIntegrationInclude,
        },
        db: {
          status: 'manual',
          reason: 'Desktop DB tests remain an explicit DB tier because they bootstrap runtime assets and cover localDb behavior outside fast unit.',
          coverage: 'allowlist',
          preflight: [
            { type: 'packageScript', script: 'ensure-deps' },
            { type: 'packageScript', script: 'ensure-dev-runtime-assets' },
          ],
          command: vitestBin('run'),
          include: desktopDbInclude,
          exclude: desktopDbExclude,
        },
        migration: {
          status: 'manual',
          reason: 'Migration replay remains an explicit DB tier because it replays SQLite history fixtures outside fast unit.',
          coverage: 'allowlist',
          preflight: [
            { type: 'packageScript', script: 'ensure-deps' },
            { type: 'packageScript', script: 'ensure-dev-runtime-assets' },
          ],
          command: vitestBin('run'),
          include: [
            'src/main/localDb/__tests__/migrationReplay.test.ts',
            'src/main/__tests__/*Migration.test.ts',
          ],
        },
        'db-perf': {
          status: 'manual',
          reason: 'DB proxy performance is intentionally explicit because strict timing is host-sensitive.',
          coverage: 'allowlist',
          command: { type: 'packageScript', script: 'test:db-proxy-perf' },
          include: ['src/main/localDb/__tests__/drizzle-proxy-perf.test.ts'],
        },
        guard: {
          status: 'required',
          coverage: 'allowlist',
          command: vitestBin('run'),
          include: [
            'src/main/__tests__/directSessionSendGuard.test.ts',
            'src/main/__tests__/makerSendToSessionOrdering.test.ts',
          ],
        },
      },
    },
    // Mobile has enough test files to become the critical path at one worker.
    // Give it the full worker budget, but never overlap it with other workspaces.
    requiredUnitWorkspace('mobile', 'apps/mobile', { workers: 4, execution: 'exclusive' }),
    requiredUnitWorkspace('@cindy/anthropic-compat-proxy', 'packages/anthropic-compat-proxy'),
    requiredUnitWorkspace('@cindy/anthropic-responses-bridge', 'packages/anthropic-responses-bridge'),
    requiredUnitWorkspace('@cindy/responses-chat-bridge', 'packages/responses-chat-bridge'),
    requiredUnitWorkspace('@cindy/auth-client', 'packages/auth-client'),
    requiredUnitWorkspace('@cindy/browser-control-runtime', 'packages/browser-control-runtime'),
    requiredUnitWorkspace('cindy-tools', 'packages/cindy-tools'),
    requiredUnitWorkspace('@cindy/device-link', 'packages/device-link'),
    noCollectableWorkspace('@cindy/embedding-client', 'packages/embedding-client'),
    requiredUnitWorkspace('@cindy/file-browser-core', 'packages/file-browser-core'),
    noCollectableWorkspace('@cindy/github-client', 'packages/github-client'),
    noCollectableWorkspace('@cindy/gitlab-client', 'packages/gitlab-client'),
    noCollectableWorkspace('@cindy/heartbeat-client', 'packages/heartbeat-client'),
    requiredUnitWorkspace('@cindy/im', 'packages/lizi-im'),
    requiredUnitWorkspace('@cindy/mcps', 'packages/lizi-mcps'),
    requiredUnitWorkspace('@cindy/maker-cc-manager', 'packages/maker-cc-manager'),
    requiredUnitWorkspace('@cindy/maker-core', 'packages/maker-core'),
    requiredUnitWorkspace('@cindy/maker-remote-ssh', 'packages/maker-remote-ssh'),
    requiredUnitWorkspace('@cindy/maker-scheduler', 'packages/maker-scheduler'),
    requiredUnitWorkspace('@cindy/maker-shared', 'packages/maker-shared'),
    requiredUnitWorkspace('@cindy/model-providers', 'packages/model-providers'),
    {
      name: '@cindy/orca-workflow',
      cwd: 'packages/orca-workflow',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          command: unitVitestCommand(),
          include: ['src/__tests__/**/*.test.ts'],
        },
      },
    },
    noCollectableWorkspace('project-context', 'packages/project-context'),
    requiredUnitWorkspace('@cindy/remote-file-service', 'packages/remote-file-service'),
    requiredUnitWorkspace('@cindy/voice-input-core', 'packages/voice-input-core'),
    requiredUnitWorkspace('@cindy/wechat-ilink', 'packages/wechat-ilink'),
    noCollectableWorkspace('@cindy/device-link-protocol', 'cindy-protocol/packages/device-link-protocol'),
    requiredUnitWorkspace('@cindy/model-access-protocol', 'cindy-protocol/packages/model-access-protocol'),
    requiredUnitWorkspace('@cindy/plugin-protocol', 'cindy-protocol/packages/plugin-protocol'),
    requiredUnitWorkspace('@cindy/skill-protocol', 'cindy-protocol/packages/skill-protocol'),
    requiredUnitWorkspace('@cindy/slack-hook-protocol', 'cindy-protocol/packages/slack-hook-protocol'),
    requiredUnitWorkspace('@cindy/voice-protocol', 'cindy-protocol/packages/voice-protocol'),
  ],
};
