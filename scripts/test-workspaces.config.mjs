import os from 'node:os';

import { nodeWebstorageEnabled } from './shared/node-webstorage.mjs';

const vitestBin = (...args) => ({ type: 'packageBin', bin: 'vitest', args });
// The unit tier pins the threads pool. Vitest's default `forks` pool keeps
// `isolate` on and so recycles a child process per test file: this tier's ~1845
// files cost ~1.9k process spawns per gate run, measured at 21 LaunchServices
// check-ins/second on an 18-core macOS host. On 2026-07-30 that sustained churn
// took down macOS 27.0 beta's launchservicesd, which came back with an empty
// running-application registry — leaving the session with no frontmost app at
// all: no menu bar, no keyboard input anywhere, Dock tiles vanishing on click,
// and only a reboot to recover. Worker threads keep the same per-file isolation
// at zero process cost (same 180 desktop files: 189 check-ins versus 1,
// identical results, slightly faster).
//
// Not everything moves. The heavy manual tiers (db, migration, git-integration)
// stay on the default pool: they bootstrap runtime assets and drive real
// Git/SQLite subprocesses, and none sits on the PR gate path. A workspace also
// opts out when its tests cannot survive a worker thread; the known blockers
// are recorded at their call site below — desktop needs the webstorage flag on a
// Node that installs those globals, and the flag cannot coexist with worker
// threads (scripts/shared/node-webstorage.mjs), while maker-core fakes HOME,
// which a worker cannot see because `process.env` there is a thread-local copy
// while `os.homedir()` reads the real environment through libuv.
//
// win32 opts desktop out wholesale: on Windows (Node 24.14.1, 2026-07-30) the
// desktop suite under threads segfaulted the whole vitest process (exit 139)
// on 2 of 2 runs — same native-addon-finalizer-in-isolate-teardown crash
// class node-webstorage.mjs documents, only without execArgv in play — while
// forks passed 15651 tests twice in a row. The churn this pool exists to
// avoid is a LaunchServices problem; Windows has no launchservicesd, so forks
// costs it nothing.
//
// Keep every opt-out listed in the pool regression test, and keep the list
// short: at 1330 of this tier's 1845 files, desktop alone decides whether the
// churn is a trickle or back to where it started.
const UNIT_POOL_DEFAULT = 'threads';
const UNIT_TEST_SHARD_ENV = 'XDT_UNIT_TEST_SHARD';

/**
 * Split every Vitest workspace by the same CI shard so the two Windows jobs
 * still form one complete unit gate. The runner adds `passWithNoTests` only
 * when a workspace has fewer selected files than the configured shard count.
 */
export function unitTestShardArgs(value = process.env[UNIT_TEST_SHARD_ENV]) {
  if (value == null || String(value).trim() === '') return [];
  const normalized = String(value).trim();
  const match = /^(\d+)\/(\d+)$/.exec(normalized);
  if (!match) throw new Error(`${UNIT_TEST_SHARD_ENV} must use <index>/<count>`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < 1 || index > count) {
    throw new Error(`${UNIT_TEST_SHARD_ENV} must satisfy 1 <= index <= count`);
  }
  return [`--shard=${index}/${count}`];
}

// Workspace-level parallelism owns the global process budget. Keep ordinary
// Vitest workspaces at one worker each so outer concurrency cannot multiply
// every child process's default CPU-sized pool.
const unitVitestCommand = (workers = 1, pool = UNIT_POOL_DEFAULT) =>
  vitestBin('run', `--pool=${pool}`, `--maxWorkers=${workers}`, ...unitTestShardArgs());
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

const requiredUnitWorkspace = (name, cwd, { workers = 1, execution, pool } = {}) => ({
  name,
  cwd,
  status: 'required',
  tiers: {
    unit: {
      status: 'required',
      ...(execution ? { execution } : {}),
      command: unitVitestCommand(workers, pool),
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
          // The pool follows the webstorage flag, because the flag cannot
          // coexist with worker threads — see scripts/shared/node-webstorage.mjs
          // for the crash it causes and the measurements. On Node 22, which is
          // what local dev and CI run, the flag is a no-op, so this suite's 1330
          // files take threads and stop spawning a process each. On a
          // webstorage-enabled Node the flag wins and the suite stays on forks.
          // win32 stays on forks unconditionally — threads segfaults there and
          // the churn threads exists to avoid is macOS-only (see the pool note
          // at the top of this file).
          command: unitVitestCommand(
            desktopUnitWorkerCount(),
            nodeWebstorageEnabled() || process.platform === 'win32'
              ? 'forks'
              : 'threads',
          ),
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
    requiredUnitWorkspace('@cindy/responses-anthropic-bridge', 'packages/responses-anthropic-bridge'),
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
    requiredUnitWorkspace('@cindy/ios-simulator-runtime', 'packages/ios-simulator-runtime'),
    requiredUnitWorkspace('@cindy/maker-cc-manager', 'packages/maker-cc-manager'),
    // Stays on forks: palette-scanner's tests stub HOME and the scanner resolves
    // it through os.homedir(), which a worker thread cannot see (see
    // UNIT_POOL_DEFAULT above).
    requiredUnitWorkspace('@cindy/maker-core', 'packages/maker-core', { pool: 'forks' }),
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
    requiredUnitWorkspace('@cindy/slack-hook-protocol', 'cindy-protocol/packages/slack-hook-protocol'),
  ],
};
