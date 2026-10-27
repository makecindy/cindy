import { createHookMediaStore } from '../hookOutbox';
import { prepareChatReplyFiles } from '../../maker-ipc/chatServerReplyFiles';
import { mergeChatReplyAttachments } from '../../maker-ipc/chatServerReplyAttachments';
import { prepareChatReplyImages } from '../../maker-ipc/chatServerReplyImages';
import { createHookRequestLedger, HOOK_TERMINAL_DELIVERY_TTL_MS } from '../../hook-control/requestLedger';
import type { TurnEndPayload } from '@cindy/slack-hook-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../localDb/schema';
import type { DbClient } from '../../localDb/client/DbClient';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current';
import {
  claudeScratchpadPath,
  claudeScratchpadTempBase,
  materializeTaskImageText,
  materializeTaskImageTextResult,
  readTaskImage,
  restoreTaskImageRows,
  taskImageRoots,
} from '../taskImageDelivery';
import { resolveSafe } from '../blobStore';
import * as ledger from '../ledger';
import { commitMessageMediaRefs } from '../chatAttachments';
import { createHash } from 'node:crypto';
import { ingestMedia } from '../ingest';
import { reconcileMediaRefCompensationsForOwner } from '../refCompensationJournal';
import { materializeLocalMarkdownImages } from '../../im/shared/localMarkdownImages';
import { collectOutboundAttachments } from '../../hook-control/outbound';
import {
  materializeTaskImageMarkdown,
  rewriteTaskImageReferences,
  taskImageReferences,
} from '../taskImageMarkdown';

