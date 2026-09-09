import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsSync, {
  mkdirSync,
  mkdtempSync,
  promises as fs,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Windows 未开启 Developer Mode / 无 Create Symbolic Link 权限时，文件 symlink
// 会返回 EPERM；目录 junction 不受此限制，但本文件的竞态用例必须替换单个文件。
// 探测真实 OS 能力，避免把权限差异误报成产品回归。
function canCreateFileSymlink(): boolean {
  const probeRoot = mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-package-file-link-probe-'));
  const link = path.join(probeRoot, 'link');
  try {
    symlinkSync(path.join(probeRoot, 'target'), link, 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const canLinkFile = canCreateFileSymlink();

const runtime = vi.hoisted(() => ({
  userData: '',
  listOutput: '',
  listOutcomes: [] as Array<{ stdout?: string; stderr?: string; exitCode: number }>,
  stderr: '',
  exitCode: 0,
  spawns: [] as Array<{ args: string[]; env: Record<string, string | undefined>; detached?: boolean }>,
  holdMutationCommand: false,
  pendingClose: null as null | ((code: number) => void),
  spawnHook: null as null | ((args: string[]) => void),
}));

const loggerRuntime = vi.hoisted(() => ({ warn: vi.fn() }));

const processRuntime = vi.hoisted(() => ({
  killTree: vi.fn(),
  pendingTreeSettled: null as null | (() => void),
}));

const lockRuntime = vi.hoisted(() => ({
  calls: [] as Array<{ lockPath: string; label: string; waitMs?: number }>,
  tail: Promise.resolve() as Promise<void>,
  active: 0,
  maxActive: 0,
  nextStatus: null as null | { held: false; reason: 'busy' | 'unavailable' },
}));

vi.mock('electron', () => ({
  app: { getPath: () => runtime.userData },
}));

vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: () => '/mock/0.83.0/pi',
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: loggerRuntime.warn, error: vi.fn(), fatal: vi.fn(),
    child() { return this; },
  }),
}));

vi.mock('../../device-link/crossProcessLock.js', () => ({
  withSecurityBoundaryLock: vi.fn(async (
    lockPath: string,
    options: { label: string; waitMs?: number },
    task: (status: { held: true } | { held: false; reason: 'busy' | 'unavailable' }) => Promise<unknown>,
  ) => {
    lockRuntime.calls.push({ lockPath, label: options.label, waitMs: options.waitMs });
    if (lockRuntime.nextStatus) {
      const status = lockRuntime.nextStatus;
      lockRuntime.nextStatus = null;
      return task(status);
    }
    const previous = lockRuntime.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    lockRuntime.tail = previous.then(() => gate);
    await previous.catch(() => undefined);
    lockRuntime.active += 1;
    lockRuntime.maxActive = Math.max(lockRuntime.maxActive, lockRuntime.active);
    try {
      return await task({ held: true });
    } finally {
      lockRuntime.active -= 1;
      release();
    }
  }),
}));

vi.mock('../../scheduler-host/proc-util.js', () => ({
  killProcessTree: (...args: unknown[]) => {
    processRuntime.killTree(...args);
    processRuntime.pendingTreeSettled = args[2] as (() => void) | undefined ?? null;
  },
}));

vi.mock('node:child_process', () => ({
  spawn: (_binary: string, args: string[], options: { env?: Record<string, string | undefined>; detached?: boolean }) => {
    runtime.spawns.push({ args: [...args], env: { ...(options.env ?? {}) }, detached: options.detached });
    const stdoutHandlers: Array<(chunk: Buffer) => void> = [];
    const stderrHandlers: Array<(chunk: Buffer) => void> = [];
    const closeHandlers: Array<(code: number) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    const child = {
      stdout: { on: (_event: string, handler: (chunk: Buffer) => void) => stdoutHandlers.push(handler) },
      stderr: { on: (_event: string, handler: (chunk: Buffer) => void) => stderrHandlers.push(handler) },
      once: (event: string, handler: ((code: number) => void) | ((error: Error) => void)) => {
        if (event === 'close') closeHandlers.push(handler as (code: number) => void);
        if (event === 'error') errorHandlers.push(handler as (error: Error) => void);
      },
      kill: vi.fn(),
      pid: 4242,
      exitCode: null,
      signalCode: null,
    };
    runtime.pendingClose = (code) => {
      for (const handler of closeHandlers) handler(code);
    };
    queueMicrotask(() => {
      if (runtime.holdMutationCommand && !args.includes('list')) return;
      runtime.spawnHook?.(args);
      const outcome = args.includes('list') ? runtime.listOutcomes.shift() : undefined;
      if (args.includes('list')) {
        for (const handler of stdoutHandlers) {
          handler(Buffer.from(outcome?.stdout ?? runtime.listOutput));
        }
      }
      const stderr = outcome?.stderr ?? runtime.stderr;
      if (stderr) {
        for (const handler of stderrHandlers) handler(Buffer.from(stderr));
      }
      for (const handler of closeHandlers) handler(outcome?.exitCode ?? runtime.exitCode);
    });
    return child;
  },
}));

const roots: string[] = [];

async function createPackage(options?: {
  oversizedManifest?: boolean;
  lifecycleScript?: boolean;
  source?: string;
}): Promise<{
  root: string;
  source: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-security-pkg-'));
  roots.push(root);
  const source = options?.source
    ?? (options?.oversizedManifest ? 'npm:oversized-package' : 'npm:test-extension');
  const prompts = options?.oversizedManifest
    ? Array.from({ length: 257 }, (_, index) => `prompts/${index}.md`)
    : ['./prompts'];
  await fs.mkdir(path.join(root, 'extensions'), { recursive: true });
  await fs.mkdir(path.join(root, 'prompts'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: source.slice(4),
    version: '1.0.0',
    pi: { extensions: ['./extensions'], prompts },
    ...(options?.lifecycleScript ? { scripts: { postinstall: 'node generate.js' } } : {}),
  }));
  await fs.writeFile(path.join(root, 'extensions', 'index.ts'), `
    export default function setup(pi: any) {
      pi.registerCommand('managed-test', {
        handler(_args: string, ctx: any) { ctx.ui.notify('ok'); },
      });
    }
  `);
  await fs.writeFile(path.join(root, 'prompts', 'hello.md'), '---\ndescription: hello\n---\nHello\n');
  runtime.listOutput = `User packages:\n  ${source}\n    ${root}\n`;
  return { root, source };
}

async function createSkillOnlyPackage(source: string): Promise<{ root: string; source: string }> {
  const pkg = await createPackage({ source });
  await fs.rm(path.join(pkg.root, 'extensions'), { recursive: true, force: true });
  await fs.rm(path.join(pkg.root, 'prompts'), { recursive: true, force: true });
  await fs.mkdir(path.join(pkg.root, 'skills', 'managed-skill'), { recursive: true });
  await fs.writeFile(path.join(pkg.root, 'package.json'), JSON.stringify({
    name: source.slice(4),
    version: '1.0.0',
    pi: { skills: ['./skills'] },
  }));
  await fs.writeFile(
    path.join(pkg.root, 'skills', 'managed-skill', 'SKILL.md'),
    '# Managed skill\n',
  );
  return pkg;
}

