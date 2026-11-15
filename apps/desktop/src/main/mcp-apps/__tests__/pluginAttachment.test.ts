import { expect, it, vi } from 'vitest';
import { callPluginAttachmentProvider, callPluginAttachmentTool, preparePluginAttachmentResult } from '../pluginAttachment';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GhostHandoffStore } from '../../cindy-brain/handoffStore';
import { GhostCardService } from '../../cindy-brain/cardService';
import { GhostNetworkSlot } from '../../cindy-brain/networkSlot';
import type { InstalledGhost } from '../../../shared/ghost';
import { createBlobStore } from '../../cindy-media/blobStore';

// Unit regression #10649: previous native-input tests stopped at the dispatcher.
// A task-bound attachment call must retain declared networking/card correlation,
// but must not inherit the Agent-only route to undeclared network destinations.
it('keeps native attachment calls within declared network hosts and finalizes them', async () => {
  const cards = new GhostCardService({ hasCardSlot: () => true, sanitize: html => ({ ok: true, html }),
    persist: async () => {}, broadcast: () => {} });
  const fetch = vi.fn(async () => new Response('ok'));
  const agentFetch = vi.fn(async () => ({ response: new Response('ok'), release: async () => {} }));
  let network: { hosts: string[]; secrets: [] } | undefined = { hosts: ['declared.example'], secrets: [] };
  const slot = new GhostNetworkSlot({
    getGhost: () => ({ enabled: true, manifest: { network } }) as InstalledGhost,
    inFlightCallInfo: callId => cards.inFlightCallInfoOf(callId),
    readSecret: () => null, getLoginEmail: () => null, fetchImpl: fetch, fetchPublicImpl: agentFetch,
    readGhostMedia: async () => null, takeDirDeposit: () => null, writeSaveDeposit: async () => null,
    saveGhostMedia: async () => { throw new Error('unexpected media save'); }, isSupportedMediaMime: () => false,
  });
  let activeCallId = '';
  await callPluginAttachmentTool({ instance: 'local__parse', sessionId: 'task', tool: 'parse' }, { cards,
    call: async callId => {
      activeCallId = callId;
      expect(cards.inFlightCallInfoOf(callId)).toMatchObject({ ghostId: 'local__parse', sessionId: 'task', tool: 'parse' });
      expect(await slot.handleFetchRequest('local__parse', { callId, url: 'https://declared.example/data' })).toMatchObject({ ok: true });
      expect(await slot.handleFetchRequest('local__parse', { callId, url: 'https://undeclared.example/data' })).toMatchObject({ ok: false });
      network = undefined;
      expect(await slot.handleFetchRequest('local__parse', { callId, url: 'https://undeclared.example/data' })).toMatchObject({ ok: false });
      return { content: [] };
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(agentFetch).not.toHaveBeenCalled();
  expect(cards.inFlightCallInfoOf(activeCallId)).toBeNull();
  await expect(callPluginAttachmentTool({ instance: 'local__parse', sessionId: 'task', tool: 'parse' }, { cards,
    call: async callId => { activeCallId = callId; throw new Error('provider failed'); },
  })).rejects.toThrow('provider failed');
  expect(cards.inFlightCallInfoOf(activeCallId)).toBeNull();
});

// #9987 regression, unit: the native producer's real bytes enter the existing
// instance store/media deposit without Agent policy, a media birth query or grant.
// Previously the real paste cache was rejected before reaching the provider.
it.each(['disk-file', 'disk-image', 'cached-paste', 'bad-size', 'invalid-media', 'cancel', 'revoke', 'provider-error',
  'cancel-media', 'revoke-media', 'provider-error-media'] as const)(
  'transfers native attachment bytes directly: %s', async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-native-input-'));
  const handoff = new GhostHandoffStore({ root: () => path.join(root, 'handoff') });
  const media = mode !== 'invalid-media' && (mode === 'disk-image' || mode === 'cached-paste' || mode.endsWith('-media'));
  const bytes = media
    ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64')
    : Buffer.from('native input');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const source = path.join(root, mode === 'cached-paste' ? `${hash}.png` : media ? 'picked.png' : 'picked.txt');
  const controller = new AbortController();
  let current = true;
  const assertStillValid = () => { controller.signal.throwIfAborted(); if (!current) throw new Error('source changed'); };
  const depositCleanup = vi.fn(async () => {});
  const deposit = vi.fn(async () => ({ hash, cleanup: depositCleanup }));
  const call = vi.fn(async (args: Record<string, unknown>) => {
    if (mode.startsWith('cancel')) controller.abort();
    if (mode.startsWith('revoke')) current = false;
    if (mode.startsWith('provider-error')) return { isError: true, content: [] };
    if (media) {
      expect(args.attachments).toEqual([hash]);
      expect(args).not.toHaveProperty('cindy_handoff_files');
    } else {
      const [file] = args.cindy_handoff_files as { ref: string; size: number }[];
      expect(file!.size).toBe(bytes.length);
      expect(await handoff.read('local__parse', file!.ref)).toMatchObject({ bytes });
      expect(await handoff.read('other__parse', file!.ref)).toBeNull();
      expect(args.attachments).toEqual(['declared-media']);
    }
    expect(JSON.stringify(args)).not.toContain(root);
    return { content: [] };
  });
  try {
    await fs.writeFile(source, bytes);
    const pending = callPluginAttachmentProvider({ instance: 'local__parse', paths: [source], handoffDeclared: !media,
      args: { attachments: ['declared-media'], cindy_handoff_files: ['forged'], attachment: {
        name: media ? 'clipboard.png' : 'picked.txt', size: bytes.length + (mode === 'bad-size' ? 1 : 0),
        mimeType: media || mode === 'invalid-media' ? 'image/png' : 'text/plain',
      } },
    }, { signal: controller.signal, assertStillValid, assertCurrent: async () => assertStillValid(), handoff,
      supportsMedia: createBlobStore({ getUserDataDir: () => root }).supportedMime, deposit, call });
    if (mode === 'bad-size' || mode === 'invalid-media' || mode.startsWith('cancel') || mode.startsWith('revoke')) await expect(pending).rejects.toThrow();
    else await expect(pending).resolves.toMatchObject({ content: [] });
    expect(await fs.readFile(source)).toEqual(bytes);
    if (mode === 'bad-size' || mode === 'invalid-media') expect(call).not.toHaveBeenCalled();
    if (media) {
      expect(deposit).toHaveBeenCalledExactlyOnceWith(bytes, 'image/png');
      expect(depositCleanup).toHaveBeenCalledTimes(mode.endsWith('-media') ? 1 : 0);
    }
    else {
      expect(deposit).not.toHaveBeenCalled();
      expect(await handoff.list('local__parse')).toHaveLength(mode === 'disk-file' ? 1 : 0);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// Unit regression #10649: unsupported media containers remain opaque files,
// as in the original handoff route. Only supported media need media validation.
it.each([
  ['track.flac', 'audio/flac'], ['movie.mkv', 'video/x-matroska'], ['movie.avi', 'video/x-msvideo'],
])('hands media-store unsupported %s bytes to the declared file provider', async (name, mimeType) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-container-'));
  const handoff = new GhostHandoffStore({ root: () => path.join(root, 'handoff') });
  const source = path.join(root, name!);
  const bytes = Buffer.from('opaque container bytes');
  try {
    await fs.writeFile(source, bytes);
    const call = vi.fn(async (args: Record<string, unknown>) => {
      const [file] = args.cindy_handoff_files as { ref: string }[];
      expect(await handoff.read('local__parse', file!.ref)).toMatchObject({ bytes });
      return { content: [] };
    });
    await callPluginAttachmentProvider({ instance: 'local__parse', paths: [source], handoffDeclared: true,
      args: { attachment: { name, mimeType, size: bytes.length } },
    }, { signal: new AbortController().signal, assertCurrent: async () => {}, assertStillValid() {}, handoff,
      supportsMedia: createBlobStore({ getUserDataDir: () => root }).supportedMime,
      deposit: async () => { throw new Error('unsupported media must use file handoff'); }, call });
    expect(call).toHaveBeenCalledOnce();
    expect(await fs.readFile(source)).toEqual(bytes);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// Unit: production result adapter + real Response streams, memory-only storage.
// Existing file-grant tests sign View URLs, but do not import composer results.
// Minimal failure: an arbitrary returned path, or a delayed response after revoke.
it('preserves pass results and imports only owned links using host metadata', async () => {
  const stage = vi.fn(async () => ({ path: '/cache/converted.txt.bin' }));
  const access = { describe: vi.fn(async (_instance: string, uri: string) => uri === 'handoff:own'
    ? { size: 5, mimeType: 'text/plain' } : null), read: vi.fn(async () => new Response('hello')) };
  const ports = { access, stage, cleanup: vi.fn(), assertCurrent: async () => {}, signal: new AbortController().signal };
  expect(await preparePluginAttachmentResult('example', { structuredContent: { handled: false } }, ports)).toEqual({ handled: false });
  expect(stage).not.toHaveBeenCalled();
  const output = await preparePluginAttachmentResult('example', { structuredContent: { handled: true, text: 'Extracted', files: [
    { type: 'resource_link', uri: 'handoff:own', name: 'converted.txt', size: 999, mimeType: 'image/png' },
  ] } }, ports);
  expect(output).toEqual({ handled: true, text: 'Extracted', files: [{ name: 'converted.txt', path: '/cache/converted.txt.bin', size: 5, mimeType: 'text/plain' }] });
  expect(stage).toHaveBeenCalledWith('converted.txt', Buffer.from('hello'), 'text/plain');
  for (const uri of ['/etc/private', 'https://example.invalid/data', 'library:other']) {
    await expect(preparePluginAttachmentResult('example', { structuredContent: { handled: true,
      files: [{ type: 'resource_link', uri, name: 'file.txt' }] } }, ports)).rejects.toThrow();
  }
});

it('does not stage a result after the source is revoked while reading', async () => {
  let current = true;
  const stage = vi.fn();
  const access = { describe: async () => ({ size: 1, mimeType: 'text/plain' }),
    read: async () => { current = false; return new Response('x'); } };
  await expect(preparePluginAttachmentResult('example', { structuredContent: { handled: true,
    files: [{ type: 'resource_link', uri: 'library:one.txt', name: 'one.txt' }] } }, {
    access, stage, cleanup: vi.fn(), assertCurrent: async () => { if (!current) throw new Error('revoked'); },
    signal: new AbortController().signal,
  })).rejects.toThrow('revoked');
  expect(stage).not.toHaveBeenCalled();
});
