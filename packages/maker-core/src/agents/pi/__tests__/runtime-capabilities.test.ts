import { describe, expect, it } from 'vitest';
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