beforeEach(async () => {
  runtime.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-security-home-'));
  roots.push(runtime.userData);
  runtime.listOutput = '';
  runtime.listOutcomes = [];
  runtime.stderr = '';
  runtime.exitCode = 0;
  runtime.spawns = [];
  runtime.holdMutationCommand = false;
  runtime.pendingClose = null;
  runtime.spawnHook = null;
  loggerRuntime.warn.mockReset();
  processRuntime.killTree.mockReset();
  processRuntime.pendingTreeSettled = null;
  lockRuntime.calls = [];
  lockRuntime.tail = Promise.resolve();
  lockRuntime.active = 0;
  lockRuntime.maxActive = 0;
  lockRuntime.nextStatus = null;
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function mutateAuthorized(
  store: typeof import('../pi-package-store.js'),
  request: import('../../../shared/piPackages.js').PiPackageMutationRequest,
  hooks?: import('../pi-package-store.js').PiPackageMutationHooks,
) {
  const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
  return store.mutatePiPackage(request, issuePiPackageMutationGrant(request), hooks);
}

describe('Pi package executable-code boundary', () => {
  it('uses a safe basename for a manifest-less local package display name', async () => {
    const { root } = await createPackage({ source: '' });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      version: '1.0.0',
      pi: { extensions: ['./extensions'], prompts: ['./prompts'] },
    }));
    runtime.listOutput = `User packages:\n  ${root}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');

    const result = await store.listPiPackages();

    expect(result.packages).toMatchObject([{
      source: root,
      name: path.basename(root),
    }]);
    expect(result.packages[0]?.name).not.toContain(path.dirname(root));
  });

  it.each([
    ['npm', 'npm:oversized-display'],
    ['git', 'git:https://example.com/acme/oversized-display.git'],
    ['local', 'file:/tmp/oversized-display'],
  ])('bounds untrusted package and frontmatter display fields for %s sources', async (_kind, source) => {
    const { root } = await createPackage({ source });
    const longName = '名'.repeat(400);
    const longVersion = 'v'.repeat(400);
    const longSkillName = '技'.repeat(400);
    const longDescription = '说'.repeat(2_000);
    await fs.mkdir(path.join(root, 'skills', 'oversized'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'oversized', 'SKILL.md'), [
      '---',
      `name: ${longSkillName}`,
      `description: ${longDescription}`,
      '---',
      'skill body',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'prompts', 'hello.md'), [
      '---',
      `description: ${longDescription}`,
      '---',
      'prompt body',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: longName,
      version: longVersion,
      pi: {
        extensions: [],
        skills: ['./skills'],
        prompts: ['./prompts'],
        themes: [],
      },
    }));

    const store = await import('../pi-package-store.js');
    const result = await store.listPiPackages();
    const pkg = result.packages[0]!;
    const skill = pkg.resources.find((resource) => resource.kind === 'skill')!;
    expect(pkg.name.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(pkg.name, 'utf8')).toBeLessThanOrEqual(256);
    expect(pkg.version?.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(pkg.version!, 'utf8')).toBeLessThanOrEqual(128);
    expect(skill.name.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(skill.name, 'utf8')).toBeLessThanOrEqual(256);

    const resources = await store.resolveManagedPiPackageResources();
    expect(resources.skills[0]?.name.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(resources.skills[0]!.description!, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(resources.skills[0]?.description?.endsWith('…')).toBe(true);
    const commands = await store.listManagedPiPromptCommands();
    expect(commands[0]?.description.endsWith('…')).toBe(true);
    expect(Buffer.byteLength(commands[0]!.description, 'utf8')).toBeLessThanOrEqual(1_024);
  });

  it('keeps the maximum package roster projection bounded', async () => {
    const entries: string[] = ['User packages:'];
    for (let index = 0; index < 128; index += 1) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-roster-pkg-'));
      roots.push(root);
      const source = `npm:oversized-roster-${index}`;
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: `package-${index}-${'n'.repeat(4_096)}`,
        version: `version-${index}-${'v'.repeat(4_096)}`,
        pi: { extensions: [], skills: [], prompts: [], themes: [] },
      }));
      entries.push(`  ${source}`, `    ${root}`);
    }
    runtime.listOutput = `${entries.join('\n')}\n`;

    const store = await import('../pi-package-store.js');
    const result = await store.listPiPackages();
    expect(result.packages).toHaveLength(128);
    expect(result.packages.every((pkg) => pkg.name.endsWith('…'))).toBe(true);
    expect(result.packages.every((pkg) => pkg.version?.endsWith('…'))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(128 * 1_024);
  });

  it('keeps a valid native roster above the diagnostic stdout limit actionable', async () => {
    const entries: string[] = ['User packages:'];
    const rootsBySource = new Map<string, string>();
    for (let index = 0; index < 128; index += 1) {
      const source = `npm:package-${index}-${'s'.repeat(1_024)}`;
      const installedRoot = `/managed/package-${index}/${'p'.repeat(1_024)}`;
      rootsBySource.set(source, installedRoot);
      entries.push(`  ${source}`, `    ${installedRoot}`);
    }
    runtime.listOutput = `${entries.join('\n')}\n`;
    expect(Buffer.byteLength(runtime.listOutput, 'utf8')).toBeGreaterThan(128 * 1_024);
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      available: true,
      packages: expect.arrayContaining([
        expect.objectContaining({ source: [...rootsBySource.keys()][0] }),
        expect.objectContaining({ source: [...rootsBySource.keys()][127] }),
      ]),
    });
    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual(
      [...rootsBySource.values()],
    );
  });

  it.each(['darwin'] as const)(
    'waits for timed-out package trees to close on %s',
    async (platform) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        const store = await import('../pi-package-store.js');
        runtime.holdMutationCommand = true;
        let settled = false;
        const pending = store.runPiPackageCommand(['install', 'npm:test'], 1).finally(() => {
          settled = true;
        });
        await vi.waitFor(() => {
          expect(processRuntime.killTree).toHaveBeenCalledOnce();
        }, { timeout: 1_000 });
        expect(processRuntime.killTree).toHaveBeenCalledWith(
          4242,
          expect.any(Object),
          expect.any(Function),
          { requireWindowsIdentityBoundTermination: true },
        );
        expect(runtime.spawns.at(-1)?.detached).toBe(true);
        expect(settled).toBe(false);
        runtime.pendingClose?.(1);
        await Promise.resolve();
        expect(settled).toBe(false);
        processRuntime.pendingTreeSettled?.();
        await expect(pending).rejects.toThrow(/timed out/);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    },
  );

  it.each(['darwin'] as const)(
    'force-settles a timed-out package tree when stdio never closes on %s',
    async (platform) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        const store = await import('../pi-package-store.js');
        runtime.holdMutationCommand = true;
        let failure: unknown;
        const pending = store.runPiPackageCommand(['install', 'npm:test'], 1).catch((error) => {
          failure = error;
        });

        await vi.waitFor(() => {
          expect(processRuntime.killTree).toHaveBeenCalledOnce();
        }, { timeout: 1_000 });
        processRuntime.pendingTreeSettled?.();
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(failure).toBeUndefined();
        expect(runtime.pendingClose).not.toBeNull();
        await pending;
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/timed out/);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    },
  );

  it('keeps a timed-out Windows package mutation fail closed without a proven tree termination', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const store = await import('../pi-package-store.js');
      runtime.holdMutationCommand = true;
      let settled = false;
      void store.runPiPackageCommand(['install', 'npm:test'], 1).finally(() => {
        settled = true;
      });

      await vi.waitFor(() => {
        expect(processRuntime.killTree).toHaveBeenCalledOnce();
      }, { timeout: 1_000 });
      expect(processRuntime.killTree).toHaveBeenCalledWith(
        4242,
        expect.any(Object),
        expect.any(Function),
        { requireWindowsIdentityBoundTermination: true },
      );
      expect(runtime.spawns.at(-1)?.detached).toBe(false);

      runtime.pendingClose?.(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('binds mutation grants to one exact request and rejects replay', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
    const request = { action: 'install' as const, source };
    const grant = issuePiPackageMutationGrant(request);

    await expect(store.mutatePiPackage({ action: 'remove', source })).rejects.toThrow(
      /explicit authorization/i,
    );

    await expect(store.mutatePiPackage({ action: 'update', source }, grant)).rejects.toThrow(
      /invalid or expired/i,
    );
    await expect(store.mutatePiPackage(request, grant)).rejects.toThrow(/invalid or expired/i);

    const fresh = issuePiPackageMutationGrant(request);
    await expect(store.mutatePiPackage(request, fresh)).resolves.toMatchObject({ changed: true });
    await expect(store.mutatePiPackage(request, fresh)).rejects.toThrow(/invalid or expired/i);
  });

  it('marks only failures that reached a native command or durable state write', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');

    const validationFailure = await mutateAuthorized(store, {
      action: 'install',
      source: '-invalid',
    }).catch((error: unknown) => error);
    expect(store.piPackageMutationMayHaveChangedState(validationFailure)).toBe(false);

    runtime.exitCode = 1;
    const runtimeFence = vi.fn();
    const commandFailure = await mutateAuthorized(store, {
      action: 'install',
      source,
    }, {
      onRuntimeInvalidationPublished: runtimeFence,
    }).catch((error: unknown) => error);
    expect(store.piPackageMutationMayHaveChangedState(commandFailure)).toBe(true);
    expect(runtimeFence).toHaveBeenCalledOnce();
  });

  it.each([
    ['install', 'npm ERR! code ETARGET No matching version found'],
    ['update', 'getaddrinfo ENOTFOUND registry.example'],
    ['remove', 'npm ERR! code E404 package not found'],
  ] as const)('does not request runtime convergence for a deterministic %s failure', async (
    action,
    stderr,
  ) => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    runtime.exitCode = 1;
    runtime.stderr = stderr;

    const failure = await mutateAuthorized(store, { action, source }).catch((error: unknown) => error);

    expect(store.piPackageMutationMayHaveChangedState(failure)).toBe(false);
  });

  it('keeps native package enablement independent from optional snapshot approval metadata', async () => {
    const { root, source } = await createPackage();
    await fs.mkdir(path.join(root, 'skills', 'sample'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'skills', 'sample', 'SKILL.md'),
      '---\nname: sample\ndescription: sample skill\n---\nold skill\n',
    );
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
      pi: { skills?: string[] };
    };
    manifest.pi.skills = ['./skills'];
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
    const store = await import('../pi-package-store.js');

    const initial = await store.listPiPackages();
    expect(initial.packages[0]).toMatchObject({
      source,
      enabled: true,
    });
    await expect(
      store.mutatePiPackage({
        action: 'set-enabled',
        source,
        enabled: true,
      }),
    ).rejects.toThrow(/explicit authorization/);

    const approved = await mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    });
    expect(approved.affectedPackage).toMatchObject({ source, enabled: true });
    expect(approved.affectedPackage?.requiresExtensionApproval).toBeUndefined();
    const snapshotRoot = path.join(runtime.userData, 'session-home', 'managed-packages');
    const snapshot = await store.resolveManagedPiPackageResources({ snapshotRoot });
    const snapshotExtension = path.join(snapshotRoot, '0', 'extensions', 'index.ts');
    const snapshotSkill = path.join(snapshotRoot, '0', 'skills', 'sample', 'SKILL.md');
    const snapshotPrompt = path.join(snapshotRoot, '0', 'prompts', 'hello.md');
    expect(snapshot).toMatchObject({
      extensions: [snapshotExtension],
      skills: [{ path: snapshotSkill, name: 'sample' }],
      promptTemplates: [snapshotPrompt],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
    const frozenResources = await Promise.all([
      fs.readFile(snapshotExtension, 'utf8'),
      fs.readFile(snapshotSkill, 'utf8'),
      fs.readFile(snapshotPrompt, 'utf8'),
    ]);
    await fs.writeFile(path.join(root, 'extensions', 'index.ts'), 'export default function changed() {}');
    await fs.writeFile(path.join(root, 'skills', 'sample', 'SKILL.md'), '# changed');
    await fs.writeFile(path.join(root, 'prompts', 'hello.md'), 'changed');
    await expect(Promise.all([
      fs.readFile(snapshotExtension, 'utf8'),
      fs.readFile(snapshotSkill, 'utf8'),
      fs.readFile(snapshotPrompt, 'utf8'),
    ])).resolves.toEqual(frozenResources);

    const updated = await mutateAuthorized(store, { action: 'update', source });
    expect(updated.affectedPackage).toMatchObject({
      source,
      enabled: true,
    });
    expect(updated.affectedPackage?.requiresExtensionApproval).toBeUndefined();
    await fs.rm(root, { recursive: true, force: true });
    await expect(Promise.all([
      fs.readFile(snapshotExtension, 'utf8'),
      fs.readFile(snapshotSkill, 'utf8'),
      fs.readFile(snapshotPrompt, 'utf8'),
    ])).resolves.toEqual(frozenResources);
  });

  it('enables an Extension package from the same authorized install', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');

    const installed = await mutateAuthorized(store, { action: 'install', source });

    expect(installed.affectedPackage).toMatchObject({
      source,
      enabled: true,
    });
    expect(installed.affectedPackage?.requiresExtensionApproval).toBeUndefined();
    expect(installed.packages).toMatchObject([{ source, enabled: true }]);
  });

  it('feeds installed roots to Pi native discovery without requiring Cindy approval', async () => {
    const { root, source } = await createPackage();
    const store = await import('../pi-package-store.js');

    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([root]);

    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: false });
    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([]);
  });

  it('fails explicitly instead of widening a filtered package when settings are invalid', async () => {
    const { root, source } = await createPackage({ source: 'npm:filtered-invalid' });
    runtime.listOutput = `User packages:\n  ${source} (filtered)\n    ${root}\n`;
    const packageHome = path.join(runtime.userData, 'pi-package-home');
    await fs.mkdir(packageHome, { recursive: true });
    await fs.writeFile(path.join(packageHome, 'settings.json'), '{"packages":');
    const store = await import('../pi-package-store.js');

    await expect(store.resolveManagedPiNativePackagePaths()).rejects.toThrow('state is unavailable');
    expect(loggerRuntime.warn).toHaveBeenCalledWith(
      'Pi package filter settings unavailable',
      { failureCategory: 'state-unavailable' },
    );
  });

  it('preserves native filters from a valid settings file above the inspection byte limit', async () => {
    const { root, source } = await createPackage({ source: 'npm:filtered-large-settings' });
    runtime.listOutput = `User packages:\n  ${source} (filtered)\n    ${root}\n`;
    const packageHome = path.join(runtime.userData, 'pi-package-home');
    const settingsContents = JSON.stringify({
      packages: [{
        source,
        extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
        skills: [],
      }],
      nativePadding: 'x'.repeat(1_048_576),
    });
    expect(Buffer.byteLength(settingsContents)).toBeGreaterThan(1_048_576);
    await fs.mkdir(packageHome, { recursive: true });
    await fs.writeFile(path.join(packageHome, 'settings.json'), settingsContents);
    const store = await import('../pi-package-store.js');

    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([{
      source: root,
      extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
      skills: [],
    }]);
    expect(loggerRuntime.warn.mock.calls).toEqual([]);
  });

  it.skipIf(!canLinkFile)('preserves native filters from a settings symlink outside package home', async () => {
    const { root, source } = await createPackage({ source: 'npm:filtered-linked-settings' });
    runtime.listOutput = `User packages:\n  ${source} (filtered)\n    ${root}\n`;
    const packageHome = path.join(runtime.userData, 'pi-package-home');
    const externalSettings = path.join(runtime.userData, 'dotfiles-settings.json');
    await fs.mkdir(packageHome, { recursive: true });
    await fs.writeFile(externalSettings, JSON.stringify({
      packages: [{
        source,
        extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
        skills: [],
      }],
    }));
    await fs.symlink(externalSettings, path.join(packageHome, 'settings.json'), 'file');
    const store = await import('../pi-package-store.js');

    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([{
      source: root,
      extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
      skills: [],
    }]);
    expect(loggerRuntime.warn.mock.calls).toEqual([]);
  });

  it('keeps an unfiltered native package when optional filter settings are unavailable', async () => {
    const { root } = await createPackage({ source: 'npm:unfiltered-settings-failure' });
    const settingsFile = path.join(runtime.userData, 'pi-package-home', 'settings.json');
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, '{"packages":');
    const store = await import('../pi-package-store.js');

    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([root]);
  });

  it('preserves Pi object-form resource filters when projecting an installed root', async () => {
    const { root, source } = await createPackage({ source: 'npm:filtered-package' });
    runtime.listOutput = `User packages:\n  ${source} (filtered)\n    ${root}\n`;
    const packageHome = path.join(runtime.userData, 'pi-package-home');
    await fs.mkdir(packageHome, { recursive: true });
    await fs.writeFile(path.join(packageHome, 'settings.json'), JSON.stringify({
      packages: [{
        source,
        extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
        skills: [],
        prompts: ['prompts/review.md'],
      }],
    }));
    const store = await import('../pi-package-store.js');

    const projected = await store.resolveManagedPiNativePackagePaths();
    expect(loggerRuntime.warn.mock.calls).toEqual([]);
    expect(projected).toEqual([{
      source: root,
      extensions: ['extensions/*.ts', '!extensions/legacy.ts'],
      skills: [],
      prompts: ['prompts/review.md'],
    }]);
  });

  it('keeps compatibility analysis informational during install', async () => {
    const { root, source } = await createPackage();
    await fs.writeFile(path.join(root, 'extensions', 'index.ts'), `
      export default function setup(pi: any) {
        pi.on('session_start', (_event: unknown, ctx: any) => {
          ctx.ui.setStatus('compatibility-note', 'still launchable');
        });
      }
    `);
    const store = await import('../pi-package-store.js');

    const installed = await mutateAuthorized(store, { action: 'install', source });

    expect(installed.affectedPackage).toMatchObject({
      source,
      enabled: true,
      resources: expect.arrayContaining([expect.objectContaining({
        kind: 'extension',
        compatibility: 'partial',
        compatibilityIssues: ['status-display'],
      })]),
    });
  });

  it('clears an old explicit disable after reinstall even when post-install analysis fails', async () => {
    const { source } = await createPackage();
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      version: 3,
      disabledSources: [source, 'npm:keep-disabled'],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    runtime.listOutcomes.push({ stderr: 'analysis unavailable', exitCode: 1 });
    const store = await import('../pi-package-store.js');

    await expect(mutateAuthorized(store, { action: 'install', source })).resolves.toMatchObject({
      affectedPackage: { source, enabled: true },
    });
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual(['npm:keep-disabled']);
  });

  it.each(['install', 'update'] as const)(
    'builds a Git-style package on %s and republishes the runtime fence after generated bytes settle',
    async (action) => {
    const { root, source } = await createPackage();
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'generated-extension',
      version: '1.0.0',
      pi: {
        extensions: ['./build/adapters/pi/extension.js'],
        skills: ['./skills'],
      },
      scripts: { build: 'node build.mjs' },
    }));
    await fs.rm(path.join(root, 'extensions'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'prompts'), { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'skills', 'generated'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'generated', 'SKILL.md'), '# Generated\n');
    let fenceGeneration = 0;
    let generationDuringBuild = -1;
    runtime.spawnHook = (args) => {
      if (args.at(-2) !== 'run' || args.at(-1) !== 'build') return;
      generationDuringBuild = fenceGeneration;
      const entry = path.join(root, 'build', 'adapters', 'pi', 'extension.js');
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, 'export default function setup() {}\n');
    };
    const store = await import('../pi-package-store.js');
    const runtimeFence = vi.fn(() => { fenceGeneration += 1; });

    const installed = await mutateAuthorized(store, { action, source }, {
      onRuntimeInvalidationPublished: runtimeFence,
    });

    const spawnedArgs = runtime.spawns.map(({ args }) => args);
    expect(spawnedArgs.some((args) => (
      args.slice(-4).join('\0') === [
        'install', '--include=dev', '--no-audit', '--no-fund',
      ].join('\0')
    ))).toBe(true);
    expect(spawnedArgs.some((args) => args.slice(-2).join('\0') === 'run\0build')).toBe(true);
    expect(installed.affectedPackage).toMatchObject({
      source,
      enabled: true,
      resources: expect.arrayContaining([expect.objectContaining({ kind: 'extension' })]),
    });
    expect(generationDuringBuild).toBe(1);
    expect(runtimeFence).toHaveBeenNthCalledWith(1, 'commit');
    expect(runtimeFence).toHaveBeenNthCalledWith(2, 'post-build');
  });

  it.each([
    [
      'npm install',
      'install',
      'install',
      'getaddrinfo ENOTFOUND https://user:api-key@example.test/pkg?token=query-secret#fragment-secret /private/host/path',
      'source-unavailable',
    ],
    [
      'npm build',
      'update',
      'build',
      'fetch failed https://user:password@example.test/pkg?token=query-secret#fragment-secret /private/host/path',
      'source-unavailable',
    ],
    ['normal npm install', 'install', 'install', 'npm ERR! code ETARGET No matching version found', 'version-not-found'],
    ['normal npm build', 'update', 'build', 'npm ERR! code E404 package not found', 'package-not-found'],
  ] as const)('keeps native Pi success and logs only a stable category after %s fails', async (
    _label,
    action,
    phase,
    stderr,
    failureCategory,
  ) => {
    const { root, source } = await createPackage();
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'broken-generated-extension',
      version: '1.0.0',
      pi: {
        extensions: ['./build/adapters/pi/extension.js'],
        skills: ['./skills'],
      },
      scripts: { build: 'node build.mjs' },
    }));
    await fs.rm(path.join(root, 'extensions'), { recursive: true, force: true });
    await fs.rm(path.join(root, 'prompts'), { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'skills', 'generated'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'generated', 'SKILL.md'), '# Generated\n');
    let fenceGeneration = 0;
    let generationDuringFailure = -1;
    runtime.spawnHook = (args) => {
      const isTarget = phase === 'install'
        ? args.slice(-4).join('\0') === 'install\0--include=dev\0--no-audit\0--no-fund'
        : args.slice(-2).join('\0') === 'run\0build';
      if (isTarget) generationDuringFailure = fenceGeneration;
      runtime.stderr = isTarget ? stderr : '';
      runtime.exitCode = isTarget ? 1 : 0;
    };
    const store = await import('../pi-package-store.js');
    const runtimeFence = vi.fn(() => { fenceGeneration += 1; });

    const result = await mutateAuthorized(store, { action, source }, {
      onRuntimeInvalidationPublished: runtimeFence,
    });

    expect(result.affectedPackage).toMatchObject({ source, enabled: true });
    const assistanceLog = loggerRuntime.warn.mock.calls.find(
      ([message]) => message === (action === 'update'
        ? 'optional Pi package update build assistance failed'
        : 'optional Pi package build assistance failed'),
    );
    expect(assistanceLog?.[1]).toEqual({ failureCategory, mayHaveChangedState: true });
    expect(generationDuringFailure).toBe(1);
    expect(runtimeFence).toHaveBeenNthCalledWith(1, 'commit');
    expect(runtimeFence).toHaveBeenNthCalledWith(2, 'post-build');
    const published = JSON.stringify({ logs: loggerRuntime.warn.mock.calls, result });
    expect(published).not.toContain('api-key');
    expect(published).not.toContain('query-secret');
    expect(published).not.toContain('fragment-secret');
    expect(published).not.toContain('/private/host/path');
  });

  it('keeps an explicitly disabled Extension package disabled after a confirmed update', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: false });

    const updated = await mutateAuthorized(store, { action: 'update', source });

    expect(updated.affectedPackage).toMatchObject({
      source,
      enabled: false,
    });
  });

  it('does not re-enable a disabled package when its pre-update state read is uncertain', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: false });
    const stateFile = path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json');
    const originalReadFile = fs.readFile.bind(fs);
    let failedOnce = false;
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      target: Parameters<typeof fs.readFile>[0],
      options?: Parameters<typeof fs.readFile>[1],
    ) => {
      if (!failedOnce && path.resolve(String(target)) === path.resolve(stateFile)) {
        failedOnce = true;
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      }
      return originalReadFile(target, options as never);
    }) as typeof fs.readFile);
    try {
      await expect(mutateAuthorized(store, { action: 'update', source })).resolves.toMatchObject({
        affectedPackage: { source, enabled: false },
      });
    } finally {
      readSpy.mockRestore();
    }
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([source]);
  });

  it('does not disable an already-enabled npm Extension when another package is installed', async () => {
    const firstSource = 'npm:first-shared-extension';
    const secondSource = 'npm:second-shared-extension';
    const npmRoot = path.join(runtime.userData, 'pi-package-home', 'npm');
    const nodeModulesRoot = path.join(npmRoot, 'node_modules');
    const firstRoot = path.join(nodeModulesRoot, 'first-shared-extension');
    const secondRoot = path.join(nodeModulesRoot, 'second-shared-extension');
    const writeExtension = async (packageRoot: string, name: string) => {
      await fs.mkdir(path.join(packageRoot, 'extensions'), { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name,
        version: '1.0.0',
        pi: { extensions: ['./extensions/index.js'] },
      }));
      await fs.writeFile(
        path.join(packageRoot, 'extensions', 'index.js'),
        `module.exports = function setup${name.replace(/\W/g, '')}() {};\n`,
      );
    };
    await writeExtension(firstRoot, 'first-shared-extension');
    runtime.listOutput = `User packages:\n  ${firstSource}\n    ${firstRoot}\n`;
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, {
      action: 'set-enabled',
      source: firstSource,
      enabled: true,
    });

    runtime.holdMutationCommand = true;
    const installing = mutateAuthorized(store, {
      action: 'install',
      source: secondSource,
    });
    await vi.waitFor(() => {
      expect(runtime.spawns.at(-1)?.args).toEqual(
        expect.arrayContaining(['install', secondSource]),
      );
    });
    await writeExtension(secondRoot, 'second-shared-extension');
    runtime.listOutput = [
      'User packages:',
      `  ${firstSource}`,
      `    ${firstRoot}`,
      `  ${secondSource}`,
      `    ${secondRoot}`,
      '',
    ].join('\n');
    runtime.holdMutationCommand = false;
    runtime.pendingClose?.(0);
    const installed = await installing;

    expect(installed.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: firstSource, enabled: true }),
      expect.objectContaining({ source: secondSource, enabled: true }),
    ]));
    expect(installed.packages.every((pkg) => pkg.requiresExtensionApproval !== true)).toBe(true);
  });

  it('does not scan or revoke sibling package identities before a native install', async () => {
    const firstSource = 'npm:@scope/stale-shared-extension';
    const secondSource = 'npm:new-shared-extension';
    const npmRoot = path.join(runtime.userData, 'pi-package-home', 'npm');
    const nodeModulesRoot = path.join(npmRoot, 'node_modules');
    const firstRoot = path.join(nodeModulesRoot, '@scope', 'stale-shared-extension');
    const secondRoot = path.join(nodeModulesRoot, 'new-shared-extension');
    const dependencyRoot = path.join(nodeModulesRoot, '@scope', 'node_modules', 'shared-runtime-dependency');
    const writeExtension = async (packageRoot: string, name: string) => {
      await fs.mkdir(path.join(packageRoot, 'extensions'), { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name,
        version: '1.0.0',
        pi: { extensions: ['./extensions/index.js'] },
      }));
      await fs.writeFile(
        path.join(packageRoot, 'extensions', 'index.js'),
        `module.exports = function setup${name.replace(/\W/g, '')}() {};\n`,
      );
    };
    await writeExtension(firstRoot, 'stale-shared-extension');
    await fs.writeFile(path.join(firstRoot, 'package.json'), JSON.stringify({
      name: '@scope/stale-shared-extension', version: '1.0.0',
      dependencies: { 'shared-runtime-dependency': '^1.0.0' },
      pi: { extensions: ['./extensions/index.js'] },
    }));
    await fs.writeFile(
      path.join(firstRoot, 'extensions', 'index.js'),
      "require('shared-runtime-dependency');\nmodule.exports = function setupStale() {};\n",
    );
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'shared-runtime-dependency', version: '1.0.0', main: './index.js' }));
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), 'module.exports = "approved";\n');
    runtime.listOutput = `User packages:\n  ${firstSource}\n    ${firstRoot}\n`;
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, {
      action: 'set-enabled',
      source: firstSource,
      enabled: true,
    });
    runtime.holdMutationCommand = true;
    const installing = mutateAuthorized(store, {
      action: 'install',
      source: secondSource,
    });
    await vi.waitFor(() => {
      expect(runtime.spawns.at(-1)?.args).toEqual(
        expect.arrayContaining(['install', secondSource]),
      );
    });
    await fs.writeFile(
      path.join(dependencyRoot, 'index.js'),
      'module.exports = "changed-during-sibling-install";\n',
    );
    await writeExtension(secondRoot, 'new-shared-extension');
    runtime.listOutput = [
      'User packages:',
      `  ${firstSource}`,
      `    ${firstRoot}`,
      `  ${secondSource}`,
      `    ${secondRoot}`,
      '',
    ].join('\n');
    runtime.holdMutationCommand = false;
    runtime.pendingClose?.(0);
    const installed = await installing;

    expect(installed.packages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: firstSource,
        enabled: true,
      }),
      expect.objectContaining({ source: secondSource, enabled: true }),
    ]));
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as {
      approvedExtensionSources: string[];
      approvedExtensionFingerprints: Record<string, string>;
    };
    expect(state.approvedExtensionSources).toEqual([firstSource, secondSource]);
    expect(Object.keys(state.approvedExtensionFingerprints)).toEqual([firstSource, secondSource]);
  });

  it.skipIf(process.platform === 'win32')(
    'stages a read-only package directory before restoring its source mode',
    async () => {
      const { root } = await createPackage();
      const snapshotRoot = path.join(runtime.userData, 'read-only-package-snapshot');
      const stagedRoot = path.join(snapshotRoot, '0');
      await fs.chmod(root, 0o555);
      try {
        const store = await import('../pi-package-store.js');
        const snapshot = await store.stageManagedPackageSnapshot({
          extensions: [path.join(root, 'extensions', 'index.ts')],
          skills: [],
          promptTemplates: [path.join(root, 'prompts', 'hello.md')],
          packageRoots: [root],
        }, snapshotRoot);

        expect(snapshot).toMatchObject({
          extensions: [path.join(stagedRoot, 'extensions', 'index.ts')],
          promptTemplates: [path.join(stagedRoot, 'prompts', 'hello.md')],
          packageRoots: [stagedRoot],
        });
        await expect(fs.readFile(snapshot.extensions[0]!, 'utf8'))
          .resolves.toContain('managed-test');
        expect((await fs.stat(stagedRoot)).mode & 0o777).toBe(0o555);
        expect((await fs.readdir(runtime.userData)).some((entry) => (
          entry.startsWith(`${path.basename(snapshotRoot)}.tmp-`)
        ))).toBe(false);
      } finally {
        await fs.chmod(root, 0o755).catch(() => undefined);
        await fs.chmod(stagedRoot, 0o755).catch(() => undefined);
      }
    },
  );

  it('does not let package byte changes add a second decision to a precise enable action', async () => {
    const { root, source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
    const request = { action: 'set-enabled' as const, source, enabled: true };
    const grant = issuePiPackageMutationGrant(request);

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function replacedAfterConfirmation() {}',
    );
    await secondStore.listPiPackages();

    await expect(firstStore.mutatePiPackage(request, grant)).resolves.toMatchObject({
      affectedPackage: { source, enabled: true },
    });
    await expect(firstStore.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
  });

  it('preserves npm hoisted dependencies in the isolated session snapshot', async () => {
    const source = 'npm:hoisted-extension';
    const npmRoot = path.join(runtime.userData, 'pi-package-home', 'npm');
    const nodeModulesRoot = path.join(npmRoot, 'node_modules');
    const packageRoot = path.join(nodeModulesRoot, 'hoisted-extension');
    const dependencyRoot = path.join(nodeModulesRoot, 'hoisted-dependency');
    await fs.mkdir(path.join(packageRoot, 'extensions'), { recursive: true });
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'hoisted-extension',
      version: '1.0.0',
      dependencies: { 'hoisted-dependency': '1.0.0' },
      pi: { extensions: ['./extensions/index.js'] },
    }));
    await fs.writeFile(path.join(packageRoot, 'extensions', 'index.js'), [
      "const marker = require('hoisted-dependency');",
      'module.exports = { dependencyMarker: marker };',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'hoisted-dependency',
      version: '1.0.0',
      main: './index.js',
    }));
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), "module.exports = 'dependency-ok';\n");
    runtime.listOutput = `User packages:\n  ${source}\n    ${packageRoot}\n`;

    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });
    const snapshotRoot = path.join(runtime.userData, 'hoisted-session', 'managed-packages');
    const snapshot = await store.resolveManagedPiPackageResources({ snapshotRoot });
    const snapshotExtension = path.join(
      snapshotRoot,
      '0',
      'node_modules',
      'hoisted-extension',
      'extensions',
      'index.js',
    );

    expect(snapshot).toMatchObject({
      extensions: [snapshotExtension],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
    await expect(fs.readFile(
      path.join(snapshotRoot, '0', 'node_modules', 'hoisted-dependency', 'index.js'),
      'utf8',
    )).resolves.toContain('dependency-ok');
    const loaded = createRequire(snapshotExtension)(snapshotExtension) as {
      dependencyMarker: string;
    };
    expect(loaded.dependencyMarker).toBe('dependency-ok');

    await fs.writeFile(
      path.join(dependencyRoot, 'index.js'),
      "module.exports = 'changed-out-of-band';\n",
    );
    const changedSnapshotRoot = path.join(
      runtime.userData,
      'hoisted-session-after-change',
      'managed-packages',
    );
    await expect(store.resolveManagedPiPackageResources({ snapshotRoot: changedSnapshotRoot }))
      .resolves.toEqual({
        extensions: [],
        skills: [],
        promptTemplates: [],
        packageRoots: [],
      });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
  });

  it('keeps resources on their most specific approved root when snapshot roots overlap', async () => {
    const ancestorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-overlap-'));
    roots.push(ancestorRoot);
    const packageRoot = path.join(ancestorRoot, 'extension');
    const extensionFile = path.join(packageRoot, 'extensions', 'index.js');
    const skillFile = path.join(packageRoot, 'skills', 'sample', 'SKILL.md');
    const promptFile = path.join(packageRoot, 'prompts', 'hello.md');
    const ancestorDependency = path.join(ancestorRoot, 'node_modules', 'ancestor-only');
    await fs.mkdir(path.dirname(extensionFile), { recursive: true });
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.mkdir(path.dirname(promptFile), { recursive: true });
    await fs.mkdir(ancestorDependency, { recursive: true });
    await fs.writeFile(extensionFile, [
      "module.exports = require('ancestor-only');",
      '',
    ].join('\n'));
    await fs.writeFile(skillFile, '# Sample\n');
    await fs.writeFile(promptFile, 'Hello\n');
    await fs.writeFile(
      path.join(ancestorDependency, 'package.json'),
      JSON.stringify({ name: 'ancestor-only', version: '1.0.0', main: './index.js' }),
    );
    await fs.writeFile(path.join(ancestorDependency, 'index.js'), "module.exports = 'unapproved';\n");

    const store = await import('../pi-package-store.js');
    const snapshotRoot = path.join(runtime.userData, 'overlapping-roots-snapshot');
    const resources = await store.stageManagedPackageSnapshot({
      extensions: [extensionFile],
      skills: [{ path: skillFile, name: 'sample' }],
      promptTemplates: [promptFile],
      packageRoots: [ancestorRoot, packageRoot],
    }, snapshotRoot);

    expect(resources).toEqual({
      extensions: [path.join(snapshotRoot, '1', 'extensions', 'index.js')],
      skills: [{ path: path.join(snapshotRoot, '1', 'skills', 'sample', 'SKILL.md'), name: 'sample' }],
      promptTemplates: [path.join(snapshotRoot, '1', 'prompts', 'hello.md')],
      packageRoots: [path.join(snapshotRoot, '0'), path.join(snapshotRoot, '1')],
    });
    expect(() => createRequire(resources.extensions[0]!)(resources.extensions[0]!)).toThrow(
      /Cannot find module 'ancestor-only'/,
    );
  });

  it('invalidates a local extension approval when its copied bytes change out of band', async () => {
    const { root } = await createPackage();
    const source = root;
    runtime.listOutput = `User packages:\n  ${source}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });

    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function replacedWithoutMutationApi() {}\n',
    );
    const snapshotRoot = path.join(runtime.userData, 'local-changed-session', 'managed-packages');
    await expect(store.resolveManagedPiPackageResources({ snapshotRoot })).resolves.toEqual({
      extensions: [],
      skills: [],
      promptTemplates: [],
      packageRoots: [],
    });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
  });

  it('rejects and removes a completed snapshot whose copied bytes no longer match approval', async () => {
    const { root, source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });
    const snapshotRoot = path.join(runtime.userData, 'tampered-session', 'managed-packages');
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(snapshotRoot)) {
        await fs.writeFile(
          path.join(String(from), '0', 'extensions', 'index.ts'),
          'export default function replacedInCompletedCopy() {}\n',
        );
      }
      return originalRename(from, to);
    });
    try {
      await expect(store.resolveManagedPiPackageResources({ snapshotRoot })).resolves.toEqual({
        extensions: [],
        skills: [],
        promptTemplates: [],
        packageRoots: [],
      });
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.stat(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { approvedExtensionSources: string[]; approvedExtensionFingerprints: Record<string, string> };
    expect(state.approvedExtensionSources).toEqual([]);
    expect(state.approvedExtensionFingerprints).toEqual({});
  });

  it('invalidates an installed npm extension approval when its package tree changes out of band', async () => {
    const source = 'npm:managed-tree-extension';
    const packageRoot = path.join(
      runtime.userData,
      'pi-package-home',
      'npm',
      'node_modules',
      'managed-tree-extension',
    );
    await fs.mkdir(path.join(packageRoot, 'extensions'), { recursive: true });
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'managed-tree-extension',
      version: '1.0.0',
      pi: { extensions: ['./extensions/index.js'] },
    }));
    await fs.writeFile(
      path.join(packageRoot, 'extensions', 'index.js'),
      'module.exports = function setup() {};\n',
    );
    runtime.listOutput = `User packages:\n  ${source}\n    ${packageRoot}\n`;
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });

    await fs.writeFile(
      path.join(packageRoot, 'extensions', 'index.js'),
      'module.exports = function changedWithoutMutationApi() {};\n',
    );
    const snapshotRoot = path.join(runtime.userData, 'npm-changed-session', 'managed-packages');
    await expect(store.resolveManagedPiPackageResources({ snapshotRoot })).resolves.toEqual({
      extensions: [],
      skills: [],
      promptTemplates: [],
      packageRoots: [],
    });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
  });

  it.each([
    { name: 'entry', limits: { maxEntries: 1, maxBytes: 1024 * 1024, maxDurationMs: 10_000 } },
    { name: 'byte', limits: { maxEntries: 100, maxBytes: 1, maxDurationMs: 10_000 } },
    { name: 'time', limits: { maxEntries: 100, maxBytes: 1024 * 1024, maxDurationMs: 0 } },
  ])('skips and cleans up package roots that exceed the $name budget', async ({ limits }) => {
    const { root } = await createPackage();
    const store = await import('../pi-package-store.js');
    const snapshotRoot = path.join(
      runtime.userData,
      `limited-snapshot-${limits.maxEntries}-${limits.maxBytes}`,
    );

    await expect(store.stageManagedPackageSnapshot(
      {
        extensions: [path.join(root, 'extensions', 'index.ts')],
        skills: [],
        promptTemplates: [path.join(root, 'prompts', 'hello.md')],
        packageRoots: [root],
      },
      snapshotRoot,
      limits,
    )).resolves.toEqual({
      extensions: [],
      skills: [],
      promptTemplates: [],
      packageRoots: [],
    });
    await expect(fs.readdir(snapshotRoot)).resolves.toEqual([]);
    const leftovers = (await fs.readdir(runtime.userData)).filter((entry) => (
      entry.startsWith(`${path.basename(snapshotRoot)}.tmp-`)
    ));
    expect(leftovers).toEqual([]);
  });

  it('rejects a directly installed file package replaced during stable path resolution', async () => {
    const packageFile = path.join(runtime.userData, 'direct-extension.ts');
    const outsideFile = path.join(runtime.userData, 'host-private.ts');
    await fs.writeFile(packageFile, 'export default function approved() {}\n');
    await fs.writeFile(outsideFile, 'export default function hostPrivate() {}\n');
    runtime.listOutput = `User packages:\n  ${packageFile}\n    ${packageFile}\n`;
    const originalLstat = fs.lstat.bind(fs);
    let replaced = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, options) => {
      const stat = await originalLstat(target, options as never);
      if (!replaced && path.resolve(String(target)) === path.resolve(packageFile)) {
        replaced = true;
        await fs.rm(packageFile);
        await fs.symlink(outsideFile, packageFile, 'file');
      }
      return stat;
    });
    try {
      const store = await import('../pi-package-store.js');
      await expect(store.listPiPackages()).resolves.toMatchObject({
        packages: [{
          source: packageFile,
          enabled: true,
          warning: 'inspection-failed',
        }],
      });
      await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
        extensions: [], skills: [], promptTemplates: [], packageRoots: [],
      });
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it('rejects a directly installed file package replaced after fingerprint realpath', async () => {
    const packageFile = path.join(runtime.userData, 'fingerprint-direct-extension.ts');
    const outsideFile = path.join(runtime.userData, 'fingerprint-host-private.ts');
    await fs.writeFile(packageFile, 'export default function approved() {}\n');
    await fs.writeFile(outsideFile, 'export default function hostPrivate() {}\n');
    runtime.listOutput = `User packages:\n  ${packageFile}\n    ${packageFile}\n`;
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source: packageFile, enabled: true });
    const snapshotRoot = path.join(runtime.userData, 'fingerprint-direct-file-snapshot');
    const canonicalPackageFile = await fs.realpath(packageFile);
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now + 2_000);

    const originalRealpath = fs.realpath.bind(fs);
    let replaced = false;
    let packageRealpathCalls = 0;
    const realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
      const resolved = await originalRealpath(...args);
      if (path.resolve(String(args[0])) === path.resolve(canonicalPackageFile)) {
        packageRealpathCalls += 1;
      }
      // A fresh direct-file inspection resolves the root twice, compatibility
      // resolves the entry twice, and fingerprinting starts with the fifth
      // package-file realpath. Replace only after that realpath has returned.
      if (!replaced && packageRealpathCalls === 5) {
        replaced = true;
        await fs.rm(packageFile);
        await fs.symlink(outsideFile, packageFile, 'file');
      }
      return resolved;
    });
    let resolvedResources;
    try {
      resolvedResources = await store.resolveManagedPiPackageResources({ snapshotRoot });
      await expect(store.listPiPackages()).resolves.toMatchObject({
        packages: [{
          source: packageFile,
          enabled: true,
        }],
      });
    } finally {
      realpathSpy.mockRestore();
      nowSpy.mockRestore();
    }

    expect(replaced).toBe(true);
    expect(packageRealpathCalls).toBeGreaterThanOrEqual(5);
    expect(resolvedResources).toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
    await expect(fs.readdir(snapshotRoot)).resolves.toEqual([]);
  });

  it.skipIf(!canLinkFile)('rejects a direct file snapshot whose package root is replaced by a symlink', async () => {
    const packageFile = path.join(runtime.userData, 'snapshot-direct-extension.ts');
    const outsideFile = path.join(runtime.userData, 'snapshot-host-private.ts');
    await fs.writeFile(packageFile, 'export default function approved() {}\n');
    await fs.writeFile(outsideFile, 'export default function hostPrivate() {}\n');
    const snapshotRoot = path.join(runtime.userData, 'direct-file-race-snapshot');
    const originalLstat = fs.lstat.bind(fs);
    let replaced = false;
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, options) => {
      const stat = await originalLstat(target, options as never);
      if (!replaced && path.resolve(String(target)) === path.resolve(packageFile)) {
        replaced = true;
        await fs.rm(packageFile);
        await fs.symlink(outsideFile, packageFile, 'file');
      }
      return stat;
    });
    try {
      const store = await import('../pi-package-store.js');
      await expect(store.stageManagedPackageSnapshot({
        extensions: [packageFile],
        skills: [],
        promptTemplates: [],
        packageRoots: [packageFile],
      }, snapshotRoot)).rejects.toThrow(/root changed before snapshotting/);
    } finally {
      lstatSpy.mockRestore();
    }

    await expect(fs.stat(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const leftovers = (await fs.readdir(runtime.userData)).filter((entry) => (
      entry.startsWith(`${path.basename(snapshotRoot)}.tmp-`)
    ));
    expect(leftovers).toEqual([]);
  });

  it.each([
    { kind: 'Skill', phase: 'before read', mismatchCall: 1, relativePath: path.join('skills', 'sample', 'SKILL.md') },
    { kind: 'Skill', phase: 'after read', mismatchCall: 2, relativePath: path.join('skills', 'sample', 'SKILL.md') },
    { kind: 'Prompt', phase: 'before read', mismatchCall: 1, relativePath: path.join('prompts', 'hello.md') },
    { kind: 'Prompt', phase: 'after read', mismatchCall: 2, relativePath: path.join('prompts', 'hello.md') },
  ])('rejects a $kind source whose opened handle changes $phase', async ({
    mismatchCall,
    relativePath,
  }) => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-snapshot-race-'));
    roots.push(packageRoot);
    const sourceFile = path.join(packageRoot, relativePath);
    const outsideFile = path.join(runtime.userData, `outside-${path.basename(sourceFile)}`);
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(sourceFile, 'approved package content\n');
    await fs.writeFile(outsideFile, 'host-private-content\n');

    const snapshotRoot = path.join(runtime.userData, `raced-${path.basename(sourceFile)}-snapshot`);
    const outsideStat = await fs.stat(outsideFile);
    const probeHandle = await fs.open(sourceFile, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
      stat: typeof probeHandle.stat;
    };
    await probeHandle.close();
    const originalHandleStat = fileHandlePrototype.stat;
    let sourceStatCalls = 0;
    Object.defineProperty(fileHandlePrototype, 'stat', {
      configurable: true,
      value: async function (...args: Parameters<typeof probeHandle.stat>) {
        sourceStatCalls += 1;
        if (sourceStatCalls === mismatchCall) {
          return outsideStat;
        }
        return originalHandleStat.apply(this, args);
      },
      writable: true,
    });
    try {
      const store = await import('../pi-package-store.js');
      await expect(store.stageManagedPackageSnapshot({
        extensions: [],
        skills: relativePath.endsWith('SKILL.md') ? [{ path: sourceFile, name: 'sample' }] : [],
        promptTemplates: relativePath.endsWith('SKILL.md') ? [] : [sourceFile],
        packageRoots: [packageRoot],
      }, snapshotRoot)).rejects.toThrow(/changed (?:before|while) copying snapshot/);
    } finally {
      Object.defineProperty(fileHandlePrototype, 'stat', {
        configurable: true,
        value: originalHandleStat,
        writable: true,
      });
    }

    expect(sourceStatCalls).toBe(mismatchCall);
    await expect(fs.stat(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    const leftovers = (await fs.readdir(runtime.userData)).filter((entry) => (
      entry.startsWith(`${path.basename(snapshotRoot)}.tmp-`)
    ));
    expect(leftovers).toEqual([]);
  });

  it('keeps earlier package roots when the aggregate snapshot budget is exhausted', async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-budget-first-'));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-budget-second-'));
    roots.push(firstRoot, secondRoot);
    const firstSkill = path.join(firstRoot, 'SKILL.md');
    const secondSkill = path.join(secondRoot, 'SKILL.md');
    await Promise.all([
      fs.writeFile(firstSkill, '# First\n'),
      fs.writeFile(secondSkill, '# Second\n'),
    ]);

    const store = await import('../pi-package-store.js');
    const snapshotRoot = path.join(runtime.userData, 'independent-package-budgets');
    const snapshot = await store.stageManagedPackageSnapshot({
      extensions: [],
      skills: [
        { path: firstSkill, name: 'first' },
        { path: secondSkill, name: 'second' },
      ],
      promptTemplates: [],
      packageRoots: [firstRoot, secondRoot],
    }, snapshotRoot, {
      maxEntries: 3,
      maxBytes: 1024,
      maxDurationMs: 10_000,
    });

    expect(snapshot.skills).toEqual([
      { path: path.join(snapshotRoot, '0', 'SKILL.md'), name: 'first' },
    ]);
    expect(snapshot.packageRoots).toEqual([path.join(snapshotRoot, '0')]);
    await expect(Promise.all(snapshot.skills.map((skill) => fs.readFile(skill.path, 'utf8'))))
      .resolves.toEqual(['# First\n']);
    await expect(fs.stat(path.join(snapshotRoot, '1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps earlier packages available when a later package exceeds its copy duration', async () => {
    const sources = ['npm:fast-skill', 'npm:slow-skill'];
    const packageRoots = await Promise.all(sources.map(async (source, index) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `cindy-pi-package-duration-${index}-`));
      roots.push(root);
      const skillRoot = path.join(root, 'skills', `skill-${index}`);
      await fs.mkdir(skillRoot, { recursive: true });
      await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
        '---',
        `name: skill-${index}`,
        `description: package ${index}`,
        '---',
        'body',
        '',
      ].join('\n'));
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: source.slice(4),
        pi: { skills: ['./skills'] },
      }));
      return root;
    }));
    runtime.listOutput = [
      'User packages:',
      ...sources.flatMap((source, index) => [`  ${source}`, `    ${packageRoots[index]}`]),
      '',
    ].join('\n');

    const store = await import('../pi-package-store.js');
    const snapshotRoot = path.join(runtime.userData, 'package-duration-isolation');
    const originalMkdir = fs.mkdir.bind(fs);
    let now = Date.now();
    let delayedSecondPackage = false;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (
        !delayedSecondPackage
        && target.startsWith(`${snapshotRoot}.tmp-`)
        && path.basename(target) === '1'
      ) {
        delayedSecondPackage = true;
        now += 20_000;
      }
      return originalMkdir(...args);
    });

    let snapshot;
    try {
      snapshot = await store.resolveManagedPiPackageResources({
        snapshotRoot,
        snapshotLimits: {
          maxEntries: 100,
          maxBytes: 1024 * 1024,
          maxDurationMs: 10_000,
        },
      });
    } finally {
      mkdirSpy.mockRestore();
      nowSpy.mockRestore();
    }

    expect(delayedSecondPackage).toBe(true);
    expect(snapshot).toEqual({
      extensions: [],
      skills: [{
        path: path.join(snapshotRoot, '0', 'skills', 'skill-0', 'SKILL.md'),
        name: 'skill-0',
        description: 'package 0',
      }],
      promptTemplates: [],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
    await expect(fs.stat(path.join(snapshotRoot, '1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        { source: sources[0], enabled: true },
        { source: sources[1], enabled: true, warning: 'inspection-limit' },
      ],
    });
  });

  it('keeps earlier roots when a later copied root exceeds fingerprint budget', async () => {
    const first = await createPackage({ source: 'npm:fingerprint-first' });
    const second = await createPackage({ source: 'npm:fingerprint-second' });
    runtime.listOutput = [
      'User packages:',
      `  ${first.source}`,
      `    ${first.root}`,
      `  ${second.source}`,
      `    ${second.root}`,
      '',
    ].join('\n');

    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source: first.source, enabled: true });
    await mutateAuthorized(store, { action: 'set-enabled', source: second.source, enabled: true });

    const snapshotRoot = path.join(runtime.userData, 'fingerprint-package-isolation');
    const originalOpen = fs.open.bind(fs);
    let now = Date.now();
    let delayedSecondRoot = false;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (
        !delayedSecondRoot
        && target.includes(`${path.sep}fingerprint-package-isolation${path.sep}1${path.sep}`)
      ) {
        delayedSecondRoot = true;
        now += 20_000;
      }
      return originalOpen(...args);
    });

    let snapshot;
    try {
      snapshot = await store.resolveManagedPiPackageResources({
        snapshotRoot,
        snapshotLimits: {
          maxEntries: 100,
          maxBytes: 1024 * 1024,
          maxDurationMs: 10_000,
        },
      });
    } finally {
      openSpy.mockRestore();
      nowSpy.mockRestore();
    }

    expect(delayedSecondRoot).toBe(true);
    expect(snapshot.packageRoots).toEqual([path.join(snapshotRoot, '0')]);
    expect(snapshot.extensions).toEqual([
      path.join(snapshotRoot, '0', 'extensions', 'index.ts'),
    ]);
    await expect(fs.stat(path.join(snapshotRoot, '1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        { source: first.source, enabled: true },
        { source: second.source, enabled: true, warning: 'inspection-limit' },
      ],
    });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { snapshotUnavailableRoots: Record<string, string> };
    expect(state.snapshotUnavailableRoots).toEqual({
      [await fs.realpath(second.root)]: 'inspection-limit',
    });
  });

  it('isolates current and later roots when aggregate fingerprint budget is exhausted', async () => {
    const packages = await Promise.all([
      createPackage({ source: 'npm:aggregate-fingerprint-first' }),
      createPackage({ source: 'npm:aggregate-fingerprint-second' }),
      createPackage({ source: 'npm:aggregate-fingerprint-third' }),
    ]);
    runtime.listOutput = [
      'User packages:',
      ...packages.flatMap((pkg) => [`  ${pkg.source}`, `    ${pkg.root}`]),
      '',
    ].join('\n');

    const store = await import('../pi-package-store.js');
    for (const pkg of packages) {
      await mutateAuthorized(store, { action: 'set-enabled', source: pkg.source, enabled: true });
    }

    const snapshotRoot = path.join(runtime.userData, 'aggregate-fingerprint-isolation');
    const originalLstat = fs.lstat.bind(fs);
    let now = Date.now();
    let advancedForSecondRoot = false;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const target = String(args[0]);
      if (
        !advancedForSecondRoot
        && path.resolve(target) === path.resolve(path.join(snapshotRoot, '1'))
      ) {
        advancedForSecondRoot = true;
        now += 20_000;
      }
      return originalLstat(...args);
    });

    let snapshot;
    try {
      snapshot = await store.resolveManagedPiPackageResources({
        snapshotRoot,
        snapshotLimits: {
          maxEntries: 100,
          maxBytes: 1024 * 1024,
          maxDurationMs: 10_000,
        },
      });
    } finally {
      lstatSpy.mockRestore();
      nowSpy.mockRestore();
    }

    expect(advancedForSecondRoot).toBe(true);
    expect(snapshot.packageRoots).toEqual([path.join(snapshotRoot, '0')]);
    expect(snapshot.extensions).toEqual([
      path.join(snapshotRoot, '0', 'extensions', 'index.ts'),
    ]);
    await expect(fs.stat(path.join(snapshotRoot, '1'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(snapshotRoot, '2'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        { source: packages[0]!.source, enabled: true },
        { source: packages[1]!.source, enabled: true, warning: 'inspection-limit' },
        { source: packages[2]!.source, enabled: true, warning: 'inspection-limit' },
      ],
    });
  });

  it('omits resources owned by a skipped descendant instead of mapping them through a copied ancestor', async () => {
    const ancestorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-budget-overlap-'));
    roots.push(ancestorRoot);
    const descendantRoot = path.join(ancestorRoot, 'extension');
    const extensionFile = path.join(descendantRoot, 'extensions', 'index.js');
    const ancestorPrompt = path.join(ancestorRoot, 'prompts', 'ancestor.md');
    await fs.mkdir(path.dirname(extensionFile), { recursive: true });
    await fs.mkdir(path.dirname(ancestorPrompt), { recursive: true });
    await fs.writeFile(extensionFile, 'module.exports = function setup() {};\n');
    await fs.writeFile(ancestorPrompt, 'Ancestor prompt\n');

    const store = await import('../pi-package-store.js');
    const snapshotRoot = path.join(runtime.userData, 'overlapping-package-budget');
    const snapshot = await store.stageManagedPackageSnapshot({
      extensions: [extensionFile],
      skills: [],
      promptTemplates: [ancestorPrompt],
      packageRoots: [ancestorRoot, descendantRoot],
    }, snapshotRoot, {
      // The ancestor tree itself has six entries. Copying the descendant as a
      // second package root must therefore hit the shared aggregate limit.
      maxEntries: 6,
      maxBytes: 1024 * 1024,
      maxDurationMs: 10_000,
    });

    expect(snapshot).toEqual({
      extensions: [],
      skills: [],
      promptTemplates: [path.join(snapshotRoot, '0', 'prompts', 'ancestor.md')],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
    await expect(fs.readFile(snapshot.promptTemplates[0]!, 'utf8'))
      .resolves.toBe('Ancestor prompt\n');
    await expect(fs.stat(path.join(snapshotRoot, '1'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('projects aggregate snapshot limits without persisting package disables', async () => {
    const sources = [
      await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-budget-local-')),
      'git:https://example.com/acme/budget-git.git',
      'npm:budget-npm',
    ];
    const packageRoots = await Promise.all(sources.map(async (source, index) => {
      const root = index === 0
        ? source
        : await fs.mkdtemp(path.join(os.tmpdir(), `cindy-pi-package-budget-${index}-`));
      roots.push(root);
      await fs.mkdir(path.join(root, 'skills', `skill-${index}`), { recursive: true });
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: `budget-package-${index}`,
        pi: { skills: ['./skills'] },
      }));
      await fs.writeFile(
        path.join(root, 'skills', `skill-${index}`, 'SKILL.md'),
        `# Skill ${index}\n`,
      );
      return root;
    }));
    runtime.listOutput = [
      'User packages:',
      ...sources.flatMap((source, index) => [`  ${source}`, `    ${packageRoots[index]}`]),
      '',
    ].join('\n');

    const store = await import('../pi-package-store.js');
    const snapshotRoot = path.join(runtime.userData, 'aggregate-package-budget');
    const snapshot = await store.resolveManagedPiPackageResources({
      snapshotRoot,
      snapshotLimits: {
        maxEntries: 7,
        maxBytes: 1024 * 1024,
        maxDurationMs: 10_000,
      },
    });

    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        name: 'SKILL',
        path: path.join(snapshotRoot, '0', 'skills', 'skill-0', 'SKILL.md'),
      }),
    ]);
    expect(snapshot.packageRoots).toEqual([path.join(snapshotRoot, '0')]);
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        { enabled: true },
        { enabled: true, warning: 'inspection-limit' },
        { enabled: true, warning: 'inspection-limit' },
      ],
    });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[]; snapshotUnavailableRoots: Record<string, string> };
    expect(state.disabledSources).toEqual([]);
    expect(state.snapshotUnavailableRoots).toEqual({
      [await fs.realpath(packageRoots[1]!)]: 'inspection-limit',
      [await fs.realpath(packageRoots[2]!)]: 'inspection-limit',
    });
  });

  it('does not run a skipped descendant extension from an unverified ancestor snapshot', async () => {
    const ancestorRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-approved-overlap-'));
    roots.push(ancestorRoot);
    const descendantRoot = path.join(ancestorRoot, 'extension');
    const ancestorSkill = path.join(ancestorRoot, 'skills', 'ancestor', 'SKILL.md');
    const extensionFile = path.join(descendantRoot, 'extensions', 'index.js');
    await fs.mkdir(path.dirname(ancestorSkill), { recursive: true });
    await fs.mkdir(path.dirname(extensionFile), { recursive: true });
    await fs.writeFile(path.join(ancestorRoot, 'package.json'), JSON.stringify({
      name: 'ancestor-data-package',
      version: '1.0.0',
      pi: { skills: ['./skills'] },
    }));
    await fs.writeFile(ancestorSkill, '# Ancestor\n');
    await fs.writeFile(path.join(descendantRoot, 'package.json'), JSON.stringify({
      name: 'approved-descendant-extension',
      version: '1.0.0',
      pi: { extensions: ['./extensions/index.js'] },
    }));
    await fs.writeFile(extensionFile, 'module.exports = function approvedSetup() {};\n');
    runtime.listOutput = [
      'User packages:',
      `  ${ancestorRoot}`,
      `    ${ancestorRoot}`,
      `  ${descendantRoot}`,
      `    ${descendantRoot}`,
      '',
    ].join('\n');

    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, {
      action: 'set-enabled',
      source: descendantRoot,
      enabled: true,
    });
    const snapshotRoot = path.join(runtime.userData, 'approved-overlapping-package-budget');
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(snapshotRoot)) {
        await fs.writeFile(
          path.join(String(from), '0', 'extension', 'extensions', 'index.js'),
          'module.exports = function changedAfterApproval() {};\n',
        );
      }
      return originalRename(from, to);
    });
    let snapshot;
    try {
      snapshot = await store.resolveManagedPiPackageResources({
        snapshotRoot,
        snapshotLimits: {
          // The ancestor tree has nine entries. Its nested extension root is
          // skipped when the same tree is encountered as the next package.
          maxEntries: 9,
          maxBytes: 1024 * 1024,
          maxDurationMs: 10_000,
        },
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(snapshot).toMatchObject({
      extensions: [],
      skills: [{ path: path.join(snapshotRoot, '0', 'skills', 'ancestor', 'SKILL.md') }],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        { source: ancestorRoot, enabled: true },
        { source: descendantRoot, enabled: true, warning: 'inspection-limit' },
      ],
    });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([]);
  });

  it('keeps a snapshot timeout advisory across cache expiry until staging succeeds', async () => {
    const { root, source } = await createPackage();
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const store = await import('../pi-package-store.js');
      await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });
      const listener = vi.fn();
      const unsubscribe = store.onPiPackagesChanged(listener);
      try {
        await expect(store.resolveManagedPiPackageResources({
          snapshotRoot: path.join(runtime.userData, 'timed-out-package-snapshot'),
          snapshotLimits: {
            maxEntries: 100,
            maxBytes: 1024 * 1024,
            maxDurationMs: 0,
          },
        })).resolves.toEqual({
          extensions: [],
          skills: [],
          promptTemplates: [],
          packageRoots: [],
        });
        expect(listener).toHaveBeenCalledTimes(1);

        // The failed staging started from a fresh inspection whose one-second
        // cache is now stale. A Renderer refresh must still see the projected
        // failure instead of rebuilding an enabled view from raw inspection.
        nowSpy.mockReturnValue(now + 2_000);
        await expect(store.listPiPackages()).resolves.toMatchObject({
          packages: [{ source, enabled: true, warning: 'inspection-limit' }],
        });
        await expect(store.listManagedPiPromptCommands()).resolves.toEqual([]);

        const recoveredSnapshotRoot = path.join(runtime.userData, 'recovered-package-snapshot');
        await expect(store.resolveManagedPiPackageResources({
          snapshotRoot: recoveredSnapshotRoot,
          snapshotLimits: {
            maxEntries: 100,
            maxBytes: 1024 * 1024,
            maxDurationMs: 10_000,
          },
        })).resolves.toMatchObject({
          extensions: [path.join(recoveredSnapshotRoot, '0', 'extensions', 'index.ts')],
          packageRoots: [path.join(recoveredSnapshotRoot, '0')],
        });
        expect(listener).toHaveBeenCalledTimes(2);

        nowSpy.mockReturnValue(now + 4_000);
        const recoveredList = await store.listPiPackages();
        expect(recoveredList).toMatchObject({
          packages: [{ source, enabled: true }],
        });
        expect(recoveredList.packages[0]?.warning).toBeUndefined();
        await expect(store.listManagedPiPromptCommands()).resolves.not.toEqual([]);
        const state = JSON.parse(await fs.readFile(
          path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
          'utf8',
        )) as { disabledSources: string[] };
        expect(state.disabledSources).toEqual([]);
        await expect(fs.readFile(
          path.join(root, 'extensions', 'index.ts'),
          'utf8',
        )).resolves.toContain('managed-test');
      } finally {
        unsubscribe();
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shares snapshot failures across instances and clears them after a successful staging', async () => {
    const { source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    await mutateAuthorized(firstStore, { action: 'set-enabled', source, enabled: true });

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    const secondListener = vi.fn();
    const unsubscribeSecond = secondStore.onPiPackagesChanged(secondListener);
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await expect(firstStore.resolveManagedPiPackageResources({
        snapshotRoot: path.join(runtime.userData, 'first-instance-failed-snapshot'),
        snapshotLimits: {
          maxEntries: 100,
          maxBytes: 1024 * 1024,
          maxDurationMs: 0,
        },
      })).resolves.toEqual({
        extensions: [],
        skills: [],
        promptTemplates: [],
        packageRoots: [],
      });
      await vi.waitFor(() => expect(secondListener).toHaveBeenCalledWith('external'), {
        timeout: 2_000,
      });
      await expect(secondStore.listPiPackages()).resolves.toMatchObject({
        packages: [{ source, enabled: true, warning: 'inspection-limit' }],
      });

      const firstListener = vi.fn();
      const unsubscribeFirst = firstStore.onPiPackagesChanged(firstListener);
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        const recoveredRoot = path.join(runtime.userData, 'second-instance-recovered-snapshot');
        await expect(secondStore.resolveManagedPiPackageResources({
          snapshotRoot: recoveredRoot,
        })).resolves.toMatchObject({
          extensions: [path.join(recoveredRoot, '0', 'extensions', 'index.ts')],
          packageRoots: [path.join(recoveredRoot, '0')],
        });
        await vi.waitFor(() => expect(firstListener).toHaveBeenCalledWith('external'), {
          timeout: 2_000,
        });
        await expect(firstStore.listPiPackages()).resolves.toMatchObject({
          packages: [{ source, enabled: true }],
        });
        const state = JSON.parse(await fs.readFile(
          path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
          'utf8',
        )) as { snapshotUnavailableRoots: Record<string, string> };
        expect(state.snapshotUnavailableRoots).toEqual({});
      } finally {
        unsubscribeFirst();
      }
    } finally {
      unsubscribeSecond();
    }
  });

  it.runIf(process.platform !== 'win32').each([
    { layout: 'local' as const, source: 'local' },
    { layout: 'npm' as const, source: 'npm:mode-preserving-extension' },
  ])('preserves directory and file modes for $layout snapshots under a simulated restrictive umask', async ({
    layout,
    source: requestedSource,
  }) => {
    const packageRoot = layout === 'npm'
      ? path.join(
          runtime.userData,
          'pi-package-home',
          'npm',
          'node_modules',
          'mode-preserving-extension',
        )
      : await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-mode-local-'));
    if (layout === 'local') roots.push(packageRoot);
    const extensionDir = path.join(packageRoot, 'extensions');
    const extensionFile = path.join(extensionDir, 'index.js');
    const manifestFile = path.join(packageRoot, 'package.json');
    await fs.mkdir(extensionDir, { recursive: true });
    await fs.writeFile(manifestFile, JSON.stringify({
      name: 'mode-preserving-extension',
      version: '1.0.0',
      pi: { extensions: ['./extensions/index.js'] },
    }));
    await fs.writeFile(extensionFile, 'module.exports = function setup() {};\n');

    const directories = layout === 'npm'
      ? [
          path.join(runtime.userData, 'pi-package-home', 'npm'),
          path.join(runtime.userData, 'pi-package-home', 'npm', 'node_modules'),
          packageRoot,
          extensionDir,
        ]
      : [packageRoot, extensionDir];
    await Promise.all(directories.map((directory) => fs.chmod(directory, 0o775)));
    await Promise.all([manifestFile, extensionFile].map((file) => fs.chmod(file, 0o664)));

    const source = layout === 'local' ? packageRoot : requestedSource;
    runtime.listOutput = `User packages:\n  ${source}\n    ${packageRoot}\n`;
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });

    const snapshotRoot = path.join(runtime.userData, `${layout}-mode-session`, 'managed-packages');
    const temporaryPrefix = `${snapshotRoot}.tmp-`;
    const originalMkdir = fs.mkdir.bind(fs);
    const originalOpen = fs.open.bind(fs);
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation((async (
      target: Parameters<typeof fs.mkdir>[0],
      options?: Parameters<typeof fs.mkdir>[1],
    ) => {
      if (
        String(target).startsWith(temporaryPrefix)
        && options
        && typeof options === 'object'
        && typeof options.mode === 'number'
      ) {
        return originalMkdir(target, { ...options, mode: options.mode & ~0o027 });
      }
      return originalMkdir(target, options);
    }) as typeof fs.mkdir);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (
      target: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: number,
    ) => originalOpen(
      target,
      flags,
      String(target).startsWith(temporaryPrefix) && flags === 'wx' && typeof mode === 'number'
        ? mode & ~0o027
        : mode,
    )) as typeof fs.open);
    try {
      const resources = await store.resolveManagedPiPackageResources({ snapshotRoot });
      expect(resources.extensions).toHaveLength(1);
      const copiedExtension = resources.extensions[0]!;
      expect((await fs.stat(path.dirname(copiedExtension))).mode & 0o777).toBe(0o775);
      expect((await fs.stat(copiedExtension)).mode & 0o777).toBe(0o664);
      const listed = await store.listPiPackages();
      expect(listed).toMatchObject({ packages: [{ source, enabled: true }] });
      expect(listed.packages[0]).not.toHaveProperty('requiresExtensionApproval');
    } finally {
      mkdirSpy.mockRestore();
      openSpy.mockRestore();
    }
  });

  it('preserves v1 disabled sources while migrating approval state and lets confirmed installs build', async () => {
    const { source } = await createPackage();
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'cindy-package-state.json'), JSON.stringify({
      version: 1,
      disabledSources: [source, 'npm:keep-disabled'],
    }));
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    });
    const migrated = JSON.parse(await fs.readFile(
      path.join(stateDir, 'cindy-package-state.json'),
      'utf8',
    )) as {
      version: number;
      disabledSources: string[];
      approvedExtensionSources: string[];
      approvedExtensionFingerprints: Record<string, string>;
      snapshotUnavailableRoots: Record<string, string>;
    };
    expect(migrated).toEqual({
      version: 3,
      disabledSources: ['npm:keep-disabled'],
      approvedExtensionSources: [source],
      approvedExtensionFingerprints: {
        [source]: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      snapshotUnavailableRoots: {},
    });

    await mutateAuthorized(store, { action: 'install', source });
    const installSpawn = runtime.spawns.find(({ args }) => args.includes('install'));
    expect(installSpawn?.env.npm_config_ignore_scripts).toBe('false');
    expect(installSpawn?.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('false');
    expect(installSpawn?.args).toContain('--no-approve');
  });

  it('clears a relative disable alias when the same local package is reinstalled by absolute path', async () => {
    const relativeSource = './same-directory/relative-package';
    const sibling = './same-directory/sibling-package';
    const created = await createPackage({ source: relativeSource });
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const absoluteSource = path.join(stateDir, 'same-directory', 'relative-package');
    await fs.mkdir(path.dirname(absoluteSource), { recursive: true });
    await fs.rename(created.root, absoluteSource);
    runtime.listOutput = `User packages:\n  ${relativeSource}\n    ${absoluteSource}\n`;
    await fs.mkdir(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    await fs.writeFile(stateFile, JSON.stringify({
      version: 3,
      disabledSources: [relativeSource, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    const store = await import('../pi-package-store.js');
    runtime.listOutcomes = Array.from({ length: 4 }, () => ({
      stderr: 'projection unavailable',
      exitCode: 1,
    }));
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(stateFile)) {
        throw Object.assign(new Error('simulated state EIO'), { code: 'EIO' });
      }
      return originalRename(from, to);
    });
    try {
      await expect(mutateAuthorized(store, {
        action: 'install',
        source: absoluteSource,
      })).resolves.toMatchObject({
        projectionUnavailable: true,
        affectedPackage: { source: absoluteSource, enabled: true },
      });
    } finally {
      renameSpy.mockRestore();
    }
    let state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([relativeSource, sibling]);
    runtime.listOutcomes = [];
    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([absoluteSource]);

    await mutateAuthorized(store, { action: 'install', source: absoluteSource });
    state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([sibling]);
  });

  it.each([
    ['transient I/O', 'EIO'],
    ['permission', 'EACCES'],
  ])('reconciles a reinstall after a recoverable %s disable-ledger write failure', async (_label, code) => {
    const { source } = await createSkillOnlyPackage('npm:reinstalled-disabled-package');
    const sibling = 'npm:keep-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      version: 3,
      disabledSources: [source, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    const originalRename = fs.rename.bind(fs);
    let injected = false;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!injected && path.resolve(String(to)) === path.resolve(stateFile)) {
        injected = true;
        throw Object.assign(new Error(`simulated ${code}`), { code });
      }
      return originalRename(from, to);
    });
    try {
      const store = await import('../pi-package-store.js');
      await expect(mutateAuthorized(store, { action: 'install', source })).resolves.toMatchObject({
        affectedPackage: { source, enabled: true },
      });
    } finally {
      renameSpy.mockRestore();
    }
    expect(injected).toBe(true);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([sibling]);
  });

  it('does not claim a private install enabled when enable-ledger reconciliation is unavailable', async () => {
    const source = 'https://alice:s3cr3t@packages.example/context-mode.git?token=query-secret#fragment-secret';
    await createSkillOnlyPackage(source);
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const pendingFile = path.join(stateDir, 'cindy-package-pending-enable.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, '{invalid-state');
    const store = await import('../pi-package-store.js');

    const result = await mutateAuthorized(store, { action: 'install', source });
    expect(result).toMatchObject({ changed: true, available: false, projectionUnavailable: true });
    expect(result).not.toHaveProperty('affectedPackage');
    expect(runtime.spawns.find(({ args }) => args.includes('install'))?.args).toContain(source);
    await expect(fs.stat(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.listPiPackages()).rejects.toThrow('state is unavailable');
    const publications = `${JSON.stringify(result)}\n${JSON.stringify(loggerRuntime.warn.mock.calls)}`;
    expect(publications).not.toContain('alice');
    expect(publications).not.toContain('s3cr3t');
    expect(publications).not.toContain('query-secret');
    expect(publications).not.toContain('fragment-secret');
    expect(loggerRuntime.warn).toHaveBeenCalledWith(
      'Pi package installed; enable-ledger reconciliation deferred',
      { action: 'install', failureCategory: 'state-unavailable' },
    );
  });

  it.each(['EIO', 'EACCES'])(
    'does not claim enabled after state and pending reconciliation both fail with %s',
    async (code) => {
      const { source } = await createSkillOnlyPackage(`npm:double-write-${code.toLowerCase()}`);
      const sibling = 'npm:keep-disabled';
      const stateDir = path.join(runtime.userData, 'pi-package-home');
      const stateFile = path.join(stateDir, 'cindy-package-state.json');
      const pendingFile = path.join(stateDir, 'cindy-package-pending-enable.json');
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify({
        version: 3,
        disabledSources: [source, sibling],
        approvedExtensionSources: [],
        approvedExtensionFingerprints: {},
        snapshotUnavailableRoots: {},
      }));
      const originalRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if ([stateFile, pendingFile].some((file) => path.resolve(String(to)) === path.resolve(file))) {
          throw Object.assign(new Error(`private path ${code}`), { code });
        }
        return originalRename(from, to);
      });
      const runtimeFence = vi.fn();
      try {
        const store = await import('../pi-package-store.js');
        const result = await mutateAuthorized(store, { action: 'install', source }, {
          onRuntimeInvalidationPublished: runtimeFence,
        });
        expect(result).toMatchObject({
          changed: true,
          available: false,
          packages: [],
          projectionUnavailable: true,
        });
        expect(result).not.toHaveProperty('affectedPackage');
        expect(runtimeFence).toHaveBeenCalledOnce();
        expect(runtime.spawns.find(({ args }) => args.includes('install'))?.args).toContain(source);
        expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toMatchObject({
          disabledSources: [source, sibling],
        });
        await expect(fs.stat(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });

        vi.resetModules();
        const peerStore = await import('../pi-package-store.js');
        await expect(peerStore.listPiPackages()).resolves.toMatchObject({
          packages: [expect.objectContaining({ source, enabled: false })],
        });
        await expect(peerStore.resolveManagedPiNativePackagePaths()).resolves.toEqual([]);
      } finally {
        renameSpy.mockRestore();
      }
    },
  );

  it.each(['EIO', 'EACCES'])(
    'keeps committed install enablement authoritative when pending cleanup fails with %s',
    async (code) => {
      const { root, source } = await createSkillOnlyPackage(`npm:pending-cleanup-${code.toLowerCase()}`);
      const disabledSibling = 'npm:keep-disabled';
      const pendingSibling = 'npm:keep-pending';
      const stateDir = path.join(runtime.userData, 'pi-package-home');
      const stateFile = path.join(stateDir, 'cindy-package-state.json');
      const pendingFile = path.join(stateDir, 'cindy-package-pending-enable.json');
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify({
        version: 3,
        disabledSources: [source, disabledSibling],
        approvedExtensionSources: [],
        approvedExtensionFingerprints: {},
        snapshotUnavailableRoots: {},
      }));
      await fs.writeFile(pendingFile, JSON.stringify([source, pendingSibling]));
      const originalReadFile = fs.readFile.bind(fs);
      let pendingReadFailures = 1;
      const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (
        target: Parameters<typeof fs.readFile>[0],
        options?: Parameters<typeof fs.readFile>[1],
      ) => {
        if (path.resolve(String(target)) === path.resolve(pendingFile)
          && pendingReadFailures > 0) {
          pendingReadFailures -= 1;
          throw Object.assign(new Error(`simulated ${code}`), { code });
        }
        return originalReadFile(target, options as never);
      }) as typeof fs.readFile);
      const originalRename = fs.rename.bind(fs);
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (path.resolve(String(to)) === path.resolve(pendingFile)) {
          throw Object.assign(new Error(`simulated ${code}`), { code });
        }
        return originalRename(from, to);
      });
      const runtimeFence = vi.fn();
      try {
        const store = await import('../pi-package-store.js');
        const result = await mutateAuthorized(store, { action: 'install', source }, {
          onRuntimeInvalidationPublished: runtimeFence,
        });
        expect(result).toMatchObject({
          changed: true,
          available: true,
          affectedPackage: { source, enabled: true },
        });
        expect(result).not.toHaveProperty('projectionUnavailable');
        expect(runtimeFence).toHaveBeenCalledOnce();
        expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toMatchObject({
          disabledSources: [disabledSibling],
        });
        expect(JSON.parse(await fs.readFile(pendingFile, 'utf8'))).toEqual([source, pendingSibling]);

        vi.resetModules();
        const peerStore = await import('../pi-package-store.js');
        await expect(peerStore.listPiPackages()).resolves.toMatchObject({
          packages: [expect.objectContaining({ source, enabled: true })],
        });
        await expect(peerStore.resolveManagedPiNativePackagePaths()).resolves.toEqual([root]);
      } finally {
        readSpy.mockRestore();
        renameSpy.mockRestore();
      }
    },
  );

  it.each([
    ['transient I/O', 'EIO'],
    ['permission', 'EACCES'],
  ])('keeps native install successful through persistent %s and reconciles after recovery', async (_label, code) => {
    const { root, source } = await createSkillOnlyPackage(`npm:persistently-disabled-${code.toLowerCase()}`);
    const sibling = 'npm:keep-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      version: 3,
      disabledSources: [source, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(stateFile)) {
        throw Object.assign(new Error(`simulated ${code}`), { code });
      }
      return originalRename(from, to);
    });
    const store = await import('../pi-package-store.js');
    try {
      await expect(mutateAuthorized(store, { action: 'install', source })).resolves.toMatchObject({
        affectedPackage: { source, enabled: true },
      });
      await expect(store.listPiPackages()).resolves.toMatchObject({
        packages: [expect.objectContaining({ source, enabled: true })],
      });
      await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([root]);
    } finally {
      renameSpy.mockRestore();
    }
    let state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([source, sibling]);
    vi.resetModules();
    const recoveredStore = await import('../pi-package-store.js');
    await expect(recoveredStore.resolveManagedPiNativePackagePaths()).resolves.toEqual([root]);

    await expect(mutateAuthorized(recoveredStore, { action: 'install', source })).resolves.toMatchObject({
      affectedPackage: { source, enabled: true },
    });
    state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([sibling]);
    await expect(fs.stat(path.join(stateDir, 'cindy-package-pending-enable.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['EIO', 'EACCES'])('does not overwrite unreadable pending-enable siblings after %s', async (code) => {
    const { source } = await createSkillOnlyPackage(`npm:pending-read-${code.toLowerCase()}`);
    const sibling = 'npm:sibling-pending-enable';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const pendingFile = path.join(stateDir, 'cindy-package-pending-enable.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(pendingFile, JSON.stringify([source, sibling]));
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      target: Parameters<typeof fs.readFile>[0],
      options?: Parameters<typeof fs.readFile>[1],
    ) => {
      if (path.resolve(String(target)) === path.resolve(pendingFile)) {
        throw Object.assign(new Error(`private host path ${code}`), { code });
      }
      return originalReadFile(target, options as never);
    }) as typeof fs.readFile);
    const store = await import('../pi-package-store.js');
    try {
      await expect(store.mutatePiPackage({
        action: 'set-enabled', source, enabled: false,
      })).rejects.toThrow('state is unavailable');
    } finally {
      readSpy.mockRestore();
    }
    expect(JSON.parse(await fs.readFile(pendingFile, 'utf8'))).toEqual([source, sibling]);
    expect(loggerRuntime.warn).toHaveBeenCalledWith(
      'Pi pending enable reconciliation unavailable',
      { failureCategory: 'state-unavailable' },
    );
    expect(JSON.stringify(loggerRuntime.warn.mock.calls)).not.toContain('private host path');
  });

  it.each([
    { label: 'enable', enabled: true, code: 'EIO' },
    { label: 'enable', enabled: true, code: 'EACCES' },
    { label: 'disable', enabled: false, code: 'EIO' },
    { label: 'disable', enabled: false, code: 'EACCES' },
  ] as const)('does not publish $label enablement when the durable state write fails with $code', async ({
    enabled,
    code,
  }) => {
    const { source } = await createSkillOnlyPackage(`npm:toggle-write-${code.toLowerCase()}-${enabled}`);
    const sibling = 'npm:keep-sibling-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const initialState = {
      version: 3,
      disabledSources: enabled ? [source, sibling] : [sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(initialState));
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(stateFile)) {
        throw Object.assign(new Error('private toggle write failure'), { code });
      }
      return originalRename(from, to);
    });
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const runtimeFence = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      const failure = await mutateAuthorized(store, {
        action: 'set-enabled', source, enabled,
      }, { onRuntimeInvalidationPublished: runtimeFence }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(store.piPackageMutationMayHaveChangedState(failure)).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      expect(runtimeFence).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      renameSpy.mockRestore();
    }
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual(initialState);
  });

  it('lets an explicit disable cancel a pending reinstall enable without changing siblings', async () => {
    const { root, source } = await createSkillOnlyPackage('npm:pending-enable-disabled');
    const sibling = 'npm:keep-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const pendingFile = path.join(stateDir, 'cindy-package-pending-enable.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      version: 3,
      disabledSources: [source, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    await fs.writeFile(pendingFile, JSON.stringify([source]));
    const originalRename = fs.rename.bind(fs);
    let blockedReconcile = false;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!blockedReconcile && path.resolve(String(to)) === path.resolve(stateFile)) {
        blockedReconcile = true;
        throw Object.assign(new Error('simulated reconciliation EIO'), { code: 'EIO' });
      }
      return originalRename(from, to);
    });
    const store = await import('../pi-package-store.js');
    try {
      await expect(store.mutatePiPackage({
        action: 'set-enabled', source, enabled: false,
      })).resolves.toMatchObject({
        changed: true,
        affectedPackage: { source, enabled: false },
      });
    } finally {
      renameSpy.mockRestore();
    }
    expect(blockedReconcile).toBe(true);
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([source, sibling].sort());
    await expect(fs.stat(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.resolveManagedPiNativePackagePaths()).resolves.not.toContain(root);
  });

  it.each(['EIO', 'EACCES'])('converges a committed pending disable when the final state write fails with %s', async (code) => {
    const { source } = await createSkillOnlyPackage(`npm:pending-disable-edge-${code.toLowerCase()}`);
    const sibling = 'npm:keep-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const pendingFile = path.join(stateDir, 'cindy-package-pending-enable.json');
    const initialState = {
      version: 3,
      disabledSources: [source, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(initialState));
    await fs.writeFile(pendingFile, JSON.stringify([source]));
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(to)) === path.resolve(stateFile)) {
        throw Object.assign(new Error('private state write failure'), { code });
      }
      return originalRename(from, to);
    });
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      const failure = await store.mutatePiPackage({
        action: 'set-enabled', source, enabled: false,
      }).catch((error: unknown) => error);
      expect(store.piPackageMutationMayHaveChangedState(failure)).toBe(true);
      expect(listener).toHaveBeenCalledWith('local');
    } finally {
      unsubscribe();
      renameSpy.mockRestore();
    }
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual(initialState);
    await expect(fs.stat(pendingFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['transient I/O', 'EIO'],
    ['permission', 'EACCES'],
  ])('fails local projection closed through a %s Cindy-state read failure', async (_label, code) => {
    const { source } = await createSkillOnlyPackage('npm:disabled-skill-package');
    const sibling = 'npm:sibling-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const persistedState = `${JSON.stringify({
      version: 3,
      disabledSources: [source, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }, null, 2)}\n`;
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, persistedState);
    const originalReadFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation((async (
      target: Parameters<typeof fs.readFile>[0],
      options?: Parameters<typeof fs.readFile>[1],
    ) => {
      if (path.resolve(String(target)) === path.resolve(stateFile)) {
        throw Object.assign(new Error(`simulated ${code}`), { code });
      }
      return originalReadFile(target, options as never);
    }) as typeof fs.readFile);
    try {
      const store = await import('../pi-package-store.js');
      await expect(store.listPiPackages()).rejects.toThrow('state is unavailable');
      await expect(store.resolveManagedPiNativePackagePaths()).rejects.toThrow('state is unavailable');
      await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
        extensions: [], skills: [], promptTemplates: [], packageRoots: [],
      });
      await expect(store.mutatePiPackage({
        action: 'set-enabled',
        source,
        enabled: false,
      })).rejects.toThrow('state is unavailable');
      expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'failed to read Pi extension state',
        { failureCategory: 'state-unavailable' },
      );
    } finally {
      readSpy.mockRestore();
    }
    await expect(fs.readFile(stateFile, 'utf8')).resolves.toBe(persistedState);
  });

  it('fails local projection closed for corrupt Cindy state without overwriting it', async () => {
    const { source } = await createSkillOnlyPackage('npm:corrupt-state-skill-package');
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const corruptState = '{"version":3,"disabledSources":[';
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, corruptState);
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).rejects.toThrow('state is unavailable');
    await expect(store.resolveManagedPiNativePackagePaths()).rejects.toThrow('state is unavailable');
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'corrupt-state-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
    await expect(store.mutatePiPackage({
      action: 'set-enabled',
      source,
      enabled: false,
    })).rejects.toThrow('state is unavailable');
    await expect(fs.readFile(stateFile, 'utf8')).resolves.toBe(corruptState);
  });

  it('does not overwrite a corrupt disable ledger after native remove succeeds', async () => {
    const { source } = await createSkillOnlyPackage('npm:remove-with-corrupt-state');
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const corruptState = '{"version":3,"disabledSources":[';
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, corruptState);
    const store = await import('../pi-package-store.js');

    await expect(mutateAuthorized(store, { action: 'remove', source })).resolves.toMatchObject({
      changed: true,
    });
    await expect(fs.readFile(stateFile, 'utf8')).resolves.toBe(corruptState);
  });

  it('keeps a valid disabled Skill package disabled with its state readable', async () => {
    const { source } = await createSkillOnlyPackage('npm:valid-disabled-skill-package');
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, 'cindy-package-state.json'), JSON.stringify({
      version: 3,
      disabledSources: [source],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: false }],
    });
    await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
  });

  it('normalizes a bare registry package name to Pi npm source syntax', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');

    await mutateAuthorized(store, {
      action: 'install',
      source: source.slice(4),
    });
    expect(runtime.spawns.find(({ args }) => args.includes('install'))?.args)
      .toContain(source);
  });

  it('rejects task-relative local paths at the context-free Settings boundary', async () => {
    const store = await import('../pi-package-store.js');

    await expect(
      mutateAuthorized(store, {
        action: 'install',
        source: './extensions/context-mode',
      }),
    ).rejects.toThrow(/working directory/);
    expect(runtime.spawns).toEqual([]);
  });

  it('notifies open settings and command palettes after a successful mutation', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);

    await mutateAuthorized(store, { action: 'install', source });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('local');

    unsubscribe();
    await mutateAuthorized(store, { action: 'update', source });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['install', { action: 'install' as const }],
    ['update', { action: 'update' as const }],
    ['remove', { action: 'remove' as const }],
    ['disable', { action: 'set-enabled' as const, enabled: false }],
  ])('publishes the %s runtime fence before starting slow result projection', async (
    _label,
    request,
  ) => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const localRuntimeFence = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    let listStartedAfterFence = false;
    runtime.spawnHook = (args) => {
      if (args.includes('list')) listStartedAfterFence = localRuntimeFence.mock.calls.length > 0;
    };
    try {
      await mutateAuthorized(store, { ...request, source }, {
        onRuntimeInvalidationPublished: localRuntimeFence,
      });
      expect(listStartedAfterFence).toBe(true);
      expect(localRuntimeFence).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('local');
    } finally {
      unsubscribe();
    }
  });

  it('reconciles reinstall enablement before publishing the runtime fence', async () => {
    const { source } = await createSkillOnlyPackage('npm:runtime-fence-reinstall');
    const sibling = 'npm:keep-disabled';
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify({
      version: 3,
      disabledSources: [source, sibling],
      approvedExtensionSources: [],
      approvedExtensionFingerprints: {},
      snapshotUnavailableRoots: {},
    }));
    const store = await import('../pi-package-store.js');
    let disabledAtFence: string[] | undefined;

    await mutateAuthorized(store, { action: 'install', source }, {
      onRuntimeInvalidationPublished: async () => {
        disabledAtFence = (JSON.parse(await fs.readFile(stateFile, 'utf8')) as {
          disabledSources: string[];
        }).disabledSources;
      },
    });

    expect(disabledAtFence).toEqual([sibling]);
  });

  it.each([
    ['install', 'EACCES', 'access-denied'],
    ['install', 'EIO', 'io-failure'],
    ['update', 'EACCES', 'access-denied'],
    ['update', 'EIO', 'io-failure'],
    ['remove', 'EACCES', 'access-denied'],
    ['remove', 'EIO', 'io-failure'],
  ] as const)('keeps native %s success and local convergence when token publication fails with %s', async (
    action,
    errorCode,
    causeCategory,
  ) => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const tokenPaths = new Set([
      path.join(tokenDir, 'cindy-package-runtime-change-token'),
      path.join(tokenDir, 'cindy-package-change-token'),
    ].map((value) => path.resolve(value)));
    const originalRename = fsSync.renameSync.bind(fsSync);
    const renameSpy = vi.spyOn(fsSync, 'renameSync').mockImplementation(((from, to) => {
      if (tokenPaths.has(path.resolve(String(to)))) {
        throw Object.assign(new Error('secret-token at /private/host/path'), { code: errorCode });
      }
      return originalRename(from, to);
    }) as typeof fsSync.renameSync);
    const listener = vi.fn();
    const localRuntimeFence = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await expect(mutateAuthorized(store, { action, source }, {
        onRuntimeInvalidationPublished: localRuntimeFence,
      })).resolves.toMatchObject({ changed: true });
      expect(runtime.spawns.some(({ args }) => args.includes(action))).toBe(true);
      expect(localRuntimeFence).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('local');
      expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'Pi package change token publication failed; local convergence continued',
        expect.objectContaining({
          failureCategory: 'runtime-token-publication-failed',
          causeCategory,
          recoveryAction: 'restart-cindy-to-refresh-packages',
        }),
      );
      const logged = JSON.stringify(loggerRuntime.warn.mock.calls);
      expect(logged).not.toContain('secret-token');
      expect(logged).not.toContain('/private/host/path');
    } finally {
      unsubscribe();
      renameSpy.mockRestore();
    }
  });

  it('uses one shared cross-process lock for every package mutation action', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const tokens: string[] = [];

    await mutateAuthorized(store, { action: 'install', source });
    tokens.push(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-change-token'),
      'utf8',
    ));
    await mutateAuthorized(store, { action: 'update', source });
    tokens.push(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-change-token'),
      'utf8',
    ));
    await store.mutatePiPackage({ action: 'set-enabled', source, enabled: false });
    tokens.push(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-change-token'),
      'utf8',
    ));
    await mutateAuthorized(store, { action: 'remove', source });
    tokens.push(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-change-token'),
      'utf8',
    ));

    expect(lockRuntime.calls).toHaveLength(4);
    expect(new Set(lockRuntime.calls.map((call) => call.lockPath))).toEqual(new Set([
      path.join(runtime.userData, 'pi-package-home.mutation.lock'),
    ]));
    expect(lockRuntime.calls.every((call) => (
      call.label === 'pi-package-mutation' && (call.waitMs ?? 0) > 120_000
    ))).toBe(true);
    expect(new Set(tokens.map((token) => token.trim())).size).toBe(4);
    expect(tokens.every((token) => token.startsWith('runtime:'))).toBe(true);
  });

  it('observes a runtime edge when legacy and view token reads fail independently', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    const legacyToken = path.join(tokenDir, 'cindy-package-change-token');
    const viewToken = path.join(tokenDir, 'cindy-package-view-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      if ([legacyToken, viewToken].includes(path.resolve(String(target)))) {
        throw Object.assign(new Error('secret-token at /private/host/path'), { code: 'EACCES' });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.writeFile(runtimeToken, 'runtime:isolated-edge\n');
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('external-runtime'), {
        timeout: 2_000,
      });
      const logged = JSON.stringify(loggerRuntime.warn.mock.calls);
      expect(logged).not.toContain('secret-token');
      expect(logged).not.toContain('/private/host/path');
      expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'Pi package change token read failed',
        expect.objectContaining({ failureCategory: 'access-denied' }),
      );
    } finally {
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('converges local runtimes when a failed initial runtime-token read recovers after a peer-only edge', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    const legacyToken = path.join(tokenDir, 'cindy-package-change-token');
    const viewToken = path.join(tokenDir, 'cindy-package-view-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    await Promise.all([
      fs.writeFile(runtimeToken, 'runtime:old\n'),
      fs.writeFile(legacyToken, 'runtime:old\n'),
      fs.writeFile(viewToken, 'view:old\n'),
    ]);

    let runtimeReadBlocked = true;
    let legacyReadBlocked = true;
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      const resolvedTarget = path.resolve(String(target));
      if ((runtimeReadBlocked && resolvedTarget === path.resolve(runtimeToken))
        || (legacyReadBlocked && resolvedTarget === path.resolve(legacyToken))) {
        throw Object.assign(new Error('package token temporarily unreadable'), { code: 'EIO' });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const { invalidateLocalPiPackageRuntimesForObservedChange } = await import(
      '../pi-package-runtime-invalidation.js'
    );
    const originListener = vi.fn();
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const localPi = { id: 'local-pi', agentKind: 'pi' };
    const maker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => [localPi]),
      getSessionMeta: vi.fn(async () => ({ remoteHostId: null, reviewMode: false })),
      closeSessionIfCurrent,
    };
    const unsubscribe = store.onPiPackagesChanged((origin) => {
      originListener(origin);
      void invalidateLocalPiPackageRuntimesForObservedChange(maker as never, origin);
    });
    try {
      await vi.waitFor(() => {
        expect(loggerRuntime.warn).toHaveBeenCalledWith(
          'Pi package change token read failed',
          expect.objectContaining({ tokenKind: 'runtime', failureCategory: 'io-failure' }),
        );
        expect(loggerRuntime.warn).toHaveBeenCalledWith(
          'Pi package change token read failed',
          expect.objectContaining({ tokenKind: 'legacy', failureCategory: 'io-failure' }),
        );
      });

      // Recover the old legacy baseline while runtime observation stays down.
      legacyReadBlocked = false;
      await fs.writeFile(legacyToken, 'runtime:old\n');
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Simulate another Main publishing only the runtime edge while its legacy
      // mirror write fails. The legacy file intentionally stays on the old token.
      await fs.writeFile(runtimeToken, 'runtime:peer-edge\n');
      await new Promise((resolve) => setTimeout(resolve, 300));
      runtimeReadBlocked = false;
      await fs.writeFile(runtimeToken, 'runtime:peer-edge\n');

      await vi.waitFor(() => expect(originListener).toHaveBeenCalledWith('external-runtime'), {
        timeout: 2_000,
      });
      await vi.waitFor(() => expect(closeSessionIfCurrent).toHaveBeenCalledWith(
        localPi,
        'requested',
      ));
      expect(maker.advanceLocalPiPackageRuntimeGeneration).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('converges a peer-only runtime edge after recovery from a null legacy baseline', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    await fs.mkdir(tokenDir, { recursive: true });

    let runtimeReadBlocked = true;
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      if (runtimeReadBlocked && path.resolve(String(target)) === path.resolve(runtimeToken)) {
        throw Object.assign(new Error('runtime token temporarily unreadable'), { code: 'EIO' });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const { invalidateLocalPiPackageRuntimesForObservedChange } = await import(
      '../pi-package-runtime-invalidation.js'
    );
    const originListener = vi.fn();
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const localPi = { id: 'local-pi-null-baseline', agentKind: 'pi' };
    const maker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => [localPi]),
      getSessionMeta: vi.fn(async () => ({ remoteHostId: null, reviewMode: false })),
      closeSessionIfCurrent,
    };
    const unsubscribe = store.onPiPackagesChanged((origin) => {
      originListener(origin);
      void invalidateLocalPiPackageRuntimesForObservedChange(maker as never, origin);
    });
    try {
      await vi.waitFor(() => expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'Pi package change token read failed',
        expect.objectContaining({ tokenKind: 'runtime', failureCategory: 'io-failure' }),
      ));

      // Legacy is absent, so its successful read established a valid null
      // recovery baseline before another Main publishes only the runtime edge.
      await fs.writeFile(runtimeToken, 'runtime:peer-only-after-null\n');
      runtimeReadBlocked = false;
      await fs.writeFile(runtimeToken, 'runtime:peer-only-after-null\n');

      await vi.waitFor(() => expect(originListener).toHaveBeenCalledWith('external-runtime'), {
        timeout: 2_000,
      });
      await vi.waitFor(() => expect(closeSessionIfCurrent).toHaveBeenCalledWith(
        localPi,
        'requested',
      ));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(originListener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);
      expect(maker.advanceLocalPiPackageRuntimeGeneration).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('does not invent a runtime edge when recovery has only a view-style legacy baseline', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    await Promise.all([
      fs.writeFile(runtimeToken, 'runtime:already-present\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-change-token'), 'view:latest\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:latest\n'),
    ]);

    let runtimeReadBlocked = true;
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      if (runtimeReadBlocked && path.resolve(String(target)) === path.resolve(runtimeToken)) {
        throw Object.assign(new Error('runtime token temporarily unreadable'), { code: 'EIO' });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await vi.waitFor(() => expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'Pi package change token read failed',
        expect.objectContaining({ tokenKind: 'runtime', failureCategory: 'io-failure' }),
      ));
      runtimeReadBlocked = false;
      await fs.writeFile(runtimeToken, 'runtime:already-present\n');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('does not duplicate a legacy runtime edge when the unreadable runtime token recovers old', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    const legacyToken = path.join(tokenDir, 'cindy-package-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    await Promise.all([
      fs.writeFile(runtimeToken, 'runtime:old\n'),
      fs.writeFile(legacyToken, 'runtime:old\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:old\n'),
    ]);

    let runtimeReadBlocked = true;
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      if (runtimeReadBlocked && path.resolve(String(target)) === path.resolve(runtimeToken)) {
        throw Object.assign(new Error('runtime token temporarily unreadable'), { code: 'EIO' });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await vi.waitFor(() => expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'Pi package change token read failed',
        expect.objectContaining({ tokenKind: 'runtime', failureCategory: 'io-failure' }),
      ));
      await fs.writeFile(legacyToken, 'runtime:legacy-edge\n');
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('external-runtime'), {
        timeout: 2_000,
      });
      expect(listener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);

      runtimeReadBlocked = false;
      await fs.writeFile(runtimeToken, 'runtime:old\n');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(listener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);
    } finally {
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('does not use an already-notified legacy edge as the runtime recovery baseline', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    const legacyToken = path.join(tokenDir, 'cindy-package-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    await Promise.all([
      fs.writeFile(runtimeToken, 'runtime:old\n'),
      fs.writeFile(legacyToken, 'view:old\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:old\n'),
    ]);

    let runtimeReadBlocked = true;
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      if (runtimeReadBlocked && path.resolve(String(target)) === path.resolve(runtimeToken)) {
        throw Object.assign(new Error('runtime token temporarily unreadable'), { code: 'EIO' });
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await vi.waitFor(() => expect(loggerRuntime.warn).toHaveBeenCalledWith(
        'Pi package change token read failed',
        expect.objectContaining({ tokenKind: 'runtime', failureCategory: 'io-failure' }),
      ));
      await fs.writeFile(legacyToken, 'runtime:legacy-edge\n');
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('external-runtime'), {
        timeout: 2_000,
      });
      expect(listener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);
      // Keep runtime observation down for another poll. The already-notified
      // legacy edge must not become a new recovery comparison baseline.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(listener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);

      runtimeReadBlocked = false;
      await fs.writeFile(runtimeToken, 'runtime:old\n');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(listener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);
    } finally {
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('discards an observer batch that predates a local runtime-token publication', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeToken = path.join(tokenDir, 'cindy-package-runtime-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    await Promise.all([
      fs.writeFile(runtimeToken, 'runtime:old\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-change-token'), 'runtime:old\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:old\n'),
    ]);

    let releaseRuntimeRead!: () => void;
    const runtimeReadGate = new Promise<void>((resolve) => { releaseRuntimeRead = resolve; });
    const originalOpen = fs.open.bind(fs);
    let delayedRuntimeRead = false;
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      if (!delayedRuntimeRead && path.resolve(String(target)) === path.resolve(runtimeToken)) {
        delayedRuntimeRead = true;
        const handle = await originalOpen(target, flags, mode);
        return {
          stat: async () => {
            await runtimeReadGate;
            return handle.stat();
          },
          readFile: (...args: Parameters<typeof handle.readFile>) => handle.readFile(...args),
          close: () => handle.close(),
        } as Awaited<ReturnType<typeof fs.open>>;
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await vi.waitFor(() => expect(delayedRuntimeRead).toBe(true));
      await mutateAuthorized(store, { action: 'install', source: 'npm:local-publication' });
      releaseRuntimeRead();
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(listener).toHaveBeenCalledWith('local');
      expect(listener).not.toHaveBeenCalledWith('external-runtime');
    } finally {
      releaseRuntimeRead();
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('converges exactly once when a peer edge lands before the first observation completes', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    const runtimeTokenPath = path.join(tokenDir, 'cindy-package-runtime-change-token');
    const legacyTokenPath = path.join(tokenDir, 'cindy-package-change-token');
    await fs.mkdir(tokenDir, { recursive: true });
    const oldToken = `runtime:${Date.now() - 1_000}-111-old`;
    await Promise.all([
      fs.writeFile(runtimeTokenPath, `${oldToken}\n`),
      fs.writeFile(legacyTokenPath, `${oldToken}\n`),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:old\n'),
    ]);

    let releaseInitialReads!: () => void;
    const initialReadGate = new Promise<void>((resolve) => { releaseInitialReads = resolve; });
    const delayedPaths = new Set<string>();
    const originalOpen = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (target, flags, mode) => {
      const resolvedTarget = path.resolve(String(target));
      if ([runtimeTokenPath, legacyTokenPath].map((value) => path.resolve(value)).includes(resolvedTarget)
        && !delayedPaths.has(resolvedTarget)) {
        delayedPaths.add(resolvedTarget);
        await initialReadGate;
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.open);
    const store = await import('../pi-package-store.js');
    const { invalidateLocalPiPackageRuntimesForObservedChange } = await import(
      '../pi-package-runtime-invalidation.js'
    );
    const originListener = vi.fn();
    const closeSessionIfCurrent = vi.fn(async () => undefined);
    const localPi = { id: 'first-observation-local', agentKind: 'pi' };
    const remotePi = { id: 'first-observation-remote', agentKind: 'pi' };
    const reviewPi = { id: 'first-observation-review', agentKind: 'pi' };
    const nonPi = { id: 'first-observation-claude', agentKind: 'claude' };
    const maker = {
      advanceLocalPiPackageRuntimeGeneration: vi.fn(),
      listActiveSessions: vi.fn(() => [localPi, remotePi, reviewPi, nonPi]),
      getSessionMeta: vi.fn(async (sessionId: string) => ({
        remoteHostId: sessionId === remotePi.id ? 'remote-host' : null,
        reviewMode: sessionId === reviewPi.id,
      })),
      closeSessionIfCurrent,
    };
    const unsubscribe = store.onPiPackagesChanged((origin) => {
      originListener(origin);
      void invalidateLocalPiPackageRuntimesForObservedChange(maker as never, origin);
    });
    try {
      await vi.waitFor(() => expect(delayedPaths.size).toBe(2));
      const peerToken = `runtime:${Date.now()}-222-peer`;
      await Promise.all([
        fs.writeFile(runtimeTokenPath, `${peerToken}\n`),
        fs.writeFile(legacyTokenPath, `${peerToken}\n`),
      ]);
      releaseInitialReads();

      await vi.waitFor(() => expect(closeSessionIfCurrent).toHaveBeenCalledWith(
        localPi,
        'requested',
      ), { timeout: 2_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(originListener.mock.calls.filter(([origin]) => origin === 'external-runtime')).toHaveLength(1);
      expect(maker.advanceLocalPiPackageRuntimeGeneration).toHaveBeenCalledOnce();
      expect(closeSessionIfCurrent).toHaveBeenCalledTimes(1);
      expect(closeSessionIfCurrent).not.toHaveBeenCalledWith(remotePi, 'requested');
      expect(closeSessionIfCurrent).not.toHaveBeenCalledWith(reviewPi, 'requested');
    } finally {
      releaseInitialReads();
      unsubscribe();
      openSpy.mockRestore();
    }
  });

  it('uses the first successful runtime-token read as a cold-start baseline', async () => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    await fs.mkdir(tokenDir, { recursive: true });
    const coldToken = `runtime:${Date.now() - 1_000}-111-cold`;
    await Promise.all([
      fs.writeFile(path.join(tokenDir, 'cindy-package-runtime-change-token'), `${coldToken}\n`),
      fs.writeFile(path.join(tokenDir, 'cindy-package-change-token'), `${coldToken}\n`),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:cold\n'),
    ]);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['runtime', 'cindy-package-runtime-change-token', 'runtime:next', 'external-runtime'],
    ['legacy', 'cindy-package-change-token', 'runtime:legacy-next', 'external-runtime'],
    ['view', 'cindy-package-view-change-token', 'view:next', 'external'],
  ] as const)('observes an independent %s token change', async (
    _kind,
    filename,
    nextToken,
    expectedOrigin,
  ) => {
    const tokenDir = path.join(runtime.userData, 'pi-package-home');
    await fs.mkdir(tokenDir, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(tokenDir, 'cindy-package-runtime-change-token'), 'runtime:base\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-change-token'), 'runtime:base\n'),
      fs.writeFile(path.join(tokenDir, 'cindy-package-view-change-token'), 'view:base\n'),
    ]);
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.writeFile(path.join(tokenDir, filename), `${nextToken}\n`);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expectedOrigin), {
        timeout: 2_000,
      });
    } finally {
      unsubscribe();
    }
  });

  it('propagates package and approval changes to another shared-userData instance', async () => {
    const { root, source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    await mutateAuthorized(firstStore, {
      action: 'set-enabled',
      source,
      enabled: true,
    });
    const listener = vi.fn();
    const unsubscribe = firstStore.onPiPackagesChanged(listener);
    await new Promise((resolve) => setTimeout(resolve, 50));

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function replacedByOtherInstance() {}',
    );
    await mutateAuthorized(secondStore, { action: 'update', source });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('external-runtime'), {
      timeout: 2_000,
    });
    await expect(firstStore.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
    unsubscribe();
  });

  it('does not let an immediate view publication overwrite a peer runtime invalidation', async () => {
    const { source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = firstStore.onPiPackagesChanged(listener);
    await new Promise((resolve) => setTimeout(resolve, 50));

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    try {
      await mutateAuthorized(secondStore, { action: 'update', source });
      await secondStore.resolveManagedPiPackageResources({
        snapshotRoot: path.join(runtime.userData, 'view-after-runtime-snapshot'),
        snapshotLimits: {
          maxEntries: 100,
          maxBytes: 1024 * 1024,
          maxDurationMs: 0,
        },
      });

      await vi.waitFor(() => expect(listener).toHaveBeenCalledWith('external-runtime'), {
        timeout: 2_000,
      });
      await expect(fs.readFile(
        path.join(runtime.userData, 'pi-package-home', 'cindy-package-runtime-change-token'),
        'utf8',
      )).resolves.toMatch(/^runtime:/);
      await expect(fs.readFile(
        path.join(runtime.userData, 'pi-package-home', 'cindy-package-change-token'),
        'utf8',
      )).resolves.toMatch(/^runtime:/);
      await expect(fs.readFile(
        path.join(runtime.userData, 'pi-package-home', 'cindy-package-view-change-token'),
        'utf8',
      )).resolves.toMatch(/^view:/);
    } finally {
      unsubscribe();
    }
  });

  it('fails closed before touching the package tree when the shared lock is unavailable', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    lockRuntime.nextStatus = { held: false, reason: 'busy' };

    await expect(store.mutatePiPackage({ action: 'set-enabled', source, enabled: false }))
      .rejects.toThrow(/busy or unavailable/);
    expect(runtime.spawns).toEqual([]);
    await expect(fs.stat(path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes independent Main module instances without losing state updates', async () => {
    const first = await createPackage({ source: 'npm:first-extension' });
    const second = await createPackage({ source: 'npm:second-extension' });
    runtime.listOutput = [
      'User packages:',
      `  ${first.source}`,
      `    ${first.root}`,
      `  ${second.source}`,
      `    ${second.root}`,
      '',
    ].join('\n');
    const firstStore = await import('../pi-package-store.js');
    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');

    await Promise.all([
      firstStore.mutatePiPackage({ action: 'set-enabled', source: first.source, enabled: false }),
      secondStore.mutatePiPackage({ action: 'set-enabled', source: second.source, enabled: false }),
    ]);

    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([first.source, second.source]);
    expect(lockRuntime.calls).toHaveLength(2);
    expect(lockRuntime.maxActive).toBe(1);
  });

  it('rejects a stale enable after external native removal without writing ghost state', async () => {
    const { source } = await createPackage();
    const installedList = runtime.listOutput;
    const firstStore = await import('../pi-package-store.js');
    const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
    const staleEnableRequest = { action: 'set-enabled', source, enabled: true } as const;
    const staleEnableGrant = issuePiPackageMutationGrant(staleEnableRequest);
    await expect(firstStore.listPiPackages()).resolves.toMatchObject({
      packages: [{ source }],
    });

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    runtime.listOutcomes = [
      { stdout: installedList, exitCode: 0 },
      { stdout: '', exitCode: 0 },
    ];
    await mutateAuthorized(secondStore, { action: 'remove', source });
    runtime.listOutput = '';

    const listener = vi.fn();
    const runtimeFence = vi.fn();
    const unsubscribe = firstStore.onPiPackagesChanged(listener);
    try {
      const failure = await firstStore.mutatePiPackage(
        staleEnableRequest,
        staleEnableGrant,
        { onRuntimeInvalidationPublished: runtimeFence },
      )
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: 'PiPackageStateUnavailableError' });
      expect(String(failure)).not.toContain(source);
      expect(firstStore.piPackageMutationMayHaveChangedState(failure)).toBe(false);
      expect(listener).not.toHaveBeenCalled();
      expect(runtimeFence).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }

    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).not.toContain(source);
  });

  it('re-inspects approval state under the shared lock before staging a session snapshot', async () => {
    const { root, source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    await mutateAuthorized(firstStore, { action: 'install', source });
    const canonicalRoot = await fs.realpath(root);
    await expect(firstStore.resolveManagedPiPackageResources()).resolves.toMatchObject({
      extensions: [path.join(canonicalRoot, 'extensions', 'index.ts')],
    });

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function replacedAfterApproval() {}',
    );
    await mutateAuthorized(secondStore, { action: 'update', source });

    const snapshotRoot = path.join(runtime.userData, 'cross-process-session', 'managed-packages');
    const snapshotExtension = path.join(snapshotRoot, '0', 'extensions', 'index.ts');
    await expect(firstStore.resolveManagedPiPackageResources({ snapshotRoot })).resolves.toMatchObject({
      extensions: [snapshotExtension],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
    await expect(fs.readFile(snapshotExtension, 'utf8')).resolves.toContain('replacedAfterApproval');
    await expect(firstStore.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
  });

  it('preserves approval after an unchanged failed install', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    });

    runtime.listOutcomes = [{ stdout: runtime.listOutput, exitCode: 0 }];
    runtime.exitCode = 1;
    runtime.stderr = 'install failed';
    await expect(mutateAuthorized(store, { action: 'install', source })).rejects.toThrow(
      /install failed/,
    );

    runtime.exitCode = 0;
    runtime.stderr = '';
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
  });

  it('preserves approval after an unchanged failed update and rejects later byte changes', async () => {
    const { root, source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    });
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);

    runtime.listOutcomes = [{ stdout: runtime.listOutput, exitCode: 0 }];
    runtime.exitCode = 1;
    runtime.stderr = 'update failed';
    await expect(mutateAuthorized(store, { action: 'update', source })).rejects.toThrow(
      /update failed/,
    );
    expect(listener).toHaveBeenCalledTimes(1);

    runtime.exitCode = 0;
    runtime.stderr = '';
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });

    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function changedAfterFailedUpdate() {}',
    );
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'failed-update-changed-snapshot'),
    })).resolves.toEqual({
      extensions: [],
      skills: [],
      promptTemplates: [],
      packageRoots: [],
    });
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
    unsubscribe();
  });

  it('keeps native install success explicit when the fresh roster is unavailable', async () => {
    const { source } = await createSkillOnlyPackage('npm:native-success-projection-unavailable');
    runtime.listOutcomes = Array.from({ length: 4 }, () => ({
      stderr: 'private projection failure',
      exitCode: 1,
    }));
    const store = await import('../pi-package-store.js');

    await expect(mutateAuthorized(store, { action: 'install', source })).resolves.toMatchObject({
      changed: true,
      available: false,
      projectionUnavailable: true,
      affectedPackage: { source, enabled: true },
    });
    expect(runtime.spawns.find(({ args }) => args.includes('install'))?.args).toContain(source);
    const logs = JSON.stringify(loggerRuntime.warn.mock.calls);
    expect(logs).toContain('projection-unavailable');
    expect(logs).not.toContain('private projection failure');
  });

  it('persists an explicit disable and converges runtimes without a fresh roster read', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const runtimeFence = vi.fn();
    runtime.listOutcomes = [{ stderr: 'list unavailable during disable', exitCode: 1 }];

    const receipt = await mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: false,
    }, { onRuntimeInvalidationPublished: runtimeFence });

    expect(receipt).toMatchObject({
      changed: true,
      available: false,
      projectionUnavailable: true,
    });
    expect(runtimeFence).toHaveBeenCalledOnce();
    expect(runtime.spawns.filter(({ args }) => args.includes('list'))).toHaveLength(1);
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([source]);
  });

  it('durably disables a secret-bearing opaque row when the native roster is unavailable', async () => {
    const secretSource = 'https://user:credential-secret@example.com/pkg.git?token=query-secret#fragment-secret';
    await createPackage({ source: secretSource });
    const store = await import('../pi-package-store.js');
    const listed = await store.listPiPackages();
    const row = listed.packages[0]!;
    expect(row.source).toBe('https://example.com/pkg.git');
    expect(row.mutationTarget).toMatch(/^cindy-pi-package:[a-f0-9]{64}$/);

    runtime.spawns = [];
    runtime.listOutcomes = [{ stderr: 'list unavailable during opaque disable', exitCode: 1 }];
    const runtimeFence = vi.fn();
    const receipt = await mutateAuthorized(store, {
      action: 'set-enabled',
      source: row.source,
      mutationTarget: row.mutationTarget,
      enabled: false,
    }, { onRuntimeInvalidationPublished: runtimeFence });

    expect(receipt).toMatchObject({
      changed: true,
      available: false,
      projectionUnavailable: true,
    });
    expect(runtimeFence).toHaveBeenCalledOnce();
    expect(runtime.spawns.filter(({ args }) => args.includes('list'))).toHaveLength(1);
    const stateFile = path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json');
    const stateText = await fs.readFile(stateFile, 'utf8');
    expect(JSON.parse(stateText)).toMatchObject({ disabledSources: [row.mutationTarget] });
    expect(stateText).not.toContain('credential-secret');
    expect(stateText).not.toContain('query-secret');
    expect(stateText).not.toContain('fragment-secret');
    runtime.listOutcomes = [{ stdout: runtime.listOutput, exitCode: 0 }];
    await expect(store.resolveManagedPiNativePackagePaths()).resolves.toEqual([]);

    runtime.listOutcomes = [{ stderr: 'list unavailable during opaque enable', exitCode: 1 }];
    const enableFence = vi.fn();
    await expect(mutateAuthorized(store, {
      action: 'set-enabled',
      source: row.source,
      mutationTarget: row.mutationTarget,
      enabled: true,
    }, { onRuntimeInvalidationPublished: enableFence })).rejects.toThrow('state is unavailable');
    expect(enableFence).not.toHaveBeenCalled();
    expect(await fs.readFile(stateFile, 'utf8')).toBe(stateText);

    runtime.listOutcomes = Array.from({ length: 2 }, () => ({
      stdout: runtime.listOutput,
      exitCode: 0,
    }));
    await expect(mutateAuthorized(store, {
      action: 'set-enabled',
      source: row.source,
      mutationTarget: row.mutationTarget,
      enabled: true,
    })).resolves.toMatchObject({ affectedPackage: { enabled: true } });
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toMatchObject({ disabledSources: [] });
  });

  it('still requires a fresh native roster before enabling a source without an opaque target', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: false });
    const stateFile = path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json');
    runtime.listOutcomes = [{ stderr: 'list unavailable during enable', exitCode: 1 }];
    const runtimeFence = vi.fn();

    await expect(mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    }, { onRuntimeInvalidationPublished: runtimeFence })).rejects.toThrow('state is unavailable');
    expect(runtimeFence).not.toHaveBeenCalled();
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([source]);
  });

  it('refreshes open settings when set-enabled persists but the follow-up list fails', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    runtime.listOutcomes = [
      { stdout: runtime.listOutput, exitCode: 0 },
      { stderr: 'list failed after state write', exitCode: 1 },
    ];

    const receipt = await mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    });
    expect(receipt).toMatchObject({
      changed: true,
      available: false,
      packages: [],
      projectionUnavailable: true,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loggerRuntime.warn).toHaveBeenCalledWith(
      'Pi package mutation succeeded; Cindy list projection unavailable',
      { action: 'set-enabled', failureCategory: 'projection-unavailable' },
    );

    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as {
      disabledSources: string[];
      approvedExtensionSources: string[];
      approvedExtensionFingerprints: Record<string, string>;
    };
    expect(state.disabledSources).toEqual([]);
    expect(state.approvedExtensionSources).toEqual([source]);
    expect(state.approvedExtensionFingerprints[source]).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
    unsubscribe();
  });

  it('passes Pi’s stored local source syntax back to native update and remove', async () => {
    const { root } = await createPackage();
    const normalizedSource = path.relative(
      path.join(runtime.userData, 'pi-package-home'),
      root,
    );
    runtime.listOutput = `User packages:\n  ${normalizedSource}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');

    await mutateAuthorized(store, {
      action: 'set-enabled',
      source: normalizedSource,
      enabled: true,
    });
    const reinstalled = await mutateAuthorized(store, {
      action: 'install',
      source: root,
    });

    expect(reinstalled.affectedPackage).toMatchObject({
      source: normalizedSource,
      enabled: true,
    });
    expect(reinstalled.affectedPackage?.requiresExtensionApproval).toBeUndefined();

    await mutateAuthorized(store, { action: 'update', source: normalizedSource });
    await mutateAuthorized(store, { action: 'remove', source: normalizedSource });
    expect(runtime.spawns.find(({ args }) => args.includes('update'))?.args)
      .toContain(normalizedSource);
    expect(runtime.spawns.find(({ args }) => args.includes('remove'))?.args)
      .toContain(normalizedSource);
  });

  it('passes Pi-supported credentialed URL syntax through while redacting receipts', async () => {
    const store = await import('../pi-package-store.js');
    const source = 'https://user:secret@example.com/acme/package.git';
    await expect(mutateAuthorized(store, {
      action: 'install',
      source,
    })).resolves.toMatchObject({
      affectedPackage: {
        source: 'https://example.com/acme/package.git',
        enabled: true,
      },
    });
    expect(runtime.spawns.find(({ args }) => args.includes('install'))?.args).toContain(source);
  });

  it('reports oversized Cindy analysis without disabling Pi-native package roots', async () => {
    const createLaunchPackage = async (
      source: string,
      kind: 'skill' | 'mixed',
      oversized: boolean,
    ): Promise<string> => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-launch-limit-'));
      roots.push(root);
      const skillRoot = path.join(root, 'skills', 'sample');
      const promptsRoot = path.join(root, 'prompts');
      await fs.mkdir(skillRoot, { recursive: true });
      await fs.mkdir(promptsRoot, { recursive: true });
      await fs.writeFile(path.join(skillRoot, 'SKILL.md'), [
        '---',
        `name: ${source.slice(4)}`,
        'description: bounded skill',
        '---',
        'body',
        '',
      ].join('\n'));
      await fs.writeFile(path.join(promptsRoot, 'hello.md'), '---\ndescription: hello\n---\nHello\n');
      if (kind === 'mixed') {
        await fs.mkdir(path.join(root, 'extensions'));
        await fs.writeFile(
          path.join(root, 'extensions', 'index.js'),
          'module.exports = function setup() {};\n',
        );
      }
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
        name: source.slice(4),
        version: '1.0.0',
        pi: {
          extensions: kind === 'mixed' ? ['./extensions/index.js'] : [],
          skills: ['./skills'],
          prompts: ['./prompts'],
        },
      }));
      if (oversized) {
        // A sparse file crosses the production snapshot byte budget without
        // creating 10,000 directory entries. The previous entry-limit fixture
        // timed out on Windows due to filesystem setup rather than the code
        // under test, while this still exercises the same inspection quarantine.
        const paddingFile = path.join(root, 'unused-padding.bin');
        await fs.writeFile(paddingFile, '');
        await fs.truncate(paddingFile, 128 * 1024 * 1024 + 1);
      }
      return root;
    };

    const validSource = 'npm:valid-data-package';
    const oversizedDataSource = 'npm:oversized-data-package';
    const oversizedMixedSource = 'npm:oversized-mixed-package';
    const [validRoot, oversizedDataRoot, oversizedMixedRoot] = await Promise.all([
      createLaunchPackage(validSource, 'skill', false),
      createLaunchPackage(oversizedDataSource, 'skill', true),
      createLaunchPackage(oversizedMixedSource, 'mixed', true),
    ]);
    runtime.listOutput = [
      'User packages:',
      `  ${validSource}`,
      `    ${validRoot}`,
      `  ${oversizedDataSource}`,
      `    ${oversizedDataRoot}`,
      `  ${oversizedMixedSource}`,
      `    ${oversizedMixedRoot}`,
      '',
    ].join('\n');

    const store = await import('../pi-package-store.js');
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        { source: validSource, enabled: true },
        {
          source: oversizedDataSource,
          enabled: true,
          warning: 'inspection-limit',
          resources: [],
        },
        {
          source: oversizedMixedSource,
          enabled: true,
          warning: 'inspection-limit',
          resources: [],
        },
      ],
    });

    const snapshotRoot = path.join(runtime.userData, 'isolated-launch-limits', 'managed-packages');
    const snapshot = await store.resolveManagedPiPackageResources({ snapshotRoot });
    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        name: validSource.slice(4),
        path: path.join(snapshotRoot, '0', 'skills', 'sample', 'SKILL.md'),
      }),
    ]);
    expect(snapshot.extensions).toEqual([]);
    expect(snapshot.packageRoots).toEqual([path.join(snapshotRoot, '0')]);
    expect(snapshot.skills.some((skill) => skill.path.includes('oversized'))).toBe(false);
  }, 30_000);

  it('supports Pi local single-file extensions and convention-only directories', async () => {
    const directFileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-direct-file-'));
    const conventionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-convention-'));
    roots.push(directFileRoot, conventionRoot);
    const directFile = path.join(directFileRoot, 'direct.ts');
    await fs.writeFile(directFile, 'export default function setup() {}');
    await fs.mkdir(path.join(conventionRoot, 'extensions'));
    await fs.writeFile(
      path.join(conventionRoot, 'extensions', 'index.ts'),
      'export default function setup() {}',
    );
    runtime.listOutput = [
      'User packages:',
      '  ../direct.ts',
      `    ${directFile}`,
      '  ../convention',
      `    ${conventionRoot}`,
      '',
    ].join('\n');
    const store = await import('../pi-package-store.js');

    const result = await store.listPiPackages();
    expect(result.packages).toMatchObject([
      {
        source: '../direct.ts',
        name: 'direct.ts',
        enabled: true,
        resources: [{ kind: 'extension', name: 'direct.ts' }],
      },
      {
        source: '../convention',
        enabled: true,
        resources: [{ kind: 'extension', name: 'index.ts' }],
      },
    ]);
  });

  it('lets Pi decide how to handle a natively installed unknown single-file package', async () => {
    const directFileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-data-file-'));
    roots.push(directFileRoot);
    const directFile = path.join(directFileRoot, 'README.md');
    const source = '../README.md';
    await fs.writeFile(directFile, 'not a Pi extension');
    runtime.listOutput = `User packages:\n  ${source}\n    ${directFile}\n`;
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{
        source,
        enabled: true,
        resources: [],
        warning: 'no-resources',
      }],
    });
    const request = { action: 'set-enabled' as const, source, enabled: true };
    const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
    await expect(store.mutatePiPackage(
      request,
      issuePiPackageMutationGrant(request),
    )).resolves.toMatchObject({ affectedPackage: { source, enabled: true } });
  });

  it('does not project convention resources that resolve outside the package root', async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-confined-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-outside-'));
    roots.push(packageRoot, outsideRoot);
    await fs.mkdir(path.join(packageRoot, 'extensions'));
    await fs.mkdir(path.join(packageRoot, 'prompts'));
    const outsideExtension = path.join(outsideRoot, 'index.ts');
    const outsidePrompt = path.join(outsideRoot, 'hello.md');
    await fs.writeFile(outsideExtension, 'export default function setup() {}');
    await fs.writeFile(outsidePrompt, 'Outside package prompt');
    try {
      await fs.symlink(outsideExtension, path.join(packageRoot, 'extensions', 'index.ts'), 'file');
      await fs.symlink(outsidePrompt, path.join(packageRoot, 'prompts', 'hello.md'), 'file');
    } catch {
      return;
    }
    runtime.listOutput = `User packages:\n  ../confined\n    ${packageRoot}\n`;
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{
        source: '../confined',
        enabled: true,
        resources: [],
        warning: 'no-resources',
      }],
    });
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'escaped-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
  });

  it('enables directory packages only when inspection finds launch resources', async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-empty-'));
    const themeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-theme-matrix-'));
    const filteredRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-filtered-'));
    const skillRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-skill-matrix-'));
    roots.push(emptyRoot, themeRoot, filteredRoot, skillRoot);

    await fs.writeFile(path.join(emptyRoot, 'package.json'), JSON.stringify({
      name: 'empty-package',
      version: '1.0.0',
    }));
    await fs.mkdir(path.join(themeRoot, 'themes'));
    await fs.writeFile(path.join(themeRoot, 'themes', 'night.json'), '{}');
    await fs.writeFile(path.join(themeRoot, 'package.json'), JSON.stringify({
      name: 'theme-package',
      version: '1.0.0',
      pi: { themes: ['./themes'] },
    }));
    await fs.mkdir(path.join(filteredRoot, 'prompts'));
    await fs.writeFile(path.join(filteredRoot, 'prompts', 'not-loadable.txt'), 'not a Pi prompt');
    await fs.writeFile(path.join(filteredRoot, 'package.json'), JSON.stringify({
      name: 'filtered-package',
      version: '1.0.0',
      pi: { prompts: ['./prompts'] },
    }));
    await fs.mkdir(path.join(skillRoot, 'skills', 'launchable'), { recursive: true });
    await fs.writeFile(path.join(skillRoot, 'skills', 'launchable', 'SKILL.md'), [
      '---',
      'name: launchable',
      'description: launchable test skill',
      '---',
      'body',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(skillRoot, 'package.json'), JSON.stringify({
      name: 'skill-package',
      version: '1.0.0',
      pi: { skills: ['./skills'] },
    }));

    runtime.listOutput = [
      'User packages:',
      '  npm:empty-package',
      `    ${emptyRoot}`,
      '  npm:theme-package',
      `    ${themeRoot}`,
      '  npm:filtered-package',
      `    ${filteredRoot}`,
      '  npm:skill-package',
      `    ${skillRoot}`,
      '',
    ].join('\n');
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [
        {
          source: 'npm:empty-package',
          enabled: true,
          resources: [],
          warning: 'no-resources',
        },
        {
          source: 'npm:theme-package',
          enabled: true,
          resources: [{ kind: 'theme', compatibility: 'unsupported' }],
        },
        {
          source: 'npm:filtered-package',
          enabled: true,
          resources: [],
          warning: 'no-resources',
        },
        {
          source: 'npm:skill-package',
          enabled: true,
          resources: [{ kind: 'skill', name: 'launchable', compatibility: 'supported' }],
        },
      ],
    });

    const snapshotRoot = path.join(runtime.userData, 'launch-resource-matrix');
    await expect(store.resolveManagedPiPackageResources({ snapshotRoot })).resolves.toMatchObject({
      extensions: [],
      skills: [{
        name: 'launchable',
        path: path.join(snapshotRoot, '0', 'skills', 'launchable', 'SKILL.md'),
      }],
      promptTemplates: [],
      packageRoots: [path.join(snapshotRoot, '0')],
    });
  });

  it('lets Pi load theme-only packages despite Cindy TUI compatibility limits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-theme-only-'));
    roots.push(root);
    const source = 'npm:theme-only';
    await fs.mkdir(path.join(root, 'themes'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'theme-only',
      version: '1.0.0',
      pi: { themes: ['./themes'] },
    }));
    await fs.writeFile(path.join(root, 'themes', 'night.json'), '{}');
    runtime.listOutput = `User packages:\n  ${source}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{
        source,
        enabled: true,
        resources: [{
          kind: 'theme',
          name: 'night.json',
          compatibility: 'unsupported',
        }],
      }],
    });
    const listed = await store.listPiPackages();
    expect(listed.packages[0]).not.toHaveProperty('manageable', false);
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'theme-only-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
  });

  it('does not warn that lifecycle scripts were blocked after confirmed installs allow them', async () => {
    const { source } = await createPackage({ lifecycleScript: true });
    const store = await import('../pi-package-store.js');
    const listed = await store.listPiPackages();
    expect(listed.packages).toMatchObject([{ source }]);
    expect(listed.packages[0]).not.toHaveProperty('warning');
  });

  it('uses an opaque mutation target whenever a multibyte source is display-truncated', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-long-source-'));
    roots.push(root);
    const source = `npm:${'包'.repeat(800)}`;
    runtime.listOutput = `User packages:\n  ${source}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');

    const listed = await store.listPiPackages();
    expect(listed.packages[0]?.source).not.toBe(source);
    expect(listed.packages[0]?.mutationTarget).toMatch(/^cindy-pi-package:[a-f0-9]{64}$/);
    await expect(store.mutatePiPackage({
      action: 'set-enabled',
      source: listed.packages[0]!.source,
      mutationTarget: listed.packages[0]!.mutationTarget,
      enabled: false,
    })).resolves.toMatchObject({ affectedPackage: { enabled: false } });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([listed.packages[0]!.mutationTarget]);
  });

  it('redacts sensitive URL fields without disabling a source accepted by Pi', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-unsafe-source-'));
    roots.push(root);
    const unsafeSource = 'git:https://user:secret@example.com/acme/package.git?token=private#fragment';
    runtime.listOutput = `User packages:\n  ${unsafeSource}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');

    const result = await store.listPiPackages();
    expect(result.packages).toEqual([{
      source: 'git:https://example.com/acme/package.git',
      mutationTarget: expect.stringMatching(/^cindy-pi-package:[a-f0-9]{64}$/),
      name: 'git:https://example.com/acme/package.git',
      enabled: true,
      resources: [],
      warning: 'unsafe-source',
    }]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
    await expect(store.mutatePiPackage({
      action: 'set-enabled',
      source: result.packages[0]!.source,
      mutationTarget: result.packages[0]!.mutationTarget!,
      enabled: false,
    })).resolves.toMatchObject({
      changed: true,
      affectedPackage: { enabled: false },
    });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([result.packages[0]!.mutationTarget]);
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(JSON.stringify(state)).not.toContain('private');
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'unsafe-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
  });

  it('redacts sensitive install sources from post-mutation Main warnings', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-log-redaction-'));
    roots.push(root);
    const unsafeSource = 'git:https://user:secret@example.com/acme/package.git?token=private#fragment';
    runtime.listOutput = `User packages:\n  ${unsafeSource}\n    ${root}\n`;
    runtime.listOutcomes.push({
      stderr: `inspection failed for ${unsafeSource}`,
      exitCode: 1,
    });
    const store = await import('../pi-package-store.js');

    await mutateAuthorized(store, { action: 'install', source: unsafeSource });

    expect(loggerRuntime.warn).toHaveBeenCalledWith(
      'Pi package installed; Cindy post-install analysis unavailable',
      { action: 'install', failureCategory: 'projection-unavailable' },
    );
    const warnings = JSON.stringify(loggerRuntime.warn.mock.calls);
    expect(warnings).not.toContain('user:secret');
    expect(warnings).not.toContain('token=private');
  });

  it('redacts unsafe saved URLs from Pi package command failures', async () => {
    runtime.stderr = "Failed to load GIT:https://user:sec'ret@example.com/acme/package.git?token=private#fragment";
    runtime.exitCode = 1;
    const store = await import('../pi-package-store.js');

    const failure = await store.listPiPackages().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('GIT:https://example.com/acme/package.git');
    expect((failure as Error).message).not.toContain("sec'ret");
    expect((failure as Error).message).not.toContain("'ret@example.com");
    expect((failure as Error).message).not.toContain('private');
  });

  it('redacts every credential in compact multi-URL command failures', async () => {
    runtime.stderr = 'Failed ["https://u1:first-secret@one.example/a","https://u2:second-secret@two.example/b?token=query-secret"]';
    runtime.exitCode = 1;
    const store = await import('../pi-package-store.js');

    const failure = await store.listPiPackages().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toContain('u1');
    expect(message).not.toContain('first-secret');
    expect(message).not.toContain('u2');
    expect(message).not.toContain('second-secret');
    expect(message).not.toContain('query-secret');
  });

  it('keeps an oversized-manifest inspection warning advisory', async () => {
    const { source } = await createPackage({ oversizedManifest: true });
    const store = await import('../pi-package-store.js');
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{
        source,
        enabled: true,
        warning: 'inspection-limit',
        resources: [],
      }],
    });
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'oversized-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
  });

  it('bounds inspection work across a large installed-package roster', async () => {
    runtime.listOutput = [
      'User packages:',
      ...Array.from({ length: 130 }, (_, index) => `  npm:package-${index}`),
      '',
    ].join('\n');
    const store = await import('../pi-package-store.js');

    const result = await store.listPiPackages();
    expect(result.packages).toHaveLength(130);
    expect(result.packages[127]?.warning).toBe('inspection-failed');
    expect(result.packages[128]).toMatchObject({
      source: 'npm:package-128',
      enabled: false,
      warning: 'inspection-limit',
    });
    expect(result.packages[129]?.warning).toBe('inspection-limit');
  });
});
