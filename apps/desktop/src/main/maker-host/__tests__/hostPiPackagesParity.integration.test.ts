/**
 * 测试价值
 * - 可观察结果：桌面的 Pi 包（pi-package-store.ts 与 pi-managed-package-mutation.ts，桌面自己的绑定）与 Host
 *   引擎图交给 Pi 的同名依赖（apps/host/src/agent/pi-packages.ts，Host 自己的端口）在同一个 profile 上
 *   的读取结果与变更：安装、列出、交给 Pi 的包路径与资源、包里的提示命令、删除；两边轮流改同一个
 *   pi-package-home，一边在改时另一边的变更等它做完。真实 Pi 二进制（apps/pi-bin）执行包命令，包是本地
 *   目录，不连网。
 * - 规则依据：放行表第 19 行 P10–P13（审核方：对照测试覆盖“一边持锁、另一边等待”；“更新 Pi 本体”写进
 *   例外清单，Host 上报错，见第 34 行与第二节“引擎二进制的路径”）。
 * - 断言方式：每一步两边的读取逐项相等；不同之处按名字写死在 ALLOWED_DIFFERENCES 里。
 * - tier：integration（真实 Pi 进程，不在 CI 的单测里，在桌面 integration 层手动跑：
 *   `node scripts/test-workspaces.mjs --tier integration`（apps/desktop 的 integration 层）或直接 vitest run 本文件；临时 profile；进程内的 os.homedir()
 *   与子进程的 HOME 都指向新建的空目录，跑完仍为空）。Pi 的包装脚本是 sh，Windows 上整组跳过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '@cindy/maker-core';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({ userDataDir: '', desktopPi: '', home: '' }));

// In-process reads of the user home go through os.homedir(); assigning process.env.HOME does not
// reach it in a worker thread or on Windows. Child Pi processes still get HOME through their env.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => {
    if (!h.home) throw new Error('homedir read before the fixture home was set');
    return h.home;
  };
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, getAppPath: () => h.userDataDir, isPackaged: false },
}));
// The desktop's agent-binaries: the same Pi binary; a core update "succeeds" without downloading.
vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: (kind: string) => (kind === 'pi' ? h.desktopPi : undefined),
  updateReadyPiBinary: async () => h.desktopPi,
}));
vi.mock('../../agent-binaries/pi-self-update.js', () => ({ piBinaryUpdateFailureStage: () => undefined }));

import * as desktopStore from '../pi-package-store.js';
import { mutateAuthorizedPiManagedPackage } from '../pi-managed-package-mutation.js';

const realPi = path.resolve(__dirname, '../../../../../pi-bin', `${process.platform}-${process.arch}`, 'pi');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-pi-packages-parity-')));
const home = path.join(root, 'home');
h.home = home;
const timeline = path.join(root, 'timeline.log');
const previousHome = process.env.HOME;

type HostPackages = {
  store: typeof desktopStore;
  deps: Required<Pick<AgentDeps, 'resolvePiManagedPackageResources' | 'resolvePiNativePackagePaths' | 'mutatePiManagedPackage' | 'onPiManagedPackageMutationSettled'>>;
  attachMaker(maker: unknown): void;
  close(): void;
};
let host: HostPackages;

/** A wrapper Pi for one side: slow while its flag file exists, logging each start and end. */
function wrapper(side: string): { file: string; slow: string } {
  const file = path.join(root, `pi-${side}`);
  const slow = path.join(root, `slow-${side}`);
  fs.writeFileSync(file, `#!/bin/sh
echo "${side} start $1" >> "${timeline}"
[ -f "${slow}" ] && sleep 1.5
"${realPi}" "$@"; code=$?
echo "${side} end $1" >> "${timeline}"
exit $code
`, { mode: 0o755 });
  return { file, slow };
}

function localPackage(name: string): string {
  const dir = path.join(root, 'packages', name);
  fs.mkdirSync(path.join(dir, 'skills', `${name}-skill`), { recursive: true });
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', keywords: ['pi-package'] }));
  fs.writeFileSync(path.join(dir, 'skills', `${name}-skill`, 'SKILL.md'), `---\nname: ${name}-skill\ndescription: Fixture skill\n---\nFixture.\n`);
  fs.writeFileSync(path.join(dir, 'prompts', `${name}-review.md`), '---\ndescription: Fixture prompt\n---\nReview.\n');
  return dir;
}

