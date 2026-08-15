import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtime = vi.hoisted(() => ({
  userData: '',
  listOutput: '',
  stderr: '',
  exitCode: 0,
  spawns: [] as Array<{ args: string[]; env: Record<string, string | undefined> }>,
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

vi.mock('node:child_process', () => ({
  spawn: (_binary: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
    runtime.spawns.push({ args: [...args], env: { ...(options.env ?? {}) } });
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
    };
    queueMicrotask(() => {
      if (args.includes('list')) {
        for (const handler of stdoutHandlers) handler(Buffer.from(runtime.listOutput));
      }
      if (runtime.stderr) {
        for (const handler of stderrHandlers) handler(Buffer.from(runtime.stderr));
      }
      for (const handler of closeHandlers) handler(runtime.exitCode);
    });
    return child;
  },
}));

const roots: string[] = [];

async function createPackage(options?: { oversizedManifest?: boolean; lifecycleScript?: boolean }): Promise<{
  root: string;
  source: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-security-pkg-'));
  roots.push(root);
  const source = options?.oversizedManifest ? 'npm:oversized-package' : 'npm:test-extension';
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

beforeEach(async () => {
  runtime.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-pi-package-security-home-'));
  roots.push(runtime.userData);
  runtime.listOutput = '';
  runtime.stderr = '';
  runtime.exitCode = 0;
  runtime.spawns = [];
  vi.resetModules();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('Pi package executable-code boundary', () => {
  it('holds Extension packages disabled until explicit approval and revokes approval on update', async () => {
    const { root, source } = await createPackage();
    const store = await import('../pi-package-store.js');

    const initial = await store.listPiPackages();
    expect(initial.packages[0]).toMatchObject({
      source,
      enabled: false,
      requiresExtensionApproval: true,
    });
    await expect(store.mutatePiPackage({
      action: 'set-enabled', source, enabled: true,
    })).rejects.toThrow(/explicit approval/);

    const approved = await store.mutatePiPackage({
      action: 'set-enabled', source, enabled: true, confirmed: true,
    });
    expect(approved.affectedPackage).toMatchObject({ source, enabled: true });
    expect(approved.affectedPackage?.requiresExtensionApproval).toBeUndefined();
    const canonicalRoot = await fs.realpath(root);
    await expect(store.resolveManagedPiPackageResources()).resolves.toMatchObject({
      extensions: [path.join(canonicalRoot, 'extensions', 'index.ts')],
      packageRoots: [canonicalRoot],
    });

    const updated = await store.mutatePiPackage({ action: 'update', source });
    expect(updated.affectedPackage).toMatchObject({
      source,
      enabled: false,
      requiresExtensionApproval: true,
    });
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
    await store.mutatePiPackage({
      action: 'set-enabled', source, enabled: true, confirmed: true,
    });
    const migrated = JSON.parse(await fs.readFile(
      path.join(stateDir, 'cindy-package-state.json'),
      'utf8',
    )) as { version: number; disabledSources: string[]; approvedExtensionSources: string[] };
    expect(migrated).toEqual({
      version: 2,
      disabledSources: ['npm:keep-disabled'],
      approvedExtensionSources: [source],
    });

    await store.mutatePiPackage({ action: 'install', source, confirmed: true });
    const installSpawn = runtime.spawns.find(({ args }) => args.includes('install'));
    expect(installSpawn?.env.npm_config_ignore_scripts).toBe('true');
    expect(installSpawn?.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
    expect(installSpawn?.args).toContain('--no-approve');
  });

  it('normalizes a bare registry package name to Pi npm source syntax', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');

    await store.mutatePiPackage({
      action: 'install',
      source: source.slice(4),
      confirmed: true,
    });
    expect(runtime.spawns.find(({ args }) => args.includes('install'))?.args)
      .toContain(source);
  });

  it('rejects task-relative local paths at the context-free Settings boundary', async () => {
    const store = await import('../pi-package-store.js');

    await expect(store.mutatePiPackage({
      action: 'install',
      source: './extensions/context-mode',
      confirmed: true,
    })).rejects.toThrow(/working directory/);
    expect(runtime.spawns).toEqual([]);
  });

  it('notifies open settings and command palettes after a successful mutation', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);

    await store.mutatePiPackage({ action: 'install', source, confirmed: true });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await store.mutatePiPackage({ action: 'update', source });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('refreshes open settings when a failed update has already revoked approval', async () => {
    const { source } = await createPackage();
    const store = await import('../pi-package-store.js');
    await store.mutatePiPackage({
      action: 'set-enabled',
      source,
      enabled: true,
      confirmed: true,
    });
    const listener = vi.fn();
    const unsubscribe = store.onPiPackagesChanged(listener);

    runtime.exitCode = 1;
    runtime.stderr = 'update failed';
    await expect(store.mutatePiPackage({ action: 'update', source }))
      .rejects.toThrow(/update failed/);
    expect(listener).toHaveBeenCalledTimes(1);

    runtime.exitCode = 0;
    runtime.stderr = '';
    await expect(store.listPiPackages()).resolves.toMatchObject({
      packages: [{ source, enabled: false, requiresExtensionApproval: true }],
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

    await store.mutatePiPackage({
      action: 'set-enabled',
      source: normalizedSource,
      enabled: true,
      confirmed: true,
    });
    const reinstalled = await store.mutatePiPackage({
      action: 'install',
      source: root,
      confirmed: true,
    });

    expect(reinstalled.affectedPackage).toMatchObject({
      source: normalizedSource,
      enabled: false,
      requiresExtensionApproval: true,
    });

    await store.mutatePiPackage({ action: 'update', source: normalizedSource });
    await store.mutatePiPackage({ action: 'remove', source: normalizedSource });
    const canonicalRoot = await fs.realpath(root);
    expect(runtime.spawns.find(({ args }) => args.includes('update'))?.args)
      .toContain(canonicalRoot);
    expect(runtime.spawns.find(({ args }) => args.includes('remove'))?.args)
      .toContain(canonicalRoot);
  });

  it('rejects URL sources that would persist embedded credentials', async () => {
    const store = await import('../pi-package-store.js');
    await expect(store.mutatePiPackage({
      action: 'install',
      source: 'https://user:secret@example.com/acme/package.git',
      confirmed: true,
    })).rejects.toThrow(/credentials/);
    expect(runtime.spawns).toEqual([]);
  });

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
    await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
      extensions: [], skills: [], promptTemplates: [], packageRoots: [await fs.realpath(packageRoot)],
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
    await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
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
      packages: [{ source, enabled: false, warning: 'inspection-limit', resources: [] }],
    });
    await expect(store.resolveManagedPiPackageResources()).resolves.toEqual({
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