const state = vi.hoisted(() => ({
  root: '',
  valid: true,
  afterIngest: undefined as (() => void | Promise<void>) | undefined,
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../../appSessionState', () => ({
  activeOwnerScopeKey: () => (state.valid ? 'cloud:test-owner:1' : 'cloud:other-owner:2'),
  dataOwnerStorageKey: (id: string) => (id === 'test-owner' ? 'a' : 'b').repeat(20),
  getActiveAppSession: () => ({ dataOwnerId: state.valid ? 'test-owner' : 'other-owner' }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../ingest', async (original) => {
  const actual = await original<typeof import('../ingest')>();
  return {
    ...actual,
    ingestMedia: async (...args: Parameters<typeof actual.ingestMedia>) => {
      const result = await actual.ingestMedia(...args);
      await state.afterIngest?.();
      return result;
    },
  };
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42]);
const sdk = '11111111-1111-4111-8111-111111111111';
let raw: Database.Database;
let client: DbClient;
let work: string;
beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-image-'));
  work = path.join(state.root, 'work');
  await fs.mkdir(work);
  vi.stubEnv('CLAUDE_CODE_TMPDIR', path.join(state.root, 'tmp'));
  state.valid = true;
  state.afterIngest = undefined;
  raw = new Database(':memory:');
  raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, sdk_session_id TEXT,
    agent_kind TEXT, remote_host_id TEXT, status TEXT, cleared_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
    created_at INTEGER, rewind_at INTEGER);`);
  const mediaSql = await fs.readFile(
    path.resolve(__dirname, '../../../../drizzle/0070_woozy_harpoon.sql'),
    'utf8',
  );
  raw.exec(mediaSql);
  raw.exec('ALTER TABLE media_refs ADD COLUMN label TEXT');
  raw
    .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, ?, NULL)')
    .run('s', work, sdk, 'cc', 'active');
  client = { drizzle: drizzle(raw, { schema }) } as unknown as DbClient;
  setCurrentDbClient(client, 'test-owner');
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearCurrentDbClient();
  raw.close();
  vi.unstubAllEnvs();
  await fs.rm(state.root, { recursive: true, force: true });
});

function insert(text: string) {
  const row = {
    id: 'm',
    sessionId: 's',
    role: 'assistant' as const,
    content: JSON.stringify(text),
    createdAt: 10,
    rewindAt: null,
  };
  raw
    .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)')
    .run(row.id, row.sessionId, row.role, row.content, row.createdAt);
  return row;
}

describe('task image delivery', () => {
  // #6773: run both production preparation passes; a shared PDF definition
  // must not be interpreted as an image after the file has been extracted.
  it.each(['nested', 'sibling'].flatMap(mode => ['pdf', 'png'].map(ext => [mode, ext])))('delivers shared non-image references through both preparation passes (%s, .%s)', async (mode, ext) => {
    const pdf = path.join(work, `report.${ext}`);
    const bytes = Buffer.from('%PDF-1.4\nreport');
    await fs.writeFile(pdf, bytes);
    const label = mode === 'nested' ? '[![preview][report]][report]' : '[report][report] ![preview][report]';
    const files = await prepareChatReplyFiles(`${label}\n\n[report]: <${pdf}>`, 's', () => {});
    expect(files.attachments).toHaveLength(1);
    expect(await files.attachments[0]!.readBytes!()).toEqual(bytes);
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    expect(images.attachments).toEqual([]);
    expect(images.text).not.toContain(pdf);
    expect(images.text).not.toContain('![');
    expect(images.text).not.toContain('[report]');
  });

  it.each(['nested', 'sibling'])('keeps a real shared-reference image through both reply passes (%s)', async mode => {
    // Content, not the extension, decides whether this shared target is an image.
    const source = path.join(work, 'asset.bin');
    await fs.writeFile(source, PNG);
    const body = mode === 'nested' ? '[![preview][asset]][asset]' : '[download][asset] ![preview][asset]';
    const files = await prepareChatReplyFiles(`${body}\n\n[asset]: <${source}>`, 's', () => {});
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    const attachments = mergeChatReplyAttachments(images.attachments, files.attachments);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ category: 'image', mimeType: 'image/png', sourceOffset: 0 });
    expect(images.text).toContain('preview');
    expect(images.text).not.toContain('![');
    expect(images.text).not.toContain('[asset]');
    expect(images.text).not.toContain(source);
  });

  it.each(['inline', 'reference'])('reconciles accepted in-task symlink image/file targets (%s)', async mode => {
    const aliases: string[] = [];
    for (let i = 0; i < 11; i++) {
      const source = path.join(work, `source-${i}.png`), alias = path.join(work, `latest-${i}.png`);
      await fs.writeFile(source, Buffer.concat([PNG, Buffer.from([i])]));
      await fs.symlink(source, alias);
      aliases.push(alias);
    }
    const body = mode === 'inline'
      ? aliases.map(alias => `![preview](<${alias}>) [download](<${alias}>)`).join(' ')
      : aliases.map((alias, i) => `[download][a${i}] ![preview][a${i}]\n\n[a${i}]: <${alias}>\n`).join('\n');
    const files = await prepareChatReplyFiles(body, 's', () => {});
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    const attachments = mergeChatReplyAttachments(images.attachments, files.attachments);
    expect(attachments).toHaveLength(11);
    expect(attachments.every(a => a.category === 'image')).toBe(true);
    expect(images.text).not.toContain('![');
    expect(images.text).not.toContain(work);
  });

  it.each(['image-first', 'file-first'])('uploads eleven real images once through both reply passes, in source order (%s)', async order => {
    const pdf = path.join(work, 'report.pdf');
    await fs.writeFile(pdf, '%PDF-1.4');
    const targets = Array.from({ length: 11 }, (_, i) => path.join(work, `chart-${i}.png`));
    for (const [i, target] of targets.entries()) await fs.writeFile(target, Buffer.concat([PNG, Buffer.from([i])]));
    const image = (i: number) => `![preview](<${targets[i]}>)`;
    const file = (i: number) => `[download](<${targets[i]}>)`;
    // The first alias must retain its position relative to a distinct PDF.
    const body = `${order === 'image-first' ? image(0) : file(0)} [report](<${pdf}>) ${order === 'image-first' ? file(0) : image(0)} `
      + targets.slice(1).map((_, index) => `${image(index + 1)} ${file(index + 1)}`).join(' ');
    const files = await prepareChatReplyFiles(body, 's', () => {});
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    const attachments = mergeChatReplyAttachments(images.attachments, files.attachments);
    expect(attachments).toHaveLength(12);
    expect(attachments.map(a => a.category)).toEqual(['image', 'file', ...Array(10).fill('image')]);
    expect(attachments[0]!.sourcePaths).toContain(await fs.realpath(targets[0]!));
    expect(images.text).not.toContain(work);
    expect((await attachments[1]!.readBytes!()).toString()).toBe('%PDF-1.4');
  });

  it.each([2, 21])('reconciles %s local image paths before the combined attachment limit', async count => {
    const sources = Array.from({ length: count }, (_, i) => path.join(work, `same-${i}.png`));
    for (const source of sources) await fs.writeFile(source, PNG);
    const files = await prepareChatReplyFiles(sources.map(source => `[download](<${source}>) ![preview](<${source}>)`).join(' '), 's', () => {});
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    const attachments = mergeChatReplyAttachments(images.attachments, files.attachments);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ category: 'image', sourceOffset: 0 });
    expect(attachments[0]!.sourcePaths).toEqual(await Promise.all(sources.map(source => fs.realpath(source))));
  });

  it.each([false, true])('rejects 21 non-image files even with rendered images (shared references: %s)', async shared => {
    const image = path.join(work, 'preview.png');
    await fs.writeFile(image, PNG);
    const sources = Array.from({ length: 21 }, (_, i) => path.join(work, `report-${i}.pdf`));
    for (const source of sources) await fs.writeFile(source, '%PDF-1.4');
    const body = shared
      ? sources.map((source, i) => `[file][r${i}] ![preview][r${i}]\n\n[r${i}]: <${source}>\n`).join('\n')
      : `![preview](<${image}>) ` + sources.map(source => `[file](<${source}>)`).join(' ');
    await expect((async () => {
      const files = await prepareChatReplyFiles(body, 's', () => {});
      return prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    })()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it.each(['direct', 'symlink'])('retains file read safeguards for hard-linked image/download targets (%s)', async mode => {
    const source = path.join(work, 'linked.png');
    await fs.writeFile(source, PNG);
    await fs.link(source, path.join(state.root, 'outside.png'));
    const alias = mode === 'symlink' ? path.join(work, 'latest.png') : source;
    if (mode === 'symlink') await fs.symlink(source, alias);
    const files = await prepareChatReplyFiles(`![preview](<${alias}>) [download](<${alias}>)`, 's', () => {});
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    const attachments = mergeChatReplyAttachments(images.attachments, files.attachments);
    expect(attachments.map(a => a.category)).toEqual(['image', 'file']);
    await expect(attachments[1]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('retains file containment when an image symlink points into the image-only scratchpad root', async () => {
    const scratch = claudeScratchpadPath({ workingDir: work, sdkSessionId: sdk, agentKind: 'cc' })!;
    await fs.mkdir(scratch, { recursive: true });
    const source = path.join(scratch, 'scratch.png'), alias = path.join(work, 'latest.png');
    await fs.writeFile(source, PNG);
    await fs.symlink(source, alias);
    const files = await prepareChatReplyFiles(`![preview](<${alias}>) [download](<${alias}>)`, 's', () => {});
    const images = await prepareChatReplyImages(files.text, 's', () => {}, files.attachments);
    const attachments = mergeChatReplyAttachments(images.attachments, files.attachments);
    // Image policy already permits this scratchpad; explicit files remain workdir-only.
    expect(attachments.map(a => a.category)).toEqual(['image', 'file']);
    await expect(attachments[1]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it.each(['before', 'during'].flatMap((order) =>
    ['publish', 'rollback'].map((result) => [order, result]),
  ))('reconciles a reused reference when cleanup runs %s %s', async (order, result) => {
    const source = path.join(work, 'reused.png');
    await fs.writeFile(source, PNG);
    const saved = await ingestMedia({ buffer: PNG, mimeType: 'image/png', refs: [
      { refKind: 'session-attachment', refId: 's', originSessionId: 's', originKind: 'user' },
    ] }, client.drizzle);
    const hash = createHash('sha256').update(PNG).digest('hex');
    raw.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)')
      .run('old', 's', 'user', JSON.stringify(saved.url), 1);
    const row = insert(`![shared](${source})`);
    const cleanup = () => {
      raw.exec("UPDATE messages SET rewind_at = 20 WHERE id = 'old'");
      return ledger.removeSessionAttachmentRefIfUnreferencedByLiveMessage({ sessionId: 's', hash }, client.drizzle);
    };
    let pendingCleanup: Promise<number> | undefined;
    if (order === 'before') await cleanup();
    state.afterIngest = async () => {
      if (order === 'during') pendingCleanup = cleanup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (result === 'rollback') raw.exec("UPDATE messages SET content = 'edited' WHERE id = 'm'");
    };
    await restoreTaskImageRows(client, [row]);
    await pendingCleanup;
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get())
      .toEqual({ n: result === 'publish' ? 1 : 0 });
    if (result === 'publish') {
      expect(raw.prepare("SELECT content FROM messages WHERE id = 'm'").get())
        .toEqual({ content: JSON.stringify(`![shared](${saved.url})`) });
      await fs.rm(source);
      expect(await fs.readFile(resolveSafe(saved.url).absPath)).toEqual(PNG);
    }
  });

  it.each(['chat', 'channel'].flatMap((target) =>
    ['publish', 'rollback'].map((result) => [target, result]),
  ))('preserves a concurrent message reference after %s %s', async (target, result) => {
    const source = path.join(work, 'shared.png');
    await fs.writeFile(source, PNG);
    const text = `![shared](${source})`;
    const row = insert(text);
    const url = `cindy-media://blobs/${createHash('sha256').update(PNG).digest('hex')}.png`;
    let otherCommit: ReturnType<typeof commitMessageMediaRefs> | undefined;
    state.afterIngest = async () => {
      raw.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)')
        .run('other', 's', 'user', JSON.stringify(url), 11);
      // The ordinary message publishes while the task import still owns a provisional pin.
      otherCommit = commitMessageMediaRefs({ sessionId: 's', role: 'user', content: url }, client.drizzle);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (result === 'rollback') {
        if (target === 'chat') raw.exec("UPDATE messages SET content = 'edited' WHERE id = 'm'");
        else raw.exec("UPDATE sessions SET sdk_session_id = 'changed'");
      }
    };
    if (target === 'chat') await restoreTaskImageRows(client, [row]);
    else await materializeTaskImageText('s', text);
    await otherCommit;
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
    await fs.rm(source);
    expect(await fs.readFile(resolveSafe(url).absPath)).toEqual(PNG);
  });

  it.each(['deleted', 'replaced'])('reuses an imported snapshot after the source is %s', async (change) => {
    const source = path.join(work, 'snapshot.png');
    await fs.writeFile(source, PNG);
    const publicText = `![shot](${source})`;
    state.afterIngest = async () => {
      if (change === 'deleted') await fs.rm(source);
      else await fs.writeFile(source, Buffer.concat([PNG, Buffer.from([2])]));
    };
    const result = await materializeTaskImageTextResult('s', `过程。\n\n${publicText}`);
    const projected = rewriteTaskImageReferences(publicText, result.replacements);
    const collected = await collectOutboundAttachments(projected, [], {
      refScanText: result.text, resolveImageUrl: resolveSafe, allowedFileRoots: [work], log: { warn() {} },
    });
    expect(collected.text).toBe('🖼️ _shot_');
    expect(collected.attachments).toHaveLength(1);
    expect(collected.attachments[0].dataBase64).toBe(PNG.toString('base64'));
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
  });

  it.each([true, false])('handles an interrupted import state (source remains=%s)', async (sourceRemains) => {
    const source = path.join(work, 'interrupted.png');
    await fs.writeFile(source, PNG);
    const row = insert(`![interrupted](${source})`);
    // Seed the durable state after ingest succeeds but before message publication.
    const saved = await ingestMedia({ buffer: PNG, mimeType: 'image/png', refs: [
      { refKind: 'session-attachment', refId: 's', originSessionId: 's', originKind: 'tool' },
    ] }, client.drizzle);
    if (!sourceRemains) await fs.rm(source);
    await reconcileMediaRefCompensationsForOwner({
      ownerId: 'test-owner', db: client.drizzle, isOwnerCurrent: () => true,
    });
    const [restored] = await restoreTaskImageRows(client, [row]);
    expect(restored.content).toBe(sourceRemains ? JSON.stringify(`![interrupted](${saved.url})`) : row.content);
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
    expect(await fs.readFile(resolveSafe(saved.url).absPath)).toEqual(PNG);
    raw.exec("UPDATE sessions SET status = 'deleted'");
    expect(await ledger.removeSessionRefsIfDeleted('s', client.drizzle)).toBe(1);
  });

  it('preserves the image when the message commit succeeds but its worker ACK is lost', async () => {
    const source = path.join(work, 'committed.png');
    await fs.writeFile(source, PNG);
    const row = insert(`![committed](${source})`);
    vi.spyOn(client.drizzle, 'update').mockImplementation(
      () =>
        ({
          set: ({ content }: { content: string }) => ({
            where: () => ({
              returning: async () => {
                raw.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, row.id);
                throw new Error('worker acknowledgement lost');
              },
            }),
          }),
        }) as unknown as ReturnType<typeof client.drizzle.update>,
    );
    expect(await restoreTaskImageRows(client, [row])).toEqual([row]);
    const persisted = raw.prepare('SELECT content FROM messages').get() as { content: string };
    const url = taskImageReferences(JSON.parse(persisted.content))[0].url;
    expect(url).toMatch(/^cindy-media:/);
    await fs.rm(source);
    await reconcileMediaRefCompensationsForOwner({
      ownerId: 'test-owner',
      db: client.drizzle,
      isOwnerCurrent: () => true,
    });
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
    expect(await fs.readFile(resolveSafe(url).absPath)).toEqual(PNG);
  });

  it('keeps published references when the owner changes after the message update', async () => {
    const source = path.join(work, 'published.png');
    await fs.writeFile(source, PNG);
    const row = insert(`![published](${source})`);
    raw.function('switch_owner', () => {
      state.valid = false;
      return 0;
    });
    raw.exec(
      'CREATE TRIGGER switch_owner_after_publish AFTER UPDATE OF content ON messages BEGIN SELECT switch_owner(); END',
    );
    // The old caller gets its original row, but the committed message and pin survive.
    expect(await restoreTaskImageRows(client, [row])).toEqual([row]);
    expect(raw.prepare('SELECT content FROM messages').get()).toEqual({
      content: expect.stringContaining('cindy-media://'),
    });
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
    state.valid = true;
    const result = await reconcileMediaRefCompensationsForOwner({
      ownerId: 'test-owner',
      db: client.drizzle,
      isOwnerCurrent: () => true,
    });
    expect(result.recoveredPending).toBe(0);
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
  });

  it('uses the platform temp directory on Windows and the CLI /tmp convention on Unix', () => {
    vi.stubEnv('CLAUDE_CODE_TMPDIR', '');
    const temp = path.join(state.root, 'system-temp');
    vi.spyOn(os, 'tmpdir').mockReturnValue(temp);
    expect(claudeScratchpadTempBase('win32')).toBe(temp);
    expect(claudeScratchpadTempBase('darwin')).toBe('/tmp');
    expect(claudeScratchpadTempBase('linux')).toBe('/tmp');
    const override = path.join(state.root, 'cli-temp');
    vi.stubEnv('CLAUDE_CODE_TMPDIR', override);
    expect(claudeScratchpadTempBase('win32')).toBe(override);
    expect(claudeScratchpadTempBase('darwin')).toBe(override);
  });

  it.each(['chat', 'channel'])(
    'journals %s rollback when the old owner DB is unavailable',
    async (target) => {
      const prior = path.join(work, 'prior.png');
      await fs.writeFile(prior, PNG);
      await materializeTaskImageText('s', `![prior](${prior})`);
      const priorRefs = raw.prepare('SELECT id FROM media_refs').all();
      const source = path.join(work, 'new.png');
      await fs.writeFile(source, Buffer.concat([PNG, Buffer.from([1])]));
      const text = `![new](${source})`;
      const row = insert(text);
      const remove = vi
        .spyOn(ledger, 'removeRefById')
        .mockRejectedValue(new Error('old worker disposed'));
      state.afterIngest = () => {
        state.valid = false;
      };
      if (target === 'chat') expect(await restoreTaskImageRows(client, [row])).toEqual([row]);
      else expect(await materializeTaskImageText('s', text)).toBe(text);
      expect(raw.prepare('SELECT content FROM messages').get()).toEqual({ content: row.content });
      const journalDir = path.join(
        state.root,
        'owners',
        'a'.repeat(20),
        'cindy-media',
        'ref-compensation-v1',
      );
      const pending = (await fs.readdir(journalDir)).filter((name) =>
        name.endsWith('.pending.json'),
      );
      expect(pending).toHaveLength(1);
      const record = JSON.parse(await fs.readFile(path.join(journalDir, pending[0]), 'utf8'));
      expect(record.refIds).toHaveLength(1);
      expect(record.refIds).not.toContain((priorRefs[0] as { id: string }).id);
      expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 2 });
      for (const call of remove.mock.calls) expect(call[1]).toBe(client.drizzle);
      await expect(fs.stat(path.join(state.root, 'owners', 'b'.repeat(20)))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      remove.mockRestore();
      state.valid = true;
      const result = await reconcileMediaRefCompensationsForOwner({
        ownerId: 'test-owner',
        db: client.drizzle,
        isOwnerCurrent: () => true,
      });
      expect(result.recoveredPending).toBe(1);
      expect(raw.prepare('SELECT id FROM media_refs').all()).toEqual(priorRefs);
      expect((await fs.readdir(journalDir)).filter((name) => name.endsWith('.json'))).toEqual([]);
    },
  );

  it('recovers the malformed scratchpad URL and preserves bytes after source removal', async () => {
    const scratch = claudeScratchpadPath({ workingDir: work, sdkSessionId: sdk, agentKind: 'cc' })!;
    await fs.mkdir(scratch, { recursive: true });
    const source = path.join(scratch, 'shot.png');
    await fs.writeFile(source, PNG);
    const row = insert(`![before](${pathToFileURL(source).href.replace(/^file:/, 'xdt-image:')})`);
    const [saved] = await restoreTaskImageRows(client, [row]);
    const url = taskImageReferences(JSON.parse(saved.content))[0].url;
    expect(url).toMatch(/^cindy-media:\/\/blobs\/[a-f0-9]{64}\.png$/);
    await fs.rm(source);
    expect(await fs.readFile(resolveSafe(url).absPath)).toEqual(PNG);
    expect(raw.prepare('SELECT content FROM messages').get()).toEqual({ content: saved.content });
    expect((await restoreTaskImageRows(client, [saved]))[0]).toEqual(saved);
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
  });

  it('uses the same persisted bytes for chat and both channel collectors', async () => {
    const source = path.join(work, 'shot.png');
    await fs.writeFile(source, PNG);
    const text = `![shot](${pathToFileURL(source).href.replace(/^file:/, 'xdt-image:')})`;
    const personal = await materializeLocalMarkdownImages({
      text,
      workingDir: work,
      sessionId: 's',
    });
    expect(personal.text).toBe('shot');
    expect(personal.absPaths).toHaveLength(1);
    const [saved] = await restoreTaskImageRows(client, [insert(text)]);
    await fs.rm(source);
    const hook = await collectOutboundAttachments(JSON.parse(saved.content), [], {
      resolveImageUrl: resolveSafe,
      log: { warn: vi.fn() },
    });
    expect(hook.skipped).toBe(0);
    expect(hook.attachments).toHaveLength(1);
    expect(await fs.readFile(personal.absPaths[0])).toEqual(PNG);
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
  });

  it('serializes concurrent channel imports without duplicate task references', async () => {
    const source = path.join(work, 'shot.png');
    await fs.writeFile(source, PNG);
    const text = `![shot](${source})`;
    const results = await Promise.all([
      materializeTaskImageText('s', text),
      materializeTaskImageText('s', text),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(results[0]).toContain('cindy-media://');
    expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 1 });
  });

  it.each(['clear', 'remote', 'sdk', 'owner'])(
    'rejects a channel import after %s changes',
    async (kind) => {
      const source = path.join(work, 'shot.png');
      await fs.writeFile(source, PNG);
      const text = `![shot](${source})`;
      state.afterIngest = () => {
        if (kind === 'clear') raw.exec('UPDATE sessions SET cleared_at = 20');
        if (kind === 'remote') raw.exec("UPDATE sessions SET remote_host_id = 'other-host'");
        if (kind === 'sdk') raw.exec("UPDATE sessions SET sdk_session_id = 'new-session'");
        if (kind === 'owner') state.valid = false;
      };
      expect(await materializeTaskImageText('s', text)).toBe(text);
      expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 });
    },
  );

  it('imports one readable image and retains unrelated failed references and code examples', async () => {
    const source = path.join(work, 'shot.png');
    await fs.writeFile(source, PNG);
    const image = `![image](${source})`;
    const row = insert(`${image}\n\n\`${image}\`\n\n![missing](${work}/absent.png)`);
    const [saved] = await restoreTaskImageRows(client, [row]);
    expect(JSON.parse(saved.content)).toContain(`\`${image}\``);
    expect(JSON.parse(saved.content)).toContain(`![missing](${work}/absent.png)`);
    expect(taskImageReferences(JSON.parse(saved.content))[0].url).toMatch(/^cindy-media:/);
  });

  it.each(['remote', 'outside', 'other-scratch', 'symlink', 'not-image'])(
    'rejects %s sources',
    async (kind) => {
      let source = path.join(work, 'shot.png');
      if (kind === 'remote') raw.exec("UPDATE sessions SET remote_host_id = 'other-host'");
      if (kind === 'outside') source = path.join(state.root, 'private.png');
      if (kind === 'other-scratch') {
        source = path.join(
          claudeScratchpadPath({
            workingDir: work,
            sdkSessionId: sdk.replace(/^1/, '2'),
            agentKind: 'cc',
          })!,
          'shot.png',
        );
        await fs.mkdir(path.dirname(source), { recursive: true });
      }
      if (kind === 'symlink') {
        const outside = path.join(state.root, 'private.png');
        await fs.writeFile(outside, PNG);
        // Windows 目录 junction 无需文件软链权限，仍验证真实图片经链接逃出任务目录。
        if (process.platform === 'win32') {
          const link = path.join(work, 'linked');
          await fs.symlink(state.root, link, 'junction');
          source = path.join(link, 'private.png');
        } else {
          await fs.symlink(outside, source, 'file');
        }
        expect(await fs.realpath(source)).toBe(await fs.realpath(outside));
        await expect(readTaskImage(source, [await fs.realpath(work)])).rejects.toThrow('task-image: outside task');
      } else await fs.writeFile(source, kind === 'not-image' ? Buffer.from('not png') : PNG);
      const row = insert(`![image](${source})`);
      expect(await restoreTaskImageRows(client, [row])).toEqual([row]);
      expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 });
    },
  );

  it.each(['clear', 'edit', 'rewind', 'owner'])(
    'does not publish after %s during import',
    async (kind) => {
      const source = path.join(work, 'shot.png');
      await fs.writeFile(source, PNG);
      const row = insert(`![image](${source})`);
      state.afterIngest = () => {
        if (kind === 'clear') raw.exec('UPDATE sessions SET cleared_at = 20');
        if (kind === 'edit') raw.exec("UPDATE messages SET content = 'new text'");
        if (kind === 'rewind') raw.exec('UPDATE messages SET rewind_at = 20');
        if (kind === 'owner') state.valid = false;
      };
      expect(await restoreTaskImageRows(client, [row])).toEqual([row]);
      expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 });
      expect(raw.prepare('SELECT content FROM messages').get()).toEqual({
        content: kind === 'edit' ? 'new text' : row.content,
      });
    },
  );

  it('refuses a scratchpad redirected through a symlink', async () => {
    const scope = {
      id: 's',
      workingDir: work,
      sdkSessionId: sdk,
      agentKind: 'cc',
      remoteHostId: null,
      status: 'active' as const,
      clearedAt: null,
    };
    const scratch = claudeScratchpadPath(scope)!;
    await fs.mkdir(path.dirname(scratch), { recursive: true });
    await fs.symlink(work, scratch, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await taskImageRoots(scope)).toEqual([await fs.realpath(work)]);
  });

  it('reads only ordinary image files inside validated roots', async () => {
    await expect(readTaskImage(work, [await fs.realpath(work)])).rejects.toThrow();
  });

  it.each([
    '//attacker/share/a.png',
    '\\\\attacker\\share\\a.png',
    '/\\attacker/share/a.png',
    '\\/attacker/share/a.png',
    '//attacker@SSL/DavWWWRoot/a.png',
    '\\\\?\\UNC\\attacker\\share\\a.png',
    '\\\\.\\UNC\\attacker\\share\\a.png',
    '\\\\?\\C:\\task\\a.png',
    '\\\\.\\C:\\task\\a.png',
    '\\??\\UNC\\attacker\\share\\a.png',
  ])('rejects Windows network/device syntax before filesystem access: %s', async (source) => {
    const realpath = vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('unexpected filesystem access'));
    const open = vi.spyOn(fs, 'open');
    await expect(readTaskImage(source, [source])).rejects.toThrow('task-image: network or device path');
    expect(realpath).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    '//attacker/share/a.png',
    'xdt-image:////attacker/share/a.png',
    'xdt-file:///%2Fattacker/share/a.png',
    'xdt-image:///%5C%5Cattacker%5Cshare%5Ca.png',
  ])('does not resolve network targets after Markdown URL decoding: %s', async (url) => {
    const realpath = vi.spyOn(fs, 'realpath').mockRejectedValue(new Error('unexpected filesystem access'));
    const text = `![network](<${url}>)`;
    const result = await materializeTaskImageMarkdown(text, {
      importImage: async (source) => { await readTaskImage(source, [work]); return 'unreachable'; },
    });
    expect(result.text).toBe(text);
    expect(result.failures).toEqual([url]);
    expect(realpath).not.toHaveBeenCalled();
  });
});