const desktopSide = wrapper('desktop');
const hostSide = wrapper('host');

beforeAll(async () => {
  fs.mkdirSync(home);
  process.env.HOME = home;
  h.userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(h.userDataDir);
  h.desktopPi = desktopSide.file;
  const hostModule = '../../../../../host/src/agent/pi-packages.ts';
  const { createHostPiPackages } = (await import(/* @vite-ignore */ hostModule)) as {
    createHostPiPackages(options: { userDataDir: string; piBinaryPath: string | null }): HostPackages;
  };
  host = createHostPiPackages({ userDataDir: h.userDataDir, piBinaryPath: hostSide.file });
});

afterAll(() => {
  host?.close();
  process.env.HOME = previousHome;
  expect(fs.readdirSync(home)).toEqual([]);
  fs.rmSync(root, { recursive: true, force: true });
});

const request = (action: 'install' | 'remove', source: string) =>
  ({ action, source, authorization: 'confirmed-tool-call' }) as Parameters<typeof mutateAuthorizedPiManagedPackage>[0];
// Fields that name which process ran a command or when are not part of the projection.
const reads = async (side: 'desktop' | 'host') => {
  const store = side === 'desktop' ? desktopStore : host.store;
  return JSON.parse(JSON.stringify({
    list: await store.listPiPackages(),
    nativePaths: await store.resolveManagedPiNativePackagePaths(),
    resources: await store.resolveManagedPiPackageResources(),
    prompts: await store.listManagedPiPromptCommands(),
  }));
};
const ends = () => fs.readFileSync(timeline, 'utf8').split('\n').filter(line => / end (install|remove)$/.test(line));

