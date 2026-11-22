import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { captureSkillArchive, materializeSkillArchive, readSkillArchiveContext, type SkillArchiveIo } from '../skillArchive.js';
import { readStreamedSecret, writeStreamedSecret } from '../../secrets/streamedSecretFile.js';
import { importBotSkillDirectory } from '../../maker-ipc/botSkillStore.js';
import { createImportBudget, serializeImportSnapshotAsync } from '../files.js';
import { discoverImportSkills } from '../skills.js';
import { readImportSkillManifest, scanImportSkillReferences } from '../skillFileStreams.js';
import type { ImportItem } from '../types.js';

// Unit: real discovery/capture/vault/publication, isolated temp data and injected
// OS cipher. Regression: a resource or aggregate above 128 MiB could never
// migrate. The >128 MiB disk matrix lives in skillArchive.integration.test.ts;
// this unit suite keeps a small multi-chunk smoke. Existing tests could not test bounded reads,
// archive corruption or recovery without the source. No native accounts/servers.
let root: string;
let maxCryptoInput = 0;
const key = randomBytes(32);
const cipher = {
  encrypt(text: string) {
    maxCryptoInput = Math.max(maxCryptoInput, text.length);
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  },
  decrypt(bytes: Buffer) {
    const d = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    d.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([d.update(bytes.subarray(12, -16)), d.final()]).toString('utf8');
  },
};
const io: SkillArchiveIo = {
  async writeResource(botId, id, chunks, assertOwner) {
    const digest = await writeStreamedSecret(path.join(root, `${id}.enc`), botId, chunks, cipher, assertOwner);
    return { key: botId, id, digest };
  },
  readResource(ref, assertOwner) { return readStreamedSecret(path.join(root, `${ref.id}.enc`), ref.key, ref.digest, cipher, assertOwner); },
};
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-archive-')); maxCryptoInput = 0; });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
// Unit #9583: directory order must not let dependencies or large sibling code
// displace the entry point. Capture real encrypted records with SKILL.md last.
it.each([96000, 4000])('preserves the manifest within a %i-character planning budget', async limit => {
  const files = ['.venv/lib/dependency.py', 'nested/node_modules/package/index.js', 'venv/lib/library.py',
    'scripts/query.py', 'scripts/extra.py', 'scripts/more.py', 'SKILL.md'].map(name => ({
      name, executable: false, bytes: Buffer.from(name === 'SKILL.md' ? '# Entry: run scripts/query.py' : 'x'.repeat(33000)),
    }));
  const item: ImportItem = { view: { id: 'report', name: 'report', category: 'skills', selected: true }, files, filesComplete: true };
  const { ref } = await captureSkillArchive('bot', item, io, {}, () => {});
  const budget = { remaining: limit };
  const context = await readSkillArchiveContext(ref, io, {}, () => {}, 'report', budget);
  expect(context.find(file => file.name === 'report/SKILL.md')?.source).toBe('# Entry: run scripts/query.py');
  expect(context.some(file => /dependency|package|library/.test(file.name))).toBe(false);
  expect(context.reduce((size, file) => size + file.name.length + file.source.length, 0)).toBeLessThanOrEqual(limit);
  expect(budget.remaining).toBeGreaterThanOrEqual(0);
});
async function source(name = 'report') {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\nUse the resources.`);
  const item: ImportItem = { view: { id: name, name, category: 'skills', selected: true }, sourceDirectory: directory, filesComplete: false };
  return { directory, item };
}

it('imports resources beyond the preview budget with bounded records and restores without the source', async () => {
  const { directory, item } = await source();
  const file = await fs.open(path.join(directory, 'large.bin'), 'w');
  const size = 1024 * 1024 + 1;
  try { await file.write(Buffer.from([9]), 0, 1, size - 1); } finally { await file.close(); }
  await fs.mkdir(path.join(root, 'skills'));
  await fs.rename(directory, path.join(root, 'skills', 'report'));
  item.sourceDirectory = path.join(root, 'skills', 'report');
  const sourceInfo = { kind: 'hermes' as const, agentId: 'main', name: 'Ada', root, workspace: root, configFile: path.join(root, 'config.yaml') };
  const preview = await discoverImportSkills(sourceInfo, {}, root, {}, createImportBudget(4096));
  expect(preview).toHaveLength(1);
  expect(preview[0]!.files).toBeUndefined();
  const { ref } = await captureSkillArchive('bot', item, io, {}, () => {});
  expect(maxCryptoInput).toBeLessThan(66 * 1024);
  item.skillArchive = ref; item.filesComplete = true;
  const checkpoint = await serializeImportSnapshotAsync({ source: sourceInfo, items: [item], fingerprint: 'fixture' }, () => {});
  expect(checkpoint.length).toBeLessThan(4096);
  await fs.rm(item.sourceDirectory, { recursive: true });
  const publish = () => importBotSkillDirectory(root, 'bot', 'report', stage => materializeSkillArchive(ref, stage, io, {}, () => {}), () => {});
  await publish();
  const target = path.join(root, 'bots', 'bot', 'skills', 'report', 'large.bin');
  expect((await fs.stat(target)).size).toBe(size);
  const check = await fs.open(target, 'r');
  try { const byte = Buffer.alloc(1); await check.read(byte, 0, 1, size - 1); expect(byte[0]).toBe(9); } finally { await check.close(); }
});

it.each(['utf8', 'utf16le', 'utf16be'] as const)('redacts split %s credentials and retains exact encrypted originals', async encoding => {
  const { directory, item } = await source();
  const secret = 'fixture-private-resource-token';
  const text = (encoding === 'utf8' ? '' : '\ufeff') + 'a'.repeat(encoding === 'utf8' ? 32760 : 16378) + secret + '\n尾';
  const bytes = Buffer.from(text, encoding === 'utf8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf16be') bytes.swap16();
  await fs.writeFile(path.join(directory, 'run.txt'), bytes);
  const { ref, redactions } = await captureSkillArchive('bot', item, io, { TOKEN: secret }, () => {});
  expect(redactions).toEqual({ TOKEN: secret });
  expect(await fs.readFile(path.join(root, `${ref.id}.enc`), 'utf8')).not.toContain(secret);
  const target = path.join(root, 'public'), original = path.join(root, 'original');
  await fs.mkdir(target); await fs.mkdir(original);
  await materializeSkillArchive(ref, target, io, { TOKEN: secret }, () => {}, true, 'report');
  const publicBytes = await fs.readFile(path.join(target, 'run.txt'));
  if (encoding === 'utf16be') publicBytes.swap16();
  expect(publicBytes.toString(encoding === 'utf8' ? 'utf8' : 'utf16le')).toBe(text.replace(secret, '[TOKEN]'));
  expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toContain('companion_connections.run_command');
  await materializeSkillArchive(ref, original, io, {}, () => {}, false);
  expect((await fs.readFile(path.join(original, 'run.txt'))).equals(bytes)).toBe(true);
});

it('does not publish a truncated archive and preserves user edits during restart recovery', async () => {
  const { directory, item } = await source();
  await fs.writeFile(path.join(directory, 'run.txt'), 'original');
  const { ref } = await captureSkillArchive('bot', item, io, {}, () => {});
  const publish = () => importBotSkillDirectory(root, 'bot', 'report', stage => materializeSkillArchive(ref, stage, io, {}, () => {}), () => {});
  const file = path.join(root, `${ref.id}.enc`), original = await fs.readFile(file);
  await fs.truncate(file, original.length - 100);
  await expect(publish()).rejects.toThrow();
  await expect(fs.access(path.join(root, 'bots', 'bot', 'skills', 'report'))).rejects.toThrow();
  await fs.writeFile(file, original);
  await publish(); await publish();
  const edited = path.join(root, 'bots', 'bot', 'skills', 'report', 'run.txt');
  await fs.writeFile(edited, 'owner edit');
  await expect(publish()).rejects.toThrow('Imported skill was edited');
  expect(await fs.readFile(edited, 'utf8')).toBe('owner edit');
});

it('keeps the last complete ciphertext and removes staging when capture loses its owner', async () => {
  const { directory, item } = await source();
  const { ref } = await captureSkillArchive('bot', item, io, {}, () => {});
  const original = await fs.readFile(path.join(root, `${ref.id}.enc`));
  await fs.writeFile(path.join(directory, 'new.bin'), Buffer.alloc(100000));
  let calls = 0;
  await expect(captureSkillArchive('bot', item, io, {}, () => { if (++calls === 12) throw new Error('OWNER_CHANGED'); })).rejects.toThrow('OWNER_CHANGED');
  expect((await fs.readFile(path.join(root, `${ref.id}.enc`))).equals(original)).toBe(true);
  expect((await fs.readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false);
});

// Unit: discovery must not apply the old whole-file bound to a manifest body,
// and dependency scanning must not select credentials for unrelated identifiers.
it('previews large manifest bodies and scans exact dependency identifiers across chunk boundaries', async () => {
  const { directory } = await source();
  const manifest = path.join(directory, 'SKILL.md');
  await fs.truncate(manifest, 16 * 1024 * 1024 + 1);
  expect(await readImportSkillManifest(directory)).toContain('name: report');
  await fs.writeFile(manifest, '---\n---\n# Report');
  await fs.truncate(manifest, 16 * 1024 * 1024 + 1);
  expect(await readImportSkillManifest(directory)).toBe('---\n---\n');
  // Closing delimiters can straddle a read boundary (including CRLF).
  for (const newline of ['\n', '\r\n']) {
    const prefix = '---' + newline + 'description: ';
    const header = prefix + 'x'.repeat(32766 - prefix.length) + newline + '---' + newline;
    await fs.writeFile(manifest, header + '# Body must not enter the YAML preview');
    expect(await readImportSkillManifest(directory)).toBe(header);
  }
  await fs.writeFile(manifest, ' '.repeat(32768) + '# Report');
  expect(await readImportSkillManifest(directory)).toBe('# Skill');
  await fs.writeFile(path.join(directory, 'run.py'), 'x'.repeat(32763) + ' TOKEN_SUFFIX ' + 'x'.repeat(32740) + ' REAL_TOKEN');
  expect(await scanImportSkillReferences(directory, ['TOKEN', 'REAL_TOKEN'], new Set(['TOKEN', 'REAL_TOKEN']))).toBe('REAL_TOKEN');
});

it('rejects a resource edited between inspection and capture without publishing ciphertext', async () => {
  const { directory, item } = await source();
  let mutated = false;
  const changingIo: SkillArchiveIo = { ...io, async writeResource(botId, id, chunks, assertOwner) {
    async function* changing() {
      for await (const chunk of chunks) {
        if (!mutated && JSON.parse(chunk).file?.name === 'SKILL.md') {
          mutated = true;
          await fs.writeFile(path.join(directory, 'SKILL.md'), 'changed after inspection');
        }
        yield chunk;
      }
    }
    return io.writeResource(botId, id, changing(), assertOwner);
  } };
  await expect(captureSkillArchive('bot', item, changingIo, {}, () => {})).rejects.toThrow('SOURCE_CHANGED');
  expect((await fs.readdir(root)).filter(name => name.endsWith('.enc') || name.endsWith('.tmp'))).toEqual([]);
});

// Unit #9583: planning must retain useful code without loading whole resources,
// exposing a partially cut credential, or returning text before the footer verifies.
it('bounds authenticated planning excerpts and masks credentials before truncation', async () => {
  const { directory, item } = await source();
  const secret = 'fixture-secret-spanning-the-prefix-limit';
  await fs.writeFile(path.join(directory, 'query.py'), 'x'.repeat(31990) + secret + 'y'.repeat(100000));
  const { ref } = await captureSkillArchive('bot', item, io, { TOKEN: secret }, () => {});
  const budget = { remaining: 96000 };
  const context = await readSkillArchiveContext(ref, io, { TOKEN: secret }, () => {}, 'report', budget);
  const query = context.find(file => file.name === 'report/query.py')!;
  expect(query.complete).toBe(false);
  expect(query.source.length).toBe(32000);
  expect(query.source).toContain('[TOKEN]');
  expect(query.source).not.toContain('fixture-secret');
  expect(context.reduce((size, file) => size + file.name.length + file.source.length, 0)).toBeLessThanOrEqual(96000);
  const file = path.join(root, `${ref.id}.enc`);
  await fs.truncate(file, (await fs.stat(file)).size - 100);
  await expect(readSkillArchiveContext(ref, io, {}, () => {}, 'report', { remaining: 96000 })).rejects.toThrow();
});
