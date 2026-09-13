import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthAdapter } from '../../interfaces/auth-adapter.js';
import { buildCodexEnv, findFirstWindowsPwshExecutableIndex } from './env-builder.js';

function createAuthAdapter(env: Record<string, string> = {}): AuthAdapter {
  return {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return env;
    },
  };
}

describe('buildCodexEnv', () => {
  const originalPathEntries = Object.entries(process.env).filter(
    ([key]) => key.toLowerCase() === 'path',
  );
  const originalNoColor = process.env.NO_COLOR;
  const originalCliColor = process.env.CLICOLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  const originalTerm = process.env.TERM;
  const originalPsOutputRendering = process.env.PSStyle__OutputRendering;

  afterEach(() => {
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('NO_COLOR', originalNoColor);
    restore('CLICOLOR', originalCliColor);
    restore('FORCE_COLOR', originalForceColor);
    restore('TERM', originalTerm);
    restore('PSStyle__OutputRendering', originalPsOutputRendering);
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === 'path') delete process.env[key];
    }
    for (const [key, value] of originalPathEntries) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it.runIf(process.platform === 'win32')(
    'prioritizes a real pwsh.exe over an earlier pwsh.cmd shim',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-pwsh-'));
      const shimDir = path.join(root, 'shim');
      const executableDir = path.join(root, 'PowerShell', '7');

      try {
        await mkdir(shimDir, { recursive: true });
        await mkdir(executableDir, { recursive: true });
        await writeFile(path.join(shimDir, 'pwsh.cmd'), '@echo off\r\n');
        await writeFile(path.join(executableDir, 'pwsh.exe'), 'test executable placeholder');

        for (const key of Object.keys(process.env)) {
          if (key.toLowerCase() === 'path') delete process.env[key];
        }
        process.env.Path = [shimDir, executableDir].join(path.delimiter);

        const env = await buildCodexEnv(createAuthAdapter(), {});
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');

        expect(pathKey).toBeDefined();
        expect(env[pathKey!]?.split(path.delimiter)).toEqual([executableDir, shimDir]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'skips a WindowsApps pwsh.exe alias when a real executable follows it',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-pwsh-alias-'));
      const aliasDir = path.join(root, 'Microsoft', 'WindowsApps');
      const executableDir = path.join(root, 'PowerShell', '7');

      try {
        await mkdir(aliasDir, { recursive: true });
        await mkdir(executableDir, { recursive: true });
        await writeFile(path.join(aliasDir, 'pwsh.exe'), 'test app execution alias placeholder');
        await writeFile(path.join(executableDir, 'pwsh.exe'), 'test executable placeholder');

        for (const key of Object.keys(process.env)) {
          if (key.toLowerCase() === 'path') delete process.env[key];
        }
        process.env.Path = [aliasDir, executableDir].join(path.delimiter);

        const env = await buildCodexEnv(createAuthAdapter(), {});
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');

        expect(pathKey).toBeDefined();
        expect(env[pathKey!]?.split(path.delimiter)).toEqual([executableDir, aliasDir]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'prioritizes pwsh.exe from a quoted PATH entry',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-pwsh-quoted-'));
      const shimDir = path.join(root, 'shim');
      const executableDir = path.join(root, 'PowerShell', '7');
      const quotedExecutableDir = `"${executableDir}"`;

      try {
        await mkdir(shimDir, { recursive: true });
        await mkdir(executableDir, { recursive: true });
        await writeFile(path.join(shimDir, 'pwsh.cmd'), '@echo off\r\n');
        await writeFile(path.join(executableDir, 'pwsh.exe'), 'test executable placeholder');

        for (const key of Object.keys(process.env)) {
          if (key.toLowerCase() === 'path') delete process.env[key];
        }
        process.env.Path = [shimDir, quotedExecutableDir].join(path.delimiter);

        const env = await buildCodexEnv(createAuthAdapter(), {});
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');

        expect(pathKey).toBeDefined();
        expect(env[pathKey!]?.split(path.delimiter)).toEqual([
          quotedExecutableDir,
          shimDir,
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps host-managed PATH prepends ahead of the prioritized PowerShell directory',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-host-path-'));
      const hostToolsDir = path.join(root, 'host-tools');
      const shimDir = path.join(root, 'shim');
      const executableDir = path.join(root, 'PowerShell', '7');

      try {
        await mkdir(hostToolsDir, { recursive: true });
        await mkdir(shimDir, { recursive: true });
        await mkdir(executableDir, { recursive: true });
        await writeFile(path.join(hostToolsDir, 'rg.exe'), 'host-managed tool');
        await writeFile(path.join(shimDir, 'pwsh.cmd'), '@echo off\r\n');
        await writeFile(path.join(executableDir, 'pwsh.exe'), 'test executable placeholder');

        for (const key of Object.keys(process.env)) {
          if (key.toLowerCase() === 'path') delete process.env[key];
        }
        process.env.Path = [shimDir, executableDir].join(path.delimiter);

        const env = await buildCodexEnv(createAuthAdapter(), {
          pathPrepends: [hostToolsDir],
        });
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');

        expect(pathKey).toBeDefined();
        expect(env[pathKey!]?.split(path.delimiter)).toEqual([
          hostToolsDir,
          executableDir,
          shimDir,
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'skips arbitrary UNC PATH entries while locating pwsh.exe',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-unc-pwsh-'));
      const executableDir = path.join(root, 'PowerShell', '7');

      try {
        await mkdir(executableDir, { recursive: true });
        await writeFile(path.join(executableDir, 'pwsh.exe'), 'test executable placeholder');
        for (const key of Object.keys(process.env)) {
          if (key.toLowerCase() === 'path') delete process.env[key];
        }
        process.env.Path = [String.raw`\\offline.example\share`, executableDir].join(
          path.delimiter,
        );

        const env = await buildCodexEnv(createAuthAdapter(), {});
        const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
        expect(env[pathKey!]?.split(path.delimiter)).toEqual([
          executableDir,
          String.raw`\\offline.example\share`,
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('defaults command output to plain text across common CLI color controls', async () => {
    delete process.env.NO_COLOR;
    delete process.env.CLICOLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.TERM;
    delete process.env.PSStyle__OutputRendering;

    const env = await buildCodexEnv(createAuthAdapter(), {});

    expect(env.NO_COLOR).toBe('1');
    expect(env.CLICOLOR).toBe('0');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.TERM).toBe('dumb');
    expect(env.PSStyle__OutputRendering).toBe('PlainText');
  });

  it('passes requested credential mode to the auth adapter', async () => {
    const getAuthEnv = vi.fn(async () => ({ CODEX_HOME: '/tmp/codex-home' }));
    const env = await buildCodexEnv(
      {
        ...createAuthAdapter(),
        getAuthEnv,
      },
      {},
      { credentialMode: 'gateway-key' },
    );

    expect(getAuthEnv).toHaveBeenCalledWith({ credentialMode: 'gateway-key' });
    expect(env.CODEX_HOME).toBe('/tmp/codex-home');
  });

  it('keeps explicit command color environment overrides', async () => {
    process.env.NO_COLOR = '0';
    process.env.CLICOLOR = '1';
    process.env.FORCE_COLOR = '1';
    process.env.TERM = 'xterm-256color';
    process.env.PSStyle__OutputRendering = 'Ansi';

    const env = await buildCodexEnv(createAuthAdapter(), {});

    expect(env.NO_COLOR).toBe('0');
    expect(env.CLICOLOR).toBe('1');
    expect(env.FORCE_COLOR).toBe('1');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.PSStyle__OutputRendering).toBe('Ansi');
  });
});

describe('findFirstWindowsPwshExecutableIndex', () => {
  it('stops probing after the first accessible pwsh.exe entry', async () => {
    const probed: string[] = [];

    const index = await findFirstWindowsPwshExecutableIndex(
      ['C:\\PowerShell', 'Z:\\slow-mapped-drive'],
      async (directory) => {
        probed.push(directory);
        if (directory === 'C:\\PowerShell') return true;
        throw new Error('later PATH entries must not be probed');
      },
    );

    expect(index).toBe(0);
    expect(probed).toEqual(['C:\\PowerShell']);
  });
});