// The Pi wrappers below are sh scripts that the production code starts without a shell.
describe.skipIf(process.platform === 'win32')('Host and desktop Pi packages on one profile', () => {
  it('read the same packages after each side changes them, and wait for each other', async () => {
    const alpha = localPackage('fixture-alpha');
    const beta = localPackage('fixture-beta');
    // Each side watches the shared profile as in production (desktop: maker-ipc/register.ts; Host:
    // pi-packages.ts attachMaker), and must see the other side's change before the reads compare.
    const seen = { desktop: [] as string[], host: [] as string[] };
    const stopDesktop = desktopStore.onPiPackagesChanged(origin => seen.desktop.push(origin));
    const stopHost = host.store.onPiPackagesChanged(origin => seen.host.push(origin));
    const waitFor = async (predicate: () => boolean) => {
      const until = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > until) throw new Error(`timed out; seen ${JSON.stringify(seen)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const external = (origins: string[]) => origins.some(origin => origin !== 'local');

    // The desktop installs slowly while the Host installs: the Host's change waits for the desktop's.
    fs.writeFileSync(desktopSide.slow, '');
    const desktopInstall = mutateAuthorizedPiManagedPackage(request('install', alpha));
    await new Promise(resolve => setTimeout(resolve, 300));
    const hostInstall = host.deps.mutatePiManagedPackage(request('install', beta));
    await Promise.all([desktopInstall, hostInstall]);
    fs.rmSync(desktopSide.slow);
    expect(ends()).toEqual(['desktop end install', 'host end install']);
    await waitFor(() => external(seen.desktop) && external(seen.host));
    const afterInstall = await reads('desktop');
    expect(await reads('host')).toEqual(afterInstall);
    expect(afterInstall.list.packages.map((p: { name: string }) => p.name).sort()).toEqual(['fixture-alpha', 'fixture-beta']);
    expect(afterInstall.prompts.map((p: { name: string }) => p.name).sort()).toEqual(['fixture-alpha-review', 'fixture-beta-review']);
    // What the Host gives Pi is what the desktop gives Pi.
    expect(await host.deps.resolvePiNativePackagePaths()).toEqual(afterInstall.nativePaths);

    // The other way: the Host removes slowly while the desktop removes.
    fs.writeFileSync(timeline, '');
    seen.desktop.length = 0;
    seen.host.length = 0;
    fs.writeFileSync(hostSide.slow, '');
    const hostRemove = host.deps.mutatePiManagedPackage(request('remove', beta));
    await new Promise(resolve => setTimeout(resolve, 300));
    const desktopRemove = mutateAuthorizedPiManagedPackage(request('remove', alpha));
    await Promise.all([hostRemove, desktopRemove]);
    fs.rmSync(hostSide.slow);
    expect(ends()).toEqual(['host end remove', 'desktop end remove']);
    await waitFor(() => external(seen.desktop) && external(seen.host));
    const afterRemove = await reads('host');
    expect(await reads('desktop')).toEqual(afterRemove);
    expect(afterRemove.list.packages).toEqual([]);
    stopDesktop();
    stopHost();
  });

  // The desktop's retirement around a mutation (maker-host/index.ts) and after another process's
  // change (maker-ipc/register.ts), on the Host: a Maker with one live local Pi task records what is
  // asked of it.
  it('retire the Host\'s Pi tasks around its own change and after the desktop\'s change', async () => {
    const calls: string[] = [];
    const task = { id: 'pi-task', agentKind: 'pi' };
    host.attachMaker({
      advanceLocalPiPackageRuntimeGeneration: () => { calls.push('advance'); },
      listActiveSessions: () => [task],
      getSessionMeta: async () => ({}),
      closeSessionIfCurrent: async (_session: unknown, reason: string) => { calls.push(`close ${reason}`); return 'deferred'; },
    });
    const outcomes: unknown[] = [];
    const publish = (outcome: unknown) => { outcomes.push(outcome); return { type: 'text' } as never; };
    const failure = () => ({ type: 'text' }) as never;

    // Its own change: the runtime snapshot at the commit edge, then retirement after the receipt.
    const gamma = localPackage('fixture-gamma');
    await host.deps.mutatePiManagedPackage(request('install', gamma));
    expect(calls).toContain('advance');
    await host.deps.onPiManagedPackageMutationSettled(undefined, publish, failure);
    expect(calls).toContain('close runtime-refresh');
    expect(outcomes).toEqual([{ runtimeConvergence: 'deferred' }]);
    // A settled callback without a pending snapshot reports a partial convergence, as on the desktop.
    await host.deps.onPiManagedPackageMutationSettled(undefined, publish, failure);
    expect(outcomes[1]).toEqual({ runtimeConvergence: 'partial', recoveryAction: 'restart-cindy-to-refresh-packages' });

    // The desktop's change: the Host sees it and retires its task after the current turn.
    calls.length = 0;
    await mutateAuthorizedPiManagedPackage(request('remove', gamma));
    const until = Date.now() + 15_000;
    while (!calls.includes('close runtime-refresh')) {
      if (Date.now() > until) throw new Error(`timed out; calls ${JSON.stringify(calls)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(calls[0]).toBe('advance');
  });

  it('differ only where recorded: the Host does not update the Pi core', async () => {
    const command = { action: 'command', command: { kind: 'self' }, authorization: 'confirmed-tool-call' } as Parameters<typeof mutateAuthorizedPiManagedPackage>[0];
    const settle = (promise: Promise<unknown>) => promise.then(
      value => ({ outcome: 'ok', execution: (value as { execution?: string }).execution }),
      (error: { commandFailure?: { phase?: string; recovery?: string } }) => ({ outcome: 'failed', commandFailure: error.commandFailure }),
    );
    const differences = {
      'Pi core update': {
        desktop: await settle(mutateAuthorizedPiManagedPackage(command)),
        host: await settle(host.deps.mutatePiManagedPackage(command)),
      },
    };
    /**
     * The only difference (release table: row 34 and section 2 "engine binary path"): until the Host
     * manages engine binaries it refuses a Pi core update instead of updating Pi in place, classified
     * as hostStage 'unsupported' (Pi's receipt then says the update is unavailable, without a retry;
     * maker-core pi-auto-review-dispatch.test.ts).
     */
    const ALLOWED_DIFFERENCES = {
      'Pi core update': {
        desktop: { outcome: 'ok', execution: 'host-binary-update' },
        host: { outcome: 'failed', commandFailure: { phase: 'host-binary-update', hostStage: 'unsupported', packagesUpdated: false, recovery: 'check-host-update-and-retry-core' } },
      },
    };
    expect(differences).toEqual(ALLOWED_DIFFERENCES);
  });
});