it.each([true, false])('removes shared private definitions in both channels (readable=%s)', async (readable) => {
  const source = path.join(work, 'shared image.png');
  if (readable) await fs.writeFile(source, PNG);
  const target = pathToFileURL(source).href.replace(/^file:/, 'xdt-image:');
  const text = `![shot][p] [**download**][p] [p][] [p] [![nested][p]][p] [alias][a] [direct](<${target}>)

[p]: <${target}> "caption"
[p]: /private/ignored-duplicate.png
[a]: <${target}>

[web][w]

[w]: https://example.org/page
[w]: <${target}>
`;
  const saved = await materializeTaskImageText('s', text);
  const personal = await materializeLocalMarkdownImages({ text: saved, workingDir: work, sessionId: 's' });
  const hook = await collectOutboundAttachments(saved, [], { resolveImageUrl: resolveSafe, log: { warn: vi.fn() } });
  for (const body of [personal.text, hook.text]) {
    expect(body).toContain('**download**');
    expect(body).toContain('nested');
    expect(body).toContain('[web][w]');
    expect(body).toContain('[w]: https://example.org/page');
    expect(body).not.toContain(target);
    expect(body).not.toContain('/private/ignored-duplicate.png');
    expect(body).not.toContain('cindy-media://');
    expect(body).not.toContain('[p]');
  }
  expect(personal.absPaths).toHaveLength(readable ? 1 : 0);
  expect(hook.attachments).toHaveLength(readable ? 1 : 0);
  if (readable) {
    expect(saved).not.toContain(target);
    expect(saved).toContain('[**download**][p]');
    await fs.rm(source);
    expect(await fs.readFile(personal.absPaths[0])).toEqual(PNG);
  }
});

