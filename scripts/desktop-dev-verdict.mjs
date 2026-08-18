import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveDesktopDevRegion } from './shared/desktop-dev-region.mjs';

export const DESKTOP_DEV_VERDICT_PREFIX = 'DESKTOP_DEV_VERDICT';
export const WORKTREE_ISOLATED_ARG = '--isolated=@worktree';
const WORKTREE_NAME_DIGEST_LEN = 6;

const VERDICT_FIELDS = Object.freeze([
  'code',
  'mode',
  'sandbox',
  'root',
  'commit',
  'pid',
  'region',
  'message',
  'next',
]);

const SHARED_FAILURE_CODES_WITH_ISOLATED_NEXT = new Set([
  'MIGRATION_POLICY',
  'PRESERVE_RUNNING_INCOMPATIBLE',
  'STARTUP_TIMEOUT',
  'MIGRATE_FAILED',
  'WHOAMI_MISMATCH',
  'STARTUP_FAILED',
  'DEV_PROCESS_EXITED',
  'AUTH_INIT_FAILED',
  'HOSTED_SHARED_REFUSED',
]);

function normalizeRoot(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function worktreeHashKey(rootDir, foldCase) {
  const resolved = path.resolve(rootDir).replaceAll('\\', '/');
  return foldCase ? resolved.toLowerCase() : resolved;
}

function singleLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function isolationNameFromWorktree(rootDir, { foldCase } = {}) {
  const resolved = path.resolve(rootDir);
  let name = path.basename(resolved);
  name = name.replace(/^cindy-/i, '');
  name = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) name = 'worktree';
  const shouldFold = foldCase ?? process.platform !== 'linux';
  const digest = createHash('sha256')
    .update(worktreeHashKey(resolved, shouldFold))
    .digest('hex')
    .slice(0, WORKTREE_NAME_DIGEST_LEN);
  const maxBase = 32 - 1 - digest.length;
  const base = name.slice(0, maxBase).replace(/-+$/g, '') || 'wt';
  return `${base}-${digest}`;
}

export function isolatedRestartNextCommand({ local = false, region } = {}) {
  const script = local ? 'restart:desktop:local' : 'restart:desktop:remote';
  const regionArg = region && region !== 'global' ? ` --region=${region}` : '';
  return `pnpm ${script}${regionArg} -- --isolated=@worktree`;
}

export const ISOLATED_RESTART_NEXT = isolatedRestartNextCommand();

export function restartContextFromArgv(argv = [], env = process.env) {
  let region;
  try {
    region = resolveDesktopDevRegion(argv, env);
  } catch {
    region = undefined;
  }
  return {
    isolated: argv.some((arg) => arg === '--isolated' || arg.startsWith('--isolated='))
      || env.XDT_ISOLATED === '1',
    local: argv.includes('--local'),
    region,
  };
}

export function resolveIsolatedArg(isolatedArg, rootDir, options) {
  if (isolatedArg === WORKTREE_ISOLATED_ARG) {
    return `--isolated=${isolationNameFromWorktree(rootDir, options)}`;
  }
  return isolatedArg;
}

export function shouldSuggestIsolatedNext({ isolated, code } = {}) {
  return !isolated && SHARED_FAILURE_CODES_WITH_ISOLATED_NEXT.has(code);
}

export function inferDesktopDevFailureCode(message) {
  const text = String(message ?? '');
  const tagged = text.match(/\[([A-Z][A-Z0-9_]*)\]/);
  if (tagged) return tagged[1];
  if (/cannot run migration artifacts/i.test(text)) return 'MIGRATION_POLICY';
  if (/already in use by another checkout/i.test(text)) return 'USERDATA_IN_USE';
  if (/cannot share official userData while hosted/i.test(text)) return 'HOSTED_SHARED_REFUSED';
  if (/Refusing to restart from within|running inside an Cindy desktop dev process tree/i.test(text)) {
    return 'HOSTED_RESTART_REFUSED';
  }
  if (/--preserve-running cannot/i.test(text)) return 'PRESERVE_RUNNING_INCOMPATIBLE';
  if (/--isolated cannot use the official/i.test(text)) return 'ISOLATED_OFFICIAL_PROFILE';
  if (/did not finish window\/auth\/database startup/i.test(text)) return 'STARTUP_TIMEOUT';
  if (/Invalid --isolated name/i.test(text)) return 'INVALID_ISOLATED_NAME';
  if (/root\/commit\/ready did not match|Desktop dev process is not running/i.test(text)) {
    return 'WHOAMI_MISMATCH';
  }
  if (/failed with exit/i.test(text)) return 'STARTUP_FAILED';
  return 'STARTUP_FAILED';
}

export function formatDesktopDevVerdict(verdict) {
  const state = verdict?.state === 'ready' ? 'ready' : 'failed';
  const lines = [`${DESKTOP_DEV_VERDICT_PREFIX}=${state}`];
  for (const key of VERDICT_FIELDS) {
    const value = verdict?.[key];
    if (value == null || value === '') continue;
    lines.push(`${key}=${singleLine(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function printDesktopDevVerdict(verdict, writer = console.log) {
  writer(formatDesktopDevVerdict(verdict).trimEnd());
}

function isolatedNextIfNeeded(context, code) {
  return shouldSuggestIsolatedNext({ isolated: context.isolated, code })
    ? { next: isolatedRestartNextCommand(context) }
    : {};
}

export function buildDesktopDevVerdictFromWhoami(report, context = {}) {
  const expectedRoot = report?.expected?.rootDir;
  const expectedCommit = report?.expected?.commit ?? null;
  const instances = Array.isArray(report?.instances) ? report.instances : [];
  const matched = instances.find((instance) =>
    expectedRoot
    && normalizeRoot(instance.rootDir) === normalizeRoot(expectedRoot)
    && instance.ready === true
    && instance.commitVerified === true
    && instance.commit === expectedCommit);

  if (report?.match && matched) {
    return {
      state: 'ready',
      mode: matched.isolated === true || context.isolated ? 'isolated' : 'shared',
      ...(context.sandbox ? { sandbox: context.sandbox } : {}),
      root: expectedRoot,
      commit: expectedCommit,
      pid: matched.pid,
      ...(matched.region ? { region: matched.region } : {}),
    };
  }

  const code = 'WHOAMI_MISMATCH';
  return {
    state: 'failed',
    code,
    message: instances.length === 0
      ? 'Desktop dev process is not running for this checkout.'
      : 'Desktop dev is running but root/commit/ready did not match this checkout.',
    mode: context.isolated ? 'isolated' : 'shared',
    ...(context.sandbox ? { sandbox: context.sandbox } : {}),
    root: expectedRoot,
    commit: expectedCommit,
    ...isolatedNextIfNeeded(context, code),
  };
}

export function buildDesktopDevVerdictFromFailure(error, context = {}) {
  const status = error?.startupStatus && typeof error.startupStatus === 'object'
    ? error.startupStatus
    : null;
  const message = status?.message
    || (error instanceof Error ? error.message : String(error ?? 'Desktop dev failed to start'));
  const code = context.code
    || (typeof status?.code === 'string' ? status.code : inferDesktopDevFailureCode(message));
  return {
    state: 'failed',
    code,
    message,
    mode: context.isolated ? 'isolated' : 'shared',
    ...(context.sandbox ? { sandbox: context.sandbox } : {}),
    ...(context.rootDir ? { root: context.rootDir } : {}),
    ...isolatedNextIfNeeded(context, code),
  };
}
