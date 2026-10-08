import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

it('executes the preserved resource with credentials while keeping ordinary code readable', async () => {
  const { importedContentRedactions } = await import('../connectionCatalog.js');
  const { importedProcessEnvironment, runImportedProcess } = await import('../process.js');
  const environment: CompanionEnvironment = { version: 1, env: { API_KEY: 'fixture-execution-token', FEATURE_ENABLED: 'true', RETRIES: '1' }, mcp: [], credentials: [] };
  const script = 'const value = "store_true"; if (process.env.API_KEY !== "fixture-execution-token") process.exit(1); console.log(value);';
  const projected = projectImportedSkill([{ name: 'run.cjs', bytes: Buffer.from(script), executable: true }], 'native-mcp', importedContentRedactions(environment));
  expect(projected.files[0]!.bytes.toString()).toContain('process.exit(1)');
  expect(projected.files[0]!.bytes.toString()).toContain('store_true');
  expect(projected.files[0]!.bytes.toString()).not.toContain('fixture-execution-token');
  environment.skillFiles = { 'native-mcp': projected.originals! };
  const result = await withImportedSkillResources(environment, () => {}, async env => runImportedProcess({
    command: process.execPath, args: [path.join(env.CINDY_IMPORTED_SKILLS!, 'native-mcp/run.cjs')], cwd: env.CINDY_IMPORTED_SKILLS!,
    env: importedProcessEnvironment(env), timeoutMs: 5000, signal: new AbortController().signal, assertOwner() {},
  }));
  expect(result).toEqual({ stdout: 'store_true\n', exitCode: 0 });
});

it('retains and materializes native interpreter aliases without copying them into broken standalone executables', async ctx => {
  const target = path.join(os.tmpdir(), 'fixture-native-python3');
  const interpreterName = `.venv/${process.platform === 'win32' ? 'Scripts' : 'bin'}/python`;
  const files = [
    { name: 'SKILL.md', bytes: Buffer.from('# Native'), executable: false },
    { name: interpreterName, bytes: Buffer.from('native fixture'), executable: true, interpreterLink: target },
  ];
  const projected = projectImportedSkill(files, 'native', {});
  expect(projected.files).toEqual(files);
  expect(projected.originals?.[1]?.interpreterLink).toBe(target);
  try {
    await withImportedSkillResources({ version: 1, env: {}, mcp: [], credentials: [], skillFiles: { native: projected.originals! } }, () => {}, async env => {
      expect(await fs.readlink(path.join(env.CINDY_IMPORTED_SKILLS!, 'native', interpreterName))).toBe(target);
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { ctx.skip(); return; } throw error; }
});
