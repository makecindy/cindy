import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { captureSkillArchive, materializeSkillArchive, type SkillArchiveIo } from '../skillArchive.js';
import { readStreamedSecret, writeStreamedSecret } from '../../secrets/streamedSecretFile.js';
import { importBotSkillDirectory } from '../../maker-ipc/botSkillStore.js';
import { createImportBudget } from '../files.js';
import { discoverImportSkills } from '../skills.js';

// Integration #9583: real ciphertext/cleartext disk transfer above the former
// per-file AND aggregate bounds. The unit smoke covers bounded chunks/recovery;
// hundreds of MiB of disk I/O must not share its five-second CI deadline.
// The separate tier is intentional; no unit assertion or size check is skipped.
it('migrates a file and multiple Skills above 128 MiB, then restores without the source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-large-import-'));
  const key = randomBytes(32);
  const cipher = {
    encrypt(text: string) {
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
  try {
    const sizes = { large: 128 * 1024 * 1024 + 1, first: 65 * 1024 * 1024, second: 65 * 1024 * 1024 };
    for (const [name, size] of Object.entries(sizes)) {
      const folder = path.join(root, 'skills', name);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\n---\n# Resource`);
      const file = await fs.open(path.join(folder, 'data.bin'), 'w');
      try { await file.write(Buffer.from([9]), 0, 1, size - 1); } finally { await file.close(); }
    }
    const source = { kind: 'hermes' as const, agentId: 'main', name: 'Ada', root, workspace: root, configFile: path.join(root, 'config.yaml') };
    const items = await discoverImportSkills(source, {}, root, {}, createImportBudget(4096));
    expect(items).toHaveLength(3);
    for (const item of items) {
      const { ref } = await captureSkillArchive('bot', item, io, {}, () => {});
      await fs.rm(item.sourceDirectory!, { recursive: true });
      await importBotSkillDirectory(root, 'bot', item.view.name,
        stage => materializeSkillArchive(ref, stage, io, {}, () => {}), () => {});
      const file = path.join(root, 'bots', 'bot', 'skills', item.view.name, 'data.bin');
      const size = sizes[item.view.name as keyof typeof sizes];
      expect((await fs.stat(file)).size).toBe(size);
      const handle = await fs.open(file, 'r');
      try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, size - 1); expect(byte[0]).toBe(9); }
      finally { await handle.close(); }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
