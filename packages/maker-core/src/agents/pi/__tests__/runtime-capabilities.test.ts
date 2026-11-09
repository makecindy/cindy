import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { PiRpcResponse } from '../rpc-client.js';

import {
  capturePiRuntimeCapabilitiesWithRetry,
  capturePiRuntimeCapabilityManifest,
  identifyManagedPiPackageCommandNames,
  parsePiRuntimeCommands,
  preparePinnedPiSkillInvocation,
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

  // #7381/#8549 (unit): exercise actual provider dispatch. The previous
  // /learn and /skill:learn cases missed /cindy:learn before normalization.
  it.each([
    { input: '/learn release flow', expected: '/skill:learn release flow' },
    { input: '/skill:learn release flow', expected: '/skill:learn release flow' },
    { input: '/cindy:learn', expected: '/skill:learn' },
    { input: '/cindy:learn release flow', expected: '/skill:learn release flow' },
    {
      input: '/CINDY:LEARN hub:market:release-flow notes\nmore details',
      expected: '/skill:learn hub:market:release-flow notes\nmore details',
    },
  ])(
    'pins $input to the sole same-path Pi runtime winner',
    ({ input, expected }) => {
      const skillFile = path.resolve('system-skills', 'v10', 'learn', 'SKILL.md');
      const manifest = {
        capturedAt: '2026-09-19T00:00:00.000Z',
        generation: 1,
        status: 'loaded' as const,
        source: 'pi:get_commands' as const,
        commands: [{
          name: 'skill:learn',
          source: 'skill',
          sourceInfo: { path: skillFile, baseDir: path.dirname(skillFile) },
        }],
      };

      expect(preparePinnedPiSkillInvocation(
        input,
        { name: 'learn', path: skillFile },
        manifest,
      )).toBe(expected);
    },
  );

  it.each(['/learn release flow', '/cindy:learn release flow'])(
    'rejects a colliding or ambiguous Pi runtime winner for %s',
    (input) => {
      const pinnedPath = path.resolve('system-skills', 'v10', 'learn', 'SKILL.md');
      const customPath = path.resolve('project', '.agents', 'skills', 'learn', 'SKILL.md');
      const command = (skillFile: string) => ({
        name: 'skill:learn',
        source: 'skill',
        sourceInfo: { path: skillFile, baseDir: path.dirname(skillFile) },
      });
      const manifest = {
        capturedAt: '2026-09-19T00:00:00.000Z',
        generation: 1,
        status: 'loaded' as const,
        source: 'pi:get_commands' as const,
        commands: [command(pinnedPath), command(customPath)],
      };

      expect(() => preparePinnedPiSkillInvocation(
        input,
        { name: 'learn', path: pinnedPath },
        manifest,
      )).toThrow('does not match the Pi runtime winner');
      expect(() => preparePinnedPiSkillInvocation(
        input,
        { name: 'learn', path: pinnedPath },
        { ...manifest, commands: [command(customPath)] },
      )).toThrow('does not match the Pi runtime winner');
    },
  );

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

  it('authorizes project prompt and extension commands from explicit launch paths', () => {
    const promptFile = '/repo/.pi/prompts/review.md';
    const extensionFile = '/repo/.pi/extensions/hook.ts';
    expect(identifyManagedPiPackageCommandNames([
      {
        ...command,
        name: 'review',
        source: 'prompt',
        sourceInfo: { path: promptFile, source: 'prompt' },
      },
      {
        ...command,
        name: 'hook-cmd',
        source: 'extension',
        sourceInfo: { path: extensionFile, source: 'extension' },
      },
      {
        ...command,
        name: 'plan',
        source: 'extension',
        sourceInfo: { path: '/cindy/internal/plan-mode.ts', source: 'extension' },
      },
    ], [promptFile, extensionFile]).sort()).toEqual(['hook-cmd', 'review']);
  });

  it('authorizes a colliding name when every catalog entry is in package or project roots', () => {
    expect(identifyManagedPiPackageCommandNames([
      {
        ...command,
        name: 'foo',
        source: 'extension',
        sourceInfo: { path: '/private/cindy/pi-packages/sample/index.ts' },
      },
      {
        ...command,
        name: 'foo',
        source: 'prompt',
        sourceInfo: { path: '/repo/.pi/prompts/foo.md' },
      },
    ], ['/private/cindy/pi-packages/sample', '/repo/.pi/prompts/foo.md'])).toEqual(['foo']);
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

describe('capturePiRuntimeCapabilitiesWithRetry', () => {
  // 2026-11-09 实报:bridge MCP 初始化在扩展加载期占用 ready 窗口(每 server
  // startup 预算默认 10s),单次采集的 5s 请求预算必超 —— 一次性采集产出
  // status='unknown' 后无重试、无日志,新任务预热的项目 Skill 永远灰。
  const command = {
    name: 'skill:fixture',
    description: 'fixture skill',
    source: 'skill',
    sourceInfo: { source: 'auto', scope: 'project', baseDir: '/proj', path: '/proj/.pi/skills/fixture' },
  };
  const loadedResponse: PiRpcResponse = {
    type: 'response',
    id: '1',
    command: 'get_commands',
    success: true,
    data: { commands: [command] },
  };
  const timeoutError = new Error('pi rpc timeout after 5000ms: get_commands');

  function deferredRequester(failTimes: number) {
    const requests: Array<Promise<unknown>> = [];
    let calls = 0;
    return {
      get callCount() { return calls; },
      request: async () => {
        calls += 1;
        const promise = calls <= failTimes
          ? Promise.reject(timeoutError)
          : Promise.resolve(loadedResponse);
        requests.push(promise);
        return promise;
      },
    };
  }

  const instantSleep = async () => undefined;

  it('retries a timed-out capture until the runtime catalog answers (bridge startup budget > capture budget)', async () => {
    const requester = deferredRequester(1);
    const sleeps: number[] = [];
    const failures: Array<{ status: string; attempt: number; isFinal: boolean }> = [];
    const manifest = await capturePiRuntimeCapabilitiesWithRetry(
      requester,
      { sessionId: 's1' },
      1,
      'ready',
      {
        retryDelaysMs: [4_000, 10_000, 20_000],
        sleep: async (delayMs) => { sleeps.push(delayMs); },
        onAttemptFailed: (failed, attempt, isFinal) => failures.push({ status: failed.status, attempt, isFinal }),
      },
    );
    expect(manifest.status).toBe('loaded');
    expect(manifest.commands).toHaveLength(1);
    expect(requester.callCount).toBe(2);
    expect(sleeps).toEqual([4_000]);
    expect(failures).toEqual([{ status: 'unknown', attempt: 1, isFinal: false }]);
  });

  it('gives up after the bounded retries and keeps the last failed manifest', async () => {
    let requests = 0;
    const probe = {
      get callCount() { return requests; },
      request: async () => { requests += 1; throw timeoutError; },
    };
    const failures: Array<{ attempt: number; isFinal: boolean }> = [];
    const manifest = await capturePiRuntimeCapabilitiesWithRetry(
      probe as Parameters<typeof capturePiRuntimeCapabilityManifest>[0],
      { sessionId: 's1' },
      1,
      'ready',
      {
        retryDelaysMs: [4_000, 10_000],
        sleep: instantSleep,
        onAttemptFailed: (_failed, attempt, isFinal) => failures.push({ attempt, isFinal }),
      },
    );
    expect(manifest.status).toBe('unknown');
    expect(manifest.error?.code).toBe('timeout');
    expect(requests).toBe(3);
    // 每次(含末次)失败都上报;只有末次(不会再有下一采)标 final。
    expect(failures).toEqual([
      { attempt: 1, isFinal: false },
      { attempt: 2, isFinal: false },
      { attempt: 3, isFinal: true },
    ]);
  });

  it('stops retrying once the session is closed or a newer generation superseded the refresh', async () => {
    const requester = deferredRequester(Number.POSITIVE_INFINITY);
    let current = true;
    const manifest = await capturePiRuntimeCapabilitiesWithRetry(
      requester,
      { sessionId: 's1' },
      1,
      'ready',
      {
        sleep: instantSleep,
        isCurrent: () => current,
        // 首次失败即关闭会话/被新代接替:重试必须立刻中止。
        onAttemptFailed: () => { current = false; },
      },
    );
    expect(manifest.status).toBe('unknown');
    expect(requester.callCount).toBe(1);
  });

  it('does not sleep when the first capture already reports loaded', async () => {
    const requester = deferredRequester(0);
    const sleeps: number[] = [];
    const manifest = await capturePiRuntimeCapabilitiesWithRetry(
      requester,
      { sessionId: 's1' },
      1,
      'ready',
      { retryDelaysMs: [4_000], sleep: async (delayMs) => { sleeps.push(delayMs); } },
    );
    expect(manifest.status).toBe('loaded');
    expect(requester.callCount).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