describe('Markdown image contract', () => {
  it('preserves code and HTML, and rewrites images in lists, tables and reference syntax', async () => {
    const source = path.join(path.sep, 'work', 'shot.png');
    const image = `![pic](${source})`;
    const text = `\`${image}\`\n\n\`\`\`md\n${image}\n\`\`\`\n\n<img src="${source}">\n\n- ${image}\n\n|pic|\n|---|\n|${image}|\n\n![ref][p]\n\n[p]: ${source}\n`;
    const importImage = vi.fn(async () => 'cindy-media://blobs/test.png');
    const result = await materializeTaskImageMarkdown(text, { importImage });
    expect(importImage).toHaveBeenCalledTimes(1);
    expect(result.text).toContain(`\`${image}\``);
    expect(result.text).toContain(`\`\`\`md\n${image}\n\`\`\``);
    expect(result.text).toContain('<img src=');
    expect(result.text).toContain('- ![pic](cindy-media://blobs/test.png)');
    expect(result.text).toContain('|![pic](cindy-media://blobs/test.png)|');
    expect(result.text).toContain('![ref](cindy-media://blobs/test.png)');
  });

  it('removes unused image definitions and retargets shared links to the persisted image', () => {
    const source = '![image][p]\n\n[p]: /tmp/a.png';
    const replacements = new Map([['/tmp/a.png', 'cindy-media://blobs/test.png']]);
    expect(rewriteTaskImageReferences(source, replacements)).not.toContain('/tmp/a.png');
    const shared = `[download][p]\n${source}`;
    expect(rewriteTaskImageReferences(shared, replacements)).toContain('[p]: <cindy-media://blobs/test.png>');
    expect(rewriteTaskImageReferences(shared, replacements)).not.toContain('/tmp/a.png');
  });

  it('supports spaces, parentheses and duplicate destinations without changing surrounding text', () => {
    const text = 'before ![a](</tmp/a (1).png> "caption") after';
    const ref = taskImageReferences(text)[0];
    expect(ref.url).toBe('/tmp/a (1).png');
    expect(
      rewriteTaskImageReferences(text, new Map([[ref.url, 'cindy-media://blobs/test.png']])),
    ).toBe('before ![a](cindy-media://blobs/test.png "caption") after');
  });
});

