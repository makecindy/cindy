import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { projectImportedSkill, withImportedSkillResources } from '../skillResources.js';
import type { CompanionEnvironment } from '../environment.js';

it.each([false, true])('redacts UTF-16 text resources (big endian: %s) without changing encoding or executable metadata', bigEndian => {
  const bytes = Buffer.from('\ufeff原文\r\nfake-selected-token', 'utf16le');
  if (bigEndian) bytes.swap16();
  const result = projectImportedSkill([{ name: 'reference.txt', bytes, executable: true }], 'report', { TOKEN: 'fake-selected-token' });
  const published = Buffer.from(result.files[0]!.bytes);
  if (bigEndian) published.swap16();
  expect(published.toString('utf16le')).toBe('\ufeff原文\r\n[TOKEN]');
  expect(result.files[0]?.executable).toBe(true);
  expect(result.originals?.[0]?.bytes).toBe(bytes.toString('base64'));
});

it.each(['failure', 'owner-change'])('cleans original resources after %s without rewriting the public skill', async reason => {
  const environment: CompanionEnvironment = { version: 1, env: {}, mcp: [], credentials: [], skillFiles: {
    report: [{ name: 'data.txt', bytes: Buffer.from('fake-private-token').toString('base64'), executable: false }],
  } };
  let directory = ''; let ownerValid = true;
  const assertOwner = () => { if (!ownerValid) throw new Error('OWNER_CHANGED'); };
  await expect(withImportedSkillResources(environment, assertOwner, async env => {
    directory = env.CINDY_IMPORTED_SKILLS!;
    expect(await fs.readFile(path.join(directory, 'report', 'data.txt'), 'utf8')).toBe('fake-private-token');
    if (reason === 'owner-change') { ownerValid = false; assertOwner(); }
    throw new Error('command failed');
  })).rejects.toThrow(reason === 'owner-change' ? 'OWNER_CHANGED' : 'command failed');
  await expect(fs.access(directory)).rejects.toThrow();
  expect(environment.env).not.toHaveProperty('CINDY_IMPORTED_SKILLS');
});
