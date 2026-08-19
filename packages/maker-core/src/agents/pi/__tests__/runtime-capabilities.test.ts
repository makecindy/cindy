import fs from 'node:fs';
import os from 'node:os';

import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import {
  capturePiRuntimeCapabilityManifest,
  identifyManagedPiPackageCommandNames,
  parsePiRuntimeCommands,
  snapshotManagedPiPackageSkills,
} from '../runtime-capabilities.js';

describe('Pi runtime capability parsing', () => {
  const command = {
    name: 'skill:fixture',
    description: 'fixture skill',
    source: 'skill',
    sourceInfo: {
      source: 'auto',
      scope: 'user',
      baseDir: '/private/user/pi-home',
      path: '/private/user/pi-home/skills/fixture',
    },
  };

  it('keeps stable command and provenance fields from a real-shaped response', () => {
    expect(parsePiRuntimeCommands({ commands: [command] })).toEqual({
      ok: true,
      commands: [command],
    });
  });

  it('accepts an authoritative empty catalog without treating it as scanner discovery', () => {
    expect(parsePiRuntimeCommands({ commands: [] })).toEqual({ ok: true, commands: [] });
  });

  it('freezes pathless and pathful user Skills by scanned directory when frontmatter name differs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-runtime-user-skill-'));
    const baseDir = path.join(root, 'pi-home');
    const firstTarget = path.join(root, 'target-a');
    const secondTarget = path.join(root, 'target-b');
    const linkedSource = path.join(baseDir, 'skills', 'directory-name');
    try {
      fs.mkdirSync(firstTarget, { recursive: true });
      fs.mkdirSync(secondTarget, { recursive: true });
      fs.writeFileSync(
        path.join(firstTarget, 'SKILL.md'),
        '---\nname: frontmatter-name\n---\n# First target\n',
      );
      fs.writeFileSync(
        path.join(secondTarget, 'SKILL.md'),
        '---\nname: frontmatter-name\n---\n# Second target\n',
      );
      fs.mkdirSync(path.dirname(linkedSource), { recursive: true });
      fs.symlinkSync(
        firstTarget,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const manifest = await capturePiRuntimeCapabilityManifest(
        {
          request: async () => ({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
              commands: [
                {
                  name: 'skill:frontmatter-name',
                  source: 'skill',
                  sourceInfo: { source: 'auto', scope: 'user', baseDir },
                },
                {
                  name: 'skill:frontmatter-name',
                  source: 'skill',
                  sourceInfo: {
                    source: 'auto',
                    scope: 'user',
                    baseDir,
                    path: path.join(firstTarget, 'SKILL.md'),
                  },
                },
              ],
            },
          }),
        },
        {},
        1,
        'ready',
        { userSkillBaseDirs: [baseDir] },
      );
      const runtimeCommand = manifest.commands[0]!;
      const provenance = Reflect.get(
        runtimeCommand,
        Symbol.for('cindy.pi.runtime-user-skill-canonical-source'),
      );
      expect(provenance).toMatchObject({
        canonicalSourcePath: await fs.promises.realpath(firstTarget),
        entrypointPath: path.join(
          await fs.promises.realpath(baseDir),
          'skills',
          'directory-name',
          'SKILL.md',
        ),
      });
      expect(Object.isFrozen(provenance)).toBe(true);
      expect(Reflect.get(
        manifest.commands[1],
        Symbol.for('cindy.pi.runtime-user-skill-canonical-source'),
      )).toBe(provenance);
      expect(JSON.stringify(runtimeCommand)).not.toContain(firstTarget);

      fs.unlinkSync(linkedSource);
      fs.symlinkSync(
        secondTarget,
        linkedSource,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(Reflect.get(
        runtimeCommand,
        Symbol.for('cindy.pi.runtime-user-skill-canonical-source'),
      )).toBe(provenance);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an unknown manifest when pathless user Skill provenance times out after RPC', async () => {
    const baseDir = path.resolve(os.tmpdir(), 'pi-runtime-provenance-timeout');
    const realpath = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === baseDir) {
        return new Promise<string>(() => {});
      }
      return path.resolve(String(candidate));
    });
    vi.useFakeTimers();
    try {
      const pending = capturePiRuntimeCapabilityManifest(
        {
          request: async () => {
            vi.setSystemTime(Date.now() + 4_999);
            return {
              type: 'response',
              command: 'get_commands',
              success: true,
              data: {
                commands: [{
                  name: 'skill:demo',
                  source: 'skill',
                  sourceInfo: { source: 'auto', scope: 'user', baseDir },
                }],
              },
            };
          },
        },
        {},
        1,
        'ready',
        { userSkillBaseDirs: [baseDir] },
      );

      await vi.advanceTimersByTimeAsync(4_999);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        status: 'unknown',
        commands: [],
        error: { code: 'timeout' },
      });
    } finally {
      vi.useRealTimers();
      realpath.mockRestore();
    }
  });

  it('returns an unknown manifest when a configured user Skill root cannot be canonicalized', async () => {
    const baseDir = path.resolve(os.tmpdir(), 'pi-runtime-provenance-io-failure');
    const realpath = vi.spyOn(fs.promises, 'realpath').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === baseDir) {
        throw Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
      }
      return path.resolve(String(candidate));
    });
    try {
      await expect(capturePiRuntimeCapabilityManifest(
        {
          request: async () => ({
            type: 'response',
            command: 'get_commands',
            success: true,
            data: {
              commands: [{
                name: 'skill:demo',
                source: 'skill',
                sourceInfo: { source: 'auto', scope: 'user', baseDir },
              }],
            },
          }),
        },
        {},
        1,
        'ready',
        { userSkillBaseDirs: [baseDir] },
      )).resolves.toMatchObject({
        status: 'unknown',
        commands: [],
      });
    } finally {
      realpath.mockRestore();
    }
  });

  it('accepts duplicate names because Pi can expose an Extension command and Prompt together', () => {
    const extension = { ...command, name: 'hello', source: 'extension' };
    const prompt = { ...command, name: 'hello', source: 'prompt' };
    expect(parsePiRuntimeCommands({ commands: [extension, prompt] })).toEqual({
      ok: true,
      commands: [extension, prompt],
    });
  });

  it('marks commands only when Pi provenance is inside an enabled managed package root', () => {
    const extensionCommand = {
      ...command,
      name: 'sample',
      source: 'extension',
      sourceInfo: {
        source: 'extension',
        baseDir: '/private/cindy/pi-packages/sample',
        path: 'extensions/index.ts',
      },
    };
    const unrelated = {
      ...command,
      name: 'other',
      source: 'extension',
      sourceInfo: {
        source: 'extension',
        path: '/private/user/.pi/extensions/other.ts',
      },
    };
    expect(identifyManagedPiPackageCommandNames(
      [extensionCommand, unrelated],
      ['/private/cindy/pi-packages/sample'],
    )).toEqual(['sample']);
  });

  it('does not authorize a colliding name when any runtime entry has unmanaged provenance', () => {
    expect(identifyManagedPiPackageCommandNames([
      {
        ...command,
        name: 'plan',
        source: 'extension',
        sourceInfo: { path: '/private/cindy/pi-packages/sample/index.ts' },
      },
      {
        ...command,
        name: 'plan',
        source: 'extension',
        sourceInfo: { path: '/private/cindy/internal/plan-mode.ts' },
      },
    ], ['/private/cindy/pi-packages/sample'])).toEqual([]);
  });

  it('snapshots managed skills and marks only unambiguous runtime-proven commands loaded', () => {
    const packageRoot = path.resolve('managed-package-fixture');
    const loadedSkill = path.join(packageRoot, 'skills', 'loaded', 'SKILL.md');
    const unprovenSkill = path.join(packageRoot, 'skills', 'unproven', 'SKILL.md');
    const ambiguousSkill = path.join(packageRoot, 'skills', 'ambiguous', 'SKILL.md');
    const commands = [
      {
        ...command,
        name: 'skill:loaded-runtime-name',
        sourceInfo: {
          ...command.sourceInfo,
          baseDir: path.dirname(loadedSkill),
          path: loadedSkill,
        },
      },
      {
        ...command,
        name: 'skill:not-managed',
        sourceInfo: {
          ...command.sourceInfo,
          baseDir: path.dirname(unprovenSkill),
          path: unprovenSkill,
        },
      },
      ...['skill:ambiguous-a', 'skill:ambiguous-b'].map((name) => ({
        ...command,
        name,
        sourceInfo: {
          ...command.sourceInfo,
          baseDir: path.dirname(ambiguousSkill),
          path: ambiguousSkill,
        },
      })),
    ];

    expect(snapshotManagedPiPackageSkills(
      [
        { path: loadedSkill, name: 'loaded-label', description: 'Loaded skill' },
        { path: unprovenSkill, name: 'unproven-label' },
        { path: ambiguousSkill, name: 'ambiguous-label' },
      ],
      commands,
      ['skill:loaded-runtime-name', 'skill:ambiguous-a', 'skill:ambiguous-b'],
    )).toEqual([
      {
        sourcePath: loadedSkill,
        name: 'loaded-label',
        description: 'Loaded skill',
        runtimeCommandName: 'skill:loaded-runtime-name',
      },
      { sourcePath: unprovenSkill, name: 'unproven-label' },
      { sourcePath: ambiguousSkill, name: 'ambiguous-label' },
    ]);
  });

  it.each([
    ['missing commands', {}],
    ['missing sourceInfo', { commands: [{ ...command, sourceInfo: undefined }] }],
    ['invalid known sourceInfo field', { commands: [{ ...command, sourceInfo: { source: 'auto', scope: 1 } }] }],
    ['unknown command field', { commands: [{ ...command, extra: 'secret' }] }],
    ['unknown sourceInfo field', { commands: [{ ...command, sourceInfo: { ...command.sourceInfo, extra: 'secret' } }] }],
    ['unknown response field', { commands: [command], extra: 'secret' }],
    ['oversized payload', { commands: [{ ...command, description: 'x'.repeat(4_097) }] }],
  ])('rejects conservative malformed case: %s', (_name, data) => {
    expect(parsePiRuntimeCommands(data)).toEqual({ ok: false });
  });

  it('rejects a catalog whose total serialized payload is oversized', () => {
    const commands = Array.from({ length: 100 }, (_, index) => ({
      ...command,
      name: `skill:fixture-${index}`,
      description: 'x'.repeat(3_000),
    }));
    expect(parsePiRuntimeCommands({ commands })).toEqual({ ok: false });
  });

  it('redacts rpc failures and classifies unsupported/timeout as unknown', async () => {
    const unsupported = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: false, error: '/secret/provider/path unsupported' }) },
      { sessionId: 's1', sdkSessionId: '/private/session.jsonl' },
      1,
      'ready',
    );
    expect(unsupported).toMatchObject({
      sessionId: 's1',
      sdkSessionId: '/private/session.jsonl',
      status: 'unknown',
      error: { stage: 'ready', code: 'unsupported', message: 'Pi does not support runtime command discovery' },
    });
    expect(JSON.stringify(unsupported)).not.toContain('secret/provider/path');

    const timedOut = await capturePiRuntimeCapabilityManifest(
      { request: async () => { throw new Error('pi rpc timeout after 30000ms: get_commands /token=secret'); } },
      { sessionId: 's2' },
      2,
      'ready',
    );
    expect(timedOut).toMatchObject({ status: 'unknown', error: { code: 'timeout' } });
    expect(JSON.stringify(timedOut)).not.toContain('token=secret');
  });

  it('marks malformed and explicit rpc failures without throwing', async () => {
    const malformed = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: true, data: { commands: [{ ...command, sourceInfo: {} }] } }) },
      { sessionId: 's1' },
      1,
      'ready',
    );
    expect(malformed).toMatchObject({ status: 'failed', error: { code: 'malformed_response' } });

    const failed = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: false, error: 'gateway failed' }) },
      { sessionId: 's1' },
      2,
      'switch_session',
    );
    expect(failed).toMatchObject({ status: 'failed', error: { stage: 'switch_session', code: 'rpc_failed' } });

    const rejectedTimeout = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: false, error: 'timeout waiting for get_commands' }) },
      { sessionId: 's1' },
      3,
      'ready',
    );
    expect(rejectedTimeout).toMatchObject({ status: 'failed', error: { code: 'rpc_failed' } });

    const rejectedProcessText = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: false, error: 'process already exited' }) },
      { sessionId: 's1' },
      4,
      'ready',
    );
    expect(rejectedProcessText).toMatchObject({ status: 'failed', error: { code: 'rpc_failed' } });

    const rejectedClosed = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: false, error: 'account closed' }) },
      { sessionId: 's1' },
      5,
      'ready',
    );
    expect(rejectedClosed).toMatchObject({ status: 'failed', error: { code: 'rpc_failed' } });

    const rejectedSpawn = await capturePiRuntimeCapabilityManifest(
      { request: async () => ({ type: 'response', command: 'get_commands', success: false, error: 'extension spawn policy rejected' }) },
      { sessionId: 's1' },
      6,
      'ready',
    );
    expect(rejectedSpawn).toMatchObject({ status: 'failed', error: { code: 'rpc_failed' } });

    const writeFailure = await capturePiRuntimeCapabilityManifest(
      { request: async () => { throw new Error('pi rpc write failed: EPIPE'); } },
      { sessionId: 's1' },
      7,
      'ready',
    );
    expect(writeFailure).toMatchObject({ status: 'unknown', error: { code: 'process_unavailable' } });

    const processError = await capturePiRuntimeCapabilityManifest(
      { request: async () => { throw new Error('pi process error: spawn ENOENT'); } },
      { sessionId: 's1' },
      8,
      'ready',
    );
    expect(processError).toMatchObject({ status: 'unknown', error: { code: 'process_unavailable' } });

    const processExit = await capturePiRuntimeCapabilityManifest(
      { request: async () => { throw new Error('pi process exited (code=1, signal=null)'); } },
      { sessionId: 's1' },
      9,
      'ready',
    );
    expect(processExit).toMatchObject({ status: 'unknown', error: { code: 'process_unavailable' } });

    const alreadyExited = await capturePiRuntimeCapabilityManifest(
      { request: async () => { throw new Error('pi process already exited'); } },
      { sessionId: 's1' },
      10,
      'ready',
    );
    expect(alreadyExited).toMatchObject({ status: 'unknown', error: { code: 'process_unavailable' } });
  });

  it.each([
    ['non-object', null],
    ['missing type', { command: 'get_commands', success: true, data: { commands: [command] } }],
    ['missing success', { type: 'response', command: 'get_commands', data: { commands: [command] } }],
    ['wrong command', { type: 'response', command: 'get_state', success: true, data: { commands: [command] } }],
    ['unknown envelope field', { type: 'response', command: 'get_commands', success: true, data: { commands: [command] }, extra: 'secret' }],
  ])('rejects malformed RPC response envelope: %s', async (_name, response) => {
    const manifest = await capturePiRuntimeCapabilityManifest(
      { request: async () => response as never },
      { sessionId: 's1' },
      1,
      'ready',
    );
    expect(manifest).toMatchObject({ status: 'failed', error: { code: 'malformed_response' } });
  });
});
