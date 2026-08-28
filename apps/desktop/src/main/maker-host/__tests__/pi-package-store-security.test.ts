import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  promises as fs,
  rmSync,
  symlinkSync,
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
}));

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
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
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
) {
  const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
  const identity = request.action === 'set-enabled' && request.enabled === true
    ? await store.capturePiPackageEnableIdentity(request.source)
    : undefined;
  const binding = identity
    ? { expectedPackageFingerprint: identity.expectedPackageFingerprint }
    : undefined;
  return store.mutatePiPackage(request, issuePiPackageMutationGrant(request, binding));
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

  it('rejects a truncated Pi package list instead of parsing its retained tail', async () => {
    const entries: string[] = ['User packages:'];
    for (let index = 0; index < 128; index += 1) {
      entries.push(
        `  npm:package-${index}-${'s'.repeat(1_024)}`,
        `    /managed/package-${index}/${'p'.repeat(1_024)}`,
      );
    }
    runtime.listOutput = `${entries.join('\n')}\n`;
    expect(Buffer.byteLength(runtime.listOutput, 'utf8')).toBeGreaterThan(128 * 1_024);
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).rejects.toThrow(/list output exceeded the safe limit/i);
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

  it('holds Extension packages disabled until explicit approval and re-enables them after a confirmed update', async () => {
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
      enabled: false,
      requiresExtensionApproval: true,
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

  it('enables an Extension package from the same confirmed install', async () => {
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

  it('keeps an explicitly disabled Extension package disabled after a confirmed update', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: true });
    await mutateAuthorized(store, { action: 'set-enabled', source, enabled: false });

    const updated = await mutateAuthorized(store, { action: 'update', source });

    expect(updated.affectedPackage).toMatchObject({
      source,
      enabled: false,
      requiresExtensionApproval: true,
    });
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

  it('does not reapprove a sibling whose scoped hoisted dependency changes during install', async () => {
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
        enabled: false,
        requiresExtensionApproval: true,
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
    expect(state.approvedExtensionSources).toEqual([secondSource]);
    expect(Object.keys(state.approvedExtensionFingerprints)).toEqual([secondSource]);
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

  it('builds a bounded Main-inspected enable identity without exposing local paths', async () => {
    const { root, source } = await createPackage();
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: `trusted\n\u202E${'名'.repeat(400)}/../../private`,
      version: `1.2.3\r\u2066${'v'.repeat(400)}`,
      pi: { extensions: ['./extensions'], prompts: ['./prompts'] },
    }));
    const store = await import('../pi-package-store.js');

    const before = await store.capturePiPackageEnableIdentity(source);
    expect(before.displayLabel).not.toContain(root);
    expect(before.displayLabel).not.toContain('\r');
    expect(before.displayLabel).not.toContain('\u202E');
    expect(before.displayLabel).not.toContain('\u2066');
    expect(before.displayLabel.split('\n')).toHaveLength(2);
    expect(before.displayLabel.split('\n')[0]).toContain(path.basename(root).slice(0, 24));
    expect(before.expectedPackageFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(before.displayLabel).toContain(
      `SHA-256: ${before.expectedPackageFingerprint}`,
    );
    expect(Buffer.byteLength(before.displayLabel, 'utf8')).toBeLessThanOrEqual(466);
    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function spoofedReplacement() {}',
    );
    const after = await store.capturePiPackageEnableIdentity(source);

    expect(before.displayLabel.split('\n')[0]).toBe(after.displayLabel.split('\n')[0]);
    expect(before.expectedPackageFingerprint).not.toBe(after.expectedPackageFingerprint);
    expect(after.displayLabel).toContain(`SHA-256: ${after.expectedPackageFingerprint}`);
  });

  it('rejects an enable grant when another instance replaces package bytes after confirmation', async () => {
    const { root, source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    const { expectedPackageFingerprint } = await firstStore.capturePiPackageEnableIdentity(source);
    const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
    const request = { action: 'set-enabled' as const, source, enabled: true };
    const grant = issuePiPackageMutationGrant(request, { expectedPackageFingerprint });

    vi.resetModules();
    const secondStore = await import('../pi-package-store.js');
    await fs.writeFile(
      path.join(root, 'extensions', 'index.ts'),
      'export default function replacedAfterConfirmation() {}',
    );
    await secondStore.listPiPackages();

    await expect(firstStore.mutatePiPackage(request, grant)).rejects.toThrow(
      /changed after authorization/i,
    );
    await expect(firstStore.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: false, requiresExtensionApproval: true }],
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
      packages: [{ source, enabled: false, requiresExtensionApproval: true }],
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
      packages: [{ source, enabled: false, requiresExtensionApproval: true }],
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
      packages: [{ source, enabled: false, requiresExtensionApproval: true }],
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
          enabled: false,
          canToggle: false,
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
          enabled: false,
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
        { source: sources[1], enabled: false, warning: 'inspection-limit' },
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
        { source: second.source, enabled: false, warning: 'inspection-limit' },
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
        { source: packages[1]!.source, enabled: false, warning: 'inspection-limit' },
        { source: packages[2]!.source, enabled: false, warning: 'inspection-limit' },
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
        { enabled: false, warning: 'inspection-limit' },
        { enabled: false, warning: 'inspection-limit' },
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
        { source: descendantRoot, enabled: false, warning: 'inspection-limit' },
      ],
    });
    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([]);
  });

  it('keeps a snapshot timeout disabled across cache expiry until staging succeeds', async () => {
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
          packages: [{ source, enabled: false, warning: 'inspection-limit' }],
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
      await vi.waitFor(() => expect(secondListener).toHaveBeenCalled(), { timeout: 2_000 });
      await expect(secondStore.listPiPackages()).resolves.toMatchObject({
        packages: [{ source, enabled: false, warning: 'inspection-limit' }],
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
        await vi.waitFor(() => expect(firstListener).toHaveBeenCalled(), { timeout: 2_000 });
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

  it('preserves v1 disabled sources while migrating approval state and blocks lifecycle scripts', async () => {
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
    expect(installSpawn?.env.npm_config_ignore_scripts).toBe('true');
    expect(installSpawn?.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
    expect(installSpawn?.args).toContain('--no-approve');
  });

  it.each([
    ['transient I/O', 'EIO'],
    ['permission', 'EACCES'],
  ])('fails closed without replacing disabled state after a %s read failure', async (_label, code) => {
    const { source } = await createSkillOnlyPackage('npm:disabled-skill-package');
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const persistedState = `${JSON.stringify({
      version: 3,
      disabledSources: [source],
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
      await expect(store.listPiPackages()).resolves.toMatchObject({
        packages: [{
          source,
          enabled: false,
          canToggle: false,
          warning: 'inspection-failed',
          resources: [expect.objectContaining({ kind: 'skill' })],
        }],
      });
      await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
        extensions: [], skills: [], promptTemplates: [], packageRoots: [],
      });
      await expect(store.mutatePiPackage({
        action: 'set-enabled',
        source,
        enabled: false,
      })).rejects.toThrow('Pi extension state is unavailable');
    } finally {
      readSpy.mockRestore();
    }
    await expect(fs.readFile(stateFile, 'utf8')).resolves.toBe(persistedState);
  });

  it('fails closed and preserves a corrupt state file instead of treating it as empty', async () => {
    const { source } = await createSkillOnlyPackage('npm:corrupt-state-skill-package');
    const stateDir = path.join(runtime.userData, 'pi-package-home');
    const stateFile = path.join(stateDir, 'cindy-package-state.json');
    const corruptState = '{"version":3,"disabledSources":[';
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stateFile, corruptState);
    const store = await import('../pi-package-store.js');

    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{
        source,
        enabled: false,
        canToggle: false,
        warning: 'inspection-failed',
      }],
    });
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'corrupt-state-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
    await expect(store.mutatePiPackage({
      action: 'set-enabled',
      source,
      enabled: false,
    })).rejects.toThrow('Pi extension state is unavailable');
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

    unsubscribe();
    await mutateAuthorized(store, { action: 'update', source });
    expect(listener).toHaveBeenCalledTimes(1);
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

    await vi.waitFor(() => expect(listener).toHaveBeenCalled(), { timeout: 2_000 });
    await expect(firstStore.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: true }],
    });
    unsubscribe();
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

  it('rejects a stale disable after another shared-userData instance removes the package', async () => {
    const { source } = await createPackage();
    const installedList = runtime.listOutput;
    const firstStore = await import('../pi-package-store.js');
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

    await expect(firstStore.mutatePiPackage({
      action: 'set-enabled',
      source,
      enabled: false,
    })).rejects.toThrow(/not installed/);

    const state = JSON.parse(await fs.readFile(
      path.join(runtime.userData, 'pi-package-home', 'cindy-package-state.json'),
      'utf8',
    )) as { disabledSources: string[] };
    expect(state.disabledSources).toEqual([]);
  });

  it('re-inspects approval state under the shared lock before staging a session snapshot', async () => {
    const { root, source } = await createPackage();
    const firstStore = await import('../pi-package-store.js');
    await mutateAuthorized(firstStore, {
      action: 'set-enabled',
      source,
      enabled: true,
    });
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

  it('refreshes open settings when a failed update has already revoked approval', async () => {
    const { source } = await createPackage();
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
      packages: [{ source, enabled: false, requiresExtensionApproval: true }],
    });
    unsubscribe();
  });

  it('refreshes open settings when set-enabled persists but the follow-up list fails', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);
    runtime.listOutcomes = [
      { stdout: runtime.listOutput, exitCode: 0 },
      { stdout: runtime.listOutput, exitCode: 0 },
      { stderr: 'list failed after state write', exitCode: 1 },
    ];

    await expect(mutateAuthorized(store, {
      action: 'set-enabled',
      source,
      enabled: true,
    })).rejects.toThrow(/list failed after state write/);
    expect(listener).toHaveBeenCalledTimes(1);

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

  it('revokes approval when Pi normalizes an absolute local package source', async () => {
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
    const canonicalRoot = await fs.realpath(root);
    expect(runtime.spawns.find(({ args }) => args.includes('update'))?.args)
      .toContain(canonicalRoot);
    expect(runtime.spawns.find(({ args }) => args.includes('remove'))?.args)
      .toContain(canonicalRoot);
  });

  it('rejects URL sources that would persist embedded credentials', async () => {
    const store = await import('../pi-package-store.js');
    await expect(
      mutateAuthorized(store, {
        action: 'install',
        source: 'https://user:secret@example.com/acme/package.git',
      }),
    ).rejects.toThrow(/credentials/);
    expect(runtime.spawns).toEqual([]);
  });

  it('quarantines oversized data-only and mixed package roots without dropping valid packages', async () => {
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
          enabled: false,
          warning: 'inspection-limit',
          resources: [],
        },
        {
          source: oversizedMixedSource,
          enabled: false,
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
        enabled: false,
        requiresExtensionApproval: true,
        resources: [{ kind: 'extension', name: 'direct.ts' }],
      },
      {
        source: '../convention',
        enabled: false,
        requiresExtensionApproval: true,
        resources: [{ kind: 'extension', name: 'index.ts' }],
      },
    ]);
  });

  it('keeps non-extension single files disabled and rejects enable attempts', async () => {
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
        enabled: false,
        canToggle: false,
        resources: [],
        warning: 'no-resources',
      }],
    });
    await expect(store.capturePiPackageEnableIdentity(source)).rejects.toThrow(
      /no launchable resources/i,
    );
    const request = { action: 'set-enabled' as const, source, enabled: true };
    const { issuePiPackageMutationGrant } = await import('../pi-package-mutation-grant.js');
    await expect(store.mutatePiPackage(
      request,
      issuePiPackageMutationGrant(request, { expectedPackageFingerprint: null }),
    )).rejects.toThrow(/no launchable resources/i);
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
        enabled: false,
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
          enabled: false,
          canToggle: false,
          resources: [],
          warning: 'no-resources',
        },
        {
          source: 'npm:theme-package',
          enabled: false,
          canToggle: false,
          resources: [{ kind: 'theme', compatibility: 'unsupported' }],
        },
        {
          source: 'npm:filtered-package',
          enabled: false,
          canToggle: false,
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

  it('keeps theme-only packages disabled because Cindy does not load Pi TUI themes', async () => {
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
        enabled: false,
        canToggle: false,
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

  it('keeps disabled lifecycle scripts visible as a compatibility warning', async () => {
    const { source } = await createPackage({ lifecycleScript: true });
    const store = await import('../pi-package-store.js');
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, warning: 'lifecycle-scripts-disabled' }],
    });
  });

  it('redacts and disables unsafe URL sources already persisted by Pi', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-unsafe-source-'));
    roots.push(root);
    const unsafeSource = 'git:https://user:secret@example.com/acme/package.git?token=private#fragment';
    runtime.listOutput = `User packages:\n  ${unsafeSource}\n    ${root}\n`;
    const store = await import('../pi-package-store.js');

    const result = await store.listPiPackages();
    expect(result.packages).toEqual([{
      source: 'git:https://example.com/acme/package.git',
      name: 'git:https://example.com/acme/package.git',
      enabled: false,
      manageable: false,
      resources: [],
      warning: 'unsafe-source',
    }]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private');
    await expect(store.resolveManagedPiPackageResources({
      snapshotRoot: path.join(runtime.userData, 'unsafe-snapshot'),
    })).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [],
    });
  });

  it('redacts unsafe saved URLs from Pi package command failures', async () => {
    runtime.stderr = 'Failed to load https://user:secret@example.com/acme/package.git?token=private#fragment';
    runtime.exitCode = 1;
    const store = await import('../pi-package-store.js');

    const failure = await store.listPiPackages().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('https://example.com/acme/package.git');
    expect((failure as Error).message).not.toContain('secret');
    expect((failure as Error).message).not.toContain('private');
  });

  it('fails closed with an inspection-limit warning for oversized manifests', async () => {
    const { source } = await createPackage({ oversizedManifest: true });
    const store = await import('../pi-package-store.js');
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{
        source,
        enabled: false,
        canToggle: false,
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
      canToggle: false,
      warning: 'inspection-limit',
    });
    expect(result.packages[129]?.warning).toBe('inspection-limit');
  });
});
