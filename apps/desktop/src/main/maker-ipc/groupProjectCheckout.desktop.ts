/** Desktop wiring of the managed group checkouts (groupProjectCheckout.ts): git, Cindy's GitHub sign-in, projects. */
import { execFile } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { getActiveDataOwnerPushStamp, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { GitRunError, runGit } from '../git-review/gitRunner.js';
import { resolveGhBinary } from '../git-context/ghBinary.js';
import { onGithubConnectionChanged, openGithubSignIn, readGithubConnection } from '../git-context/githubSetupIpc.js';
import { upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { restoreLocalProjectVisibility } from '../sidebarSettingsStore.js';
import { isTrustedAppRendererWindow } from '../security/trustedAppRenderer.js';
import { createGroupProjectCheckouts } from './groupProjectCheckout.js';

type Log = { warn: (message: string, meta?: Record<string, unknown>) => void };

/** The first `git` on PATH, as `spawn('git')` would run it. */
function gitOnPath(): string | null {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd', 'git'] : ['git'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
    for (const name of names) if (existsSync(path.join(dir, name))) return path.join(dir, name);
  return null;
}

export function createDesktopGroupProjectCheckouts(log?: Log) {
  return createGroupProjectCheckouts({
    root: () => {
      // Never a stand-in folder while the account is switching.
      if (isAppSessionBoundaryPending()) throw new Error('OWNER_CHANGED');
      return ownerScopedUserDataPath('projects', 'github');
    },
    git: async (args, { cwd, timeoutMs }) => {
      try {
        // gh's saved sign-in only, never a token from the environment Cindy was started with.
        return await runGit(args, { ...(cwd ? { cwd } : {}), timeoutMs, extraEnv: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GCM_INTERACTIVE: 'never' } });
      } catch (error) {
        if (error instanceof GitRunError && error.exitCode !== null) return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
        if (error instanceof GitRunError && !error.cause) return { exitCode: -1, stdout: error.stdout, stderr: error.stderr };
        throw error;
      }
    },
    gitAvailable: async () => {
      const found = gitOnPath();
      if (!found) return false;
      // Apple's /usr/bin/git opens an installer when the command line tools are missing; ask xcode-select first.
      if (process.platform === 'darwin' && found === '/usr/bin/git') {
        return new Promise<boolean>(resolve => execFile('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }, error => resolve(!error)));
      }
      return true;
    },
    githubHelper: async () => {
      const connection = await readGithubConnection();
      return connection.status === 'connected' && connection.source === 'gh-cli' ? resolveGhBinary() : null;
    },
    openSignIn: openGithubSignIn,
    waitForSignIn: (timeoutMs, isCurrent) => new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        unsubscribe(); clearTimeout(timer); clearInterval(watch);
        resolve(value);
      };
      const unsubscribe = onGithubConnectionChanged(() => {
        void readGithubConnection().then(connection => { if (connection.status === 'connected') finish(true); }, () => undefined);
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      // The request may be stopped meanwhile; nobody is waiting then.
      const watch = setInterval(() => { if (!isCurrent()) finish(false); }, 2000);
    }),
    register: async (dir) => {
      const owner = getActiveDataOwnerPushStamp();
      if (!await upsertRecentWorkdir(dir)) return;
      await restoreLocalProjectVisibility(dir, owner).catch(() => false);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!isTrustedAppRendererWindow(window)) continue;
        try { window.webContents.send('local-db:recent-workdirs:changed', { path: dir }, owner); } catch { /* the list refreshes on its next read */ }
      }
    },
    fs: {
      exists: target => fsp.stat(target).then(() => true, () => false),
      readdir: target => fsp.readdir(target),
      mkdir: async target => { await fsp.mkdir(target, { recursive: true }); },
      rename: (from, to) => fsp.rename(from, to),
      rm: target => fsp.rm(target, { recursive: true, force: true }),
    },
    ...(log ? { log } : {}),
  });
}
