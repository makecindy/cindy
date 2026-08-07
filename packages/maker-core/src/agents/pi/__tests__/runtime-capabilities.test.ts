import { describe, expect, it, vi } from 'vitest';

import {
  capturePiRuntimeCapabilityManifest,
  parsePiRuntimeCommands,
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

  it.each([
    ['missing commands', {}],
    ['duplicate names', { commands: [command, command] }],
    ['missing sourceInfo', { commands: [{ ...command, sourceInfo: undefined }] }],
    ['unknown command field', { commands: [{ ...command, extra: 'secret' }] }],
    ['unknown sourceInfo field', { commands: [{ ...command, sourceInfo: { ...command.sourceInfo, extra: 'secret' } }] }],
    ['unknown response field', { commands: [command], extra: 'secret' }],
    ['oversized payload', { commands: [{ ...command, description: 'x'.repeat(4_097) }] }],
  ])('rejects conservative malformed case: %s', (_name, data) => {
    expect(parsePiRuntimeCommands(data)).toEqual({ ok: false });
  });

  it('redacts rpc failures and classifies unsupported/timeout as unknown', async () => {
    const loggerSpy = vi.fn();
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
    expect(loggerSpy).not.toHaveBeenCalled();
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
  });
});
