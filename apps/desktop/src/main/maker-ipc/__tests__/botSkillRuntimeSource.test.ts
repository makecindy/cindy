import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { iterateBotSkillRuntimeSummaries, iterateBotSkillQuerySummaries } from '../botSkillRuntimeSource';
import { botSkillsDir, parseBotSkillFile, readBotSkill } from '../botSkillStore';
import yaml from 'js-yaml';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-skill-stream-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });
async function source(slug: string, text: string) {
  const dir = path.join(botSkillsDir(home, 'bot'), slug);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, text);
  return file;
}
async function read(iterate = iterateBotSkillRuntimeSummaries) {
  const items = [];
  for await (const item of iterate(home, 'bot')) items.push(item);
  return items;
}

it.each(['>', '|', '>-', '|-', '>+', '|2+ # keep newlines', '>2- # folded'])('parses YAML block metadata (%s) consistently without modifying the original', async indicator => {
  const header = `---\r\nname: fixture\r\ndescription: ${indicator}\r\n  invoice reconciliation\r\n  keyword: matching\r\n\r\n  second paragraph\r\n    indented detail\r\n  last line\r\n\r\nmetadata:\r\n  displayName: |-\r\n    Visible name\r\n  updatedAt: "2026-09-29"\r\nunknown: |\r\n  description: must not replace metadata\r\n---\r\n`;
  const text = header + 'Original body';
  const expected = yaml.load(header.slice(5, -5)) as { description: string };
  const file = await source('block', text);
  for (const iterate of [iterateBotSkillRuntimeSummaries, iterateBotSkillQuerySummaries]) {
    const [item] = await read(iterate);
    expect(item).toMatchObject({ name: 'Visible name', description: expected.description, updatedAt: '2026-09-29', frontmatterBytes: Buffer.byteLength(header), bodyStartLine: header.split('\n').length });
  }
  expect(parseBotSkillFile(text)).toMatchObject({ name: 'Visible name', description: expected.description, body: 'Original body' });
  expect(await fs.readFile(file, 'utf8')).toBe(text);
});

it('bounds multi-line block previews but keeps the full description in the query stream', async () => {
  const description = Array.from({ length: 50_000 }, (_, index) => `  Line ${index} 中文`).join('\n');
  const text = `---\nname: fixture\ndescription: >-\n${description}\n  unique-tail-term\nmetadata:\n  displayName: Visible\n---\nOriginal body`;
  const file = await source('long-block', text);
  const [preview] = await read();
  expect(preview.description).toContain('Line 0 中文');
  expect(Buffer.byteLength(preview.description)).toBeLessThan(4200);
  expect(preview.name).toBe('Visible');
  const [full] = await read(iterateBotSkillQuerySummaries);
  expect(full.description).toContain('Line 49999 中文');
  expect(full.description).toContain('unique-tail-term');
  expect(full.description).toBe(parseBotSkillFile(text).description);
  expect(await fs.readFile(file, 'utf8')).toBe(text);
});

it('does not migrate an empty block scalar as legacy Cindy-authored metadata', async () => {
  const text = '---\nname: fixture\ndescription: >-\nupdatedAt: "2026-09-29"\n---\nOriginal body\n';
  const file = await source('empty-block', text);
  expect(await read()).toMatchObject([{ description: '', name: 'fixture' }]);
  expect(await readBotSkill(home, 'bot', 'empty-block')).toMatchObject({ description: '', body: 'Original body' });
  expect(await fs.readFile(file, 'utf8')).toBe(text);
});

it.each([['runtime', iterateBotSkillRuntimeSummaries], ['query', iterateBotSkillQuerySummaries]] as const)('%s uses directory streaming and header-only reads for a large Skill body', async (_kind, iterate) => {
  const file = await source('large-body', `---\nname: fixture\ndescription: >-\n  Preview\n  continued\n---\n${'Body '.repeat(2 * 1024 * 1024)}`);
  const readdir = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('unbounded enumeration'));
  const readFile = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('full file read'));
  const originalOpen = fs.open.bind(fs);
  let bytesRead = 0;
  const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
      const result = await (originalRead as any)(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    });
    return handle;
  });
  expect(await read(iterate)).toMatchObject([{ name: 'fixture', description: 'Preview continued', filePath: file, bodyStartLine: 7 }]);
  expect(bytesRead).toBeLessThanOrEqual(8192);
  expect(readdir).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
  open.mockRestore();
});

it('bounds giant scalar previews, scans later metadata, and counts CRLF/EOF body offsets', async () => {
  const text = `---\r\nunknown: ${'x'.repeat(4 * 1024 * 1024)}\r\nname: "${'名'.repeat(2 * 1024 * 1024)}"\r\ndescription: "Quoted \\"value\\""\r\n---`;
  const file = await source('wide-header', text);
  const [item] = await read();
  expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(8192);
  expect(item.name).toMatch(/^名/);
  expect(item.description).toBe('Quoted "value"');
  expect(item.bodyStartLine).toBe(5);
  expect(item.frontmatterBytes).toBe(Buffer.byteLength(text));
  expect(await fs.readFile(file, 'utf8')).toBe(text);
});

it('preserves bounded legacy migration and routes oversized legacy bodies to original-file discovery', async () => {
  const header = '---\nname: "旧技能"\ndescription: "Preview"\nupdatedAt: "2026-09-29"\n---\n';
  const small = await source('old-small', header + 'Original steps');
  const bigText = header + 'Large original body\n'.repeat(8192);
  const large = await source('old-large', bigText);
  const items = await read();
  expect(items.find(item => item.slug === 'old-small')).toMatchObject({ name: '旧技能', bodyStartLine: 8 });
  expect(await fs.readFile(small, 'utf8')).toContain('displayName: "旧技能"');
  expect(items.find(item => item.slug === 'old-large')).toMatchObject({ name: '旧技能', requiresDiscovery: true, bodyStartLine: 6 });
  expect(await fs.readFile(large, 'utf8')).toBe(bigText);
});

it('handles absent or unfinished frontmatter and excludes disabled/hidden/non-directory entries', async () => {
  await source('raw', 'Just a body');
  await source('unfinished', '---\nname: ignored\nNo closing header');
  await source('.hidden', '---\nname: hidden\n---\n');
  await fs.writeFile(path.join(botSkillsDir(home, 'bot'), 'not-a-directory'), 'Not a Skill');
  const disabled = path.join(home, 'bots/bot/disabled-skills/disabled');
  await fs.mkdir(disabled, { recursive: true });
  await fs.writeFile(path.join(disabled, 'SKILL.md'), '---\nname: disabled\n---\n');
  const items = await read();
  expect(items.map(item => item.slug).sort()).toEqual(['raw', 'unfinished']);
  expect(items.every(item => item.name === item.slug && item.description === '' && item.bodyStartLine === 1)).toBe(true);
});

it('keeps healthy siblings when one existing Skill cannot be read', async () => {
  const broken = await source('unreadable', '---\nname: unreadable\n---\n');
  await source('healthy', '---\nname: healthy\n---\n');
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (args[0] === broken) throw Object.assign(new Error('fixture permission'), { code: 'EACCES' });
    return originalOpen(...args);
  });
  expect((await read()).map(item => item.slug)).toEqual(['healthy']);
  expect(await fs.readFile(broken, 'utf8')).toContain('name: unreadable');
});
