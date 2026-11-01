import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrationNativeContext } from '../migrationNativeContext';
import { writeMigratedTranscript } from '../migrationTranscriptWriter';

const original = '12345678-1234-4234-a234-123456789012';
let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-transcript-writer-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Deliver `bytes` in fixed-size chunks so lines and characters straddle chunk boundaries. */
const chunked = (bytes: Buffer, size: number) =>
  Readable.from(
    (function* () {
      for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
    })(),
  );

const ccRow = JSON.stringify({ sessionId: original, uuid: 'u', message: { content: '雪 ☃ 😀' } });
const codexMeta = JSON.stringify({ type: 'session_meta', payload: { id: original, cwd: '/源' } });
const samples: Record<string, string> = {
  empty: '',
  'no trailing newline': `${ccRow}\n${codexMeta}`,
  crlf: `${ccRow}\r\n${codexMeta}\r\n`,
  'blank and malformed': `\n   \n{partial\nnull\n[1]\n${ccRow}\n\n`,
  bom: `﻿${ccRow}\n${codexMeta}\n`,
  'multi-byte without ids': '雪 ☃ 😀 ü\n'.repeat(5),
  'id only in content': `${JSON.stringify({ type: 'event', payload: { content: original } })}\n`,
};

describe('writeMigratedTranscript', () => {
  it.each([1, 7, 65536])('relocates only the Pi header across %i-byte chunks', async (size) => {
    const header = { type: 'session', version: 3, id: original, timestamp: '2026-10-28T00:00:00Z', cwd: '/source-only/project' };
    const tail = '\n' + JSON.stringify({ type: 'message', id: 'entry', parentId: null,
      message: { role: 'toolResult', content: [{ type: 'text', text: '雪 ☃ full tool output\n'.repeat(5000) }] } })
      + '\n{"type":"compaction","id":"compact","parentId":"entry","firstKeptEntryId":"entry","summary":"kept"}\n';
    const target = path.join(dir, 'pi.jsonl');
    await writeMigratedTranscript(chunked(Buffer.from(JSON.stringify(header) + tail), size), target,
      { agent: 'pi', sessionId: 'new-native-id', cwd: '/target/project' });
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify({ ...header, id: 'new-native-id', cwd: '/target/project' }) + tail);
  });

  it('retags only the Codex session header provider and keeps history bytes', async () => {
    const header = { type: 'session_meta', payload: { id: 't1', model_provider: 'openai', cwd: '/x' } };
    const tail = '\n{"type":"response_item","payload":{"type":"message","model_provider":"openai"}}\n';
    const target = path.join(dir, 'codex.jsonl');
    await writeMigratedTranscript(chunked(Buffer.from(JSON.stringify(header) + tail), 5), target,
      { agent: 'codex-provider', modelProvider: 'cindy_gateway' });
    expect(fs.readFileSync(target, 'utf8')).toBe(
      JSON.stringify({ ...header, payload: { ...header.payload, model_provider: 'cindy_gateway' } }) + tail);
  });

  for (const [name, text] of Object.entries(samples)) {
    it.each([
      ['cc', 1],
      ['cc', 3],
      ['codex', 7],
      ['codex', 1],
    ] as const)(`matches transcript() for ${name} (%s, %i-byte chunks)`, async (agent, size) => {
      const context = migrationNativeContext('migration', [original]);
      const bytes = Buffer.from(text);
      const target = path.join(dir, 'copy.jsonl');
      await writeMigratedTranscript(chunked(bytes, size), target, { context, agent });
      expect(fs.readFileSync(target).equals(context.transcript(bytes, agent))).toBe(true);
    });
  }

  it('keeps bytes of lines it does not rewrite, even when they are not valid UTF-8', async () => {
    const context = migrationNativeContext('migration', [original]);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x41, 0x0a]), Buffer.from(ccRow)]);
    const target = path.join(dir, 'copy.jsonl');
    await writeMigratedTranscript(chunked(bytes, 2), target, { context, agent: 'cc' });
    const written = fs.readFileSync(target);
    expect(written.subarray(0, 4).equals(bytes.subarray(0, 4))).toBe(true);
    expect(JSON.parse(written.subarray(4).toString()).sessionId).toBe(context.id(original));
  });

  it('copies bytes unchanged without a rewrite and replaces a leftover target', async () => {
    const target = path.join(dir, 'nested', 'copy.jsonl');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'interrupted attempt');
    const bytes = Buffer.from(`${ccRow}\n`);
    await writeMigratedTranscript(chunked(bytes, 5), target, null);
    expect(fs.readFileSync(target).equals(bytes)).toBe(true);
  });

  it('leaves neither a target nor a temp file when the source fails', async () => {
    const target = path.join(dir, 'copy.jsonl');
    const failing = new Readable({
      read() {
        this.push(Buffer.from(ccRow));
        this.destroy(new Error('source lost'));
      },
    });
    await expect(writeMigratedTranscript(failing, target, null)).rejects.toThrow('source lost');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not publish when the import is no longer current', async () => {
    const target = path.join(dir, 'copy.jsonl');
    await expect(
      writeMigratedTranscript(chunked(Buffer.from(ccRow), 4), target, null, () => {
        throw new Error('MIGRATION_OWNER_CHANGED');
      }),
    ).rejects.toThrow('MIGRATION_OWNER_CHANGED');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('withdraws the published file when the import stops being current during the rename', async () => {
    const target = path.join(dir, 'copy.jsonl');
    let checks = 0;
    await expect(
      writeMigratedTranscript(chunked(Buffer.from(ccRow), 4), target, null, () => {
        checks += 1;
        if (checks > 1) throw new Error('MIGRATION_OWNER_CHANGED');
      }),
    ).rejects.toThrow('MIGRATION_OWNER_CHANGED');
    expect(checks).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