// #6447 integration: actual media bytes/DB, owner-scoped JSON, fresh store restore,
// ACK release, task deletion and expiry. Old tests only exercised the JSON ledger.
it.each(['image/png', 'video/mp4'])('hook outbox manages %s through recovery and deletion', async (mimeType) => {
  const bytes = mimeType === 'image/png' ? PNG : Buffer.alloc(6 * 1024 * 1024, 7);
  const attachments = [{ name: 'result', mimeType, dataBase64: bytes.toString('base64') }];
  const turn: TurnEndPayload = { requestId: 'r', externalKey: 'x:t', sessionId: 's', status: 'ok',
    finalText: 'done', errorMessage: null, usage: { durationMs: 0 }, attachments };
  const store = createHookMediaStore();
  const media = await store.prepare(turn, () => {});
  const { attachments: _, ...text } = turn;
  const filePath = path.join(state.root, 'hook-ledger.json');
  const log = { warn: vi.fn() };
  const saved = { connectionId: 'x', requestId: 'r', ack: { requestId: 'r', result: 'accepted' as const,
    sessionId: 's', reason: null, queuePosition: null }, turnEnd: text, media,
    delivery: 'pending' as const, completedAt: Date.now() };
  const first = createHookRequestLedger({ filePath, log, releaseMedia: store.release });
  expect(first.set(saved)).toBe(true);
  expect((await fs.stat(filePath)).size).toBeLessThan(2048);
  expect(await fs.readFile(filePath, 'utf8')).not.toContain('dataBase64');
  const next = createHookMediaStore();
  const ledgerAfterRestart = createHookRequestLedger({ filePath, log, releaseMedia: next.release });
  const recovered = ledgerAfterRestart.listPending('x')[0]!;
  expect((await next.restore(recovered.turnEnd!, recovered.media!))?.attachments).toEqual(attachments);
  ledgerAfterRestart.markSent('x', 'r');
  // The release runs asynchronously after the atomic JSON write.
  await vi.waitFor(() => expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 }), { interval: 1 });
  expect((await fs.readFile(resolveSafe(media[0]!.url).absPath)).equals(bytes)).toBe(true); // recycler owns bytes

  const deletedMedia = await next.prepare(turn, () => {});
  raw.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 's'").run();
  await ledger.removeSessionRefs('s', client.drizzle);
  expect(await next.restore(text, deletedMedia)).toBeNull();
  expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 });

  raw.prepare("UPDATE sessions SET status = 'active' WHERE id = 's'").run();
  await next.prepare(turn, () => {});
  raw.prepare('UPDATE media_refs SET created_at = ?').run(Date.now() - HOOK_TERMINAL_DELIVERY_TTL_MS - 1);
  await next.prune();
  expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 });
});

// Integration: a switch during ingestion must leave neither a pin nor a replayable result.
it('rolls back hook media if its owner changes during ingestion', async () => {
  const store = createHookMediaStore();
  state.afterIngest = () => { state.valid = false; };
  await expect(store.prepare({ requestId: 'r', externalKey: 'x:t', sessionId: 's', status: 'ok',
    finalText: 'done', errorMessage: null, usage: { durationMs: 0 },
    attachments: [{ name: 'image.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') }],
  }, () => {})).rejects.toThrow();
  expect(raw.prepare('SELECT count(*) AS n FROM media_refs').get()).toEqual({ n: 0 });
});
