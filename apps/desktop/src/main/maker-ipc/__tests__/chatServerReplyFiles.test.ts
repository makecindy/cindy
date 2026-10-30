import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const scope = vi.hoisted(() => ({ snapshot: null as unknown, row: {} as Record<string, unknown>, reply: null as { content: string } | null }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => scope.snapshot }));
import { messages } from '../../localDb/schema.js';
import { prepareChatReplyFiles, readReplyFile } from '../chatServerReplyFiles.js';

// #6761: production file preparation and descriptor reading. Group adapter tests mock
// this boundary; these unit cases verify real scope, bytes and Markdown (small temp files).
describe('group reply file delivery', () => {
  let root: string, work: string, pdf: string;
  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chat-reply-files-')));
    work = path.join(root, 'task'); await fs.mkdir(work);
    pdf = path.join(work, 'report 中文.pdf');
    await fs.writeFile(path.join(root, 'private.pdf'), 'private');
  });
  beforeEach(async () => {
    await fs.writeFile(pdf, '%PDF-1.4\nreport');
    scope.row = { workingDir: work, remoteHostId: null, status: 'active', clearedAt: null };
    scope.reply = null;
    scope.snapshot = { client: { drizzle: { select: () => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => table === messages ? (scope.reply ? [scope.reply] : []) : [{ ...scope.row }] }) }) }) } } };
  });
  afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('delivers explicit PDF links once with their bytes and removes local links from the body', async () => {
    const url = pathToFileURL(pdf).href.replace(/^file:/, 'xdt-file:');
    const result = await prepareChatReplyFiles(`[报告](${url}) and [再次](${url})`, 'lane', () => {});
    expect(result.text).toBe('报告 and 再次');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({ name: path.basename(pdf), mimeType: 'application/pdf', path: null, url: null });
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
  });

  it('supports angle-bracket paths, relative and reference links without consuming images or examples', async () => {
    const body = `[报告](<${pdf}>)\n[再次][r]\n\n[r]: <${pdf}>\n\n\`[example](./x.pdf)\`\n![picture](./x.png)\n[web](https://example.test/r.pdf)`;
    const result = await prepareChatReplyFiles(body, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect(result.text).not.toContain(pdf);
    expect(result.text).toContain('`[example](./x.pdf)`');
    expect(result.text).toContain('![picture](./x.png)');
    expect(result.text).toContain('[web](https://example.test/r.pdf)');
    const relative = await prepareChatReplyFiles('[报告](<./report 中文.pdf>)', 'lane', () => {});
    expect((await relative.attachments[0]!.readBytes!()).length).toBeGreaterThan(0);
    const escaped = await prepareChatReplyFiles(`[报告](&lt;${pdf}&gt;)`, 'lane', () => {});
    expect(escaped.text).toBe('报告');
    expect((await escaped.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
  });

  // #6773 review: the outer link delivers a file even when its visible label is
  // an image. Keep that image markup for the existing image-delivery pass.
  it.each(['inline', 'reference', 'shared-reference'])('delivers a file with an image label (%s)', async mode => {
    const image = mode === 'inline' ? '![preview](./preview.png)' : '![preview][image]';
    const target = mode === 'shared-reference' ? 'image' : 'report';
    const body = mode === 'inline' ? `[${image}](<${pdf}>)`
      : `[${image}][${target}]\n\n[report]: <${pdf}>\n[image]: <${mode === 'shared-reference' ? pdf : './preview.png'}>`;
    const result = await prepareChatReplyFiles(body, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
    expect(result.text).toContain(image);
    expect(result.text).not.toContain(`[${image}]`);
    if (mode === 'shared-reference') expect(result.text).toContain(`[image]: <${pdf}>`);
  });

  it.each(['file', 'xdt-file', 'xdt-query'].flatMap(scheme => ['100% done.pdf', 'encoded%20.pdf'].map(name => [scheme, name])))('preserves literal or once-encoded percent paths: %s %s', async (scheme, name) => {
    const file = path.join(work, name);
    await fs.writeFile(file, 'percent report');
    // A direct legacy URL is a URI with forward slashes on every platform.
    const direct = `${scheme}://${file.startsWith('/') ? '' : '/'}${file.replaceAll('\\', '/')}`;
    const encoded = pathToFileURL(file).href.replace(/^file:/, `${scheme}:`);
    const result = await prepareChatReplyFiles(`[file](<${scheme === 'xdt-query' ? `xdt-file://local?path=${encodeURIComponent(file)}` : name.startsWith('100') ? direct : encoded}>)`, 'lane', () => {});
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('percent report');
  });

  it.each(['final report 中文.pdf', 'encoded%20.pdf', '100% done.pdf'])('decodes relative file hrefs once or preserves malformed percents: %s', async name => {
    const dir = path.join(work, 'reports');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), 'relative report');
    const href = `reports/${name.startsWith('100') ? name : encodeURIComponent(name)}`;
    const result = await prepareChatReplyFiles(`[report](<${href}>)`, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('relative report');
  });

  it.each(['reports%2Ffinal.pdf', 'reports%5Cfinal.pdf', 'reports/%2e%2e/report.pdf', '%68ttps%3A%2F%2Fexample.test/a.pdf', '%2F%2Fserver/a.pdf', 'reports/%00.pdf'])('refuses path syntax introduced by href decoding: %s', async href => {
    await expect(prepareChatReplyFiles(`[report](${href})`, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it.each(['final report 中文.pdf', 'encoded%20.pdf', '100% done.pdf'])('decodes sandbox paths once or preserves malformed percents: %s', async name => {
    const file = path.join(work, name);
    await fs.writeFile(file, 'sandbox report');
    const href = `sandbox:/${work.replaceAll('\\', '/')}/${name.startsWith('100') ? name : encodeURIComponent(name)}`;
    const result = await prepareChatReplyFiles(`[report](<${href}>)`, 'lane', () => {});
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('sandbox report');
  });

  it.each(['reports%2Ffinal.pdf', 'reports%5Cfinal.pdf', '%2e%2e/private.pdf', '%00.pdf'])('refuses encoded sandbox path syntax: %s', async suffix => {
    const href = `sandbox:/${work.replaceAll('\\', '/')}/${suffix}`;
    await expect(prepareChatReplyFiles(`[report](${href})`, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('checks directory case aliases against the real filesystem and task root', async () => {
    const alias = path.join(root, 'TASK');
    let sameDirectory = false;
    try { sameDirectory = (await fs.stat(alias)).ino === (await fs.stat(work)).ino; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const target = path.join(alias, path.basename(pdf));
    if (sameDirectory) {
      const result = await prepareChatReplyFiles(`[report](<${target}>) [again](<${pdf}>)`, 'lane', () => {});
      expect(result.attachments).toHaveLength(1);
      expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
    } else {
      await fs.mkdir(alias);
      try {
        await fs.writeFile(target, 'outside');
        await expect(prepareChatReplyFiles(`[report](<${target}>)`, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
      } finally { await fs.rm(alias, { recursive: true }); }
    }
  });

  it('leaves ordinary relative navigation targets unchanged without file authority', async () => {
    scope.snapshot = null;
    const text = '[help](about) [guide][nav]\n\n[nav]: getting-started';
    expect(await prepareChatReplyFiles(text, 'lane', () => {})).toEqual({ text, attachments: [] });
  });

  it.each(['image', 'reference', 'image-reference'])('recovers escaped file targets with %s labels', async mode => {
    const image = '![preview](./preview.png)';
    const body = mode === 'image' ? `[${image}](&lt;${pdf}&gt;)`
      : `[${mode === 'reference' ? 'report' : image}][r]\n\n[r]: &lt;${pdf}&gt;`;
    const result = await prepareChatReplyFiles(body, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
    expect(result.text.trim()).toBe(mode === 'reference' ? 'report' : image);
  });

  it('does not recover escaped targets in code or HTML examples', async () => {
    const text = '`[report](&lt;missing file.pdf&gt;)`\n\n```md\n[r]: &lt;missing file.pdf&gt;\n```\n\n<div>\n[report](&lt;missing file.pdf&gt;)\n</div>';
    scope.snapshot = null;
    expect(await prepareChatReplyFiles(text, 'lane', () => {})).toEqual({ text, attachments: [] });
  });

  it('deduplicates accepted symlink targets before the file limit, retaining the first link', async () => {
    const aliases: string[] = [];
    for (let i = 0; i < 24; i++) {
      const alias = path.join(work, `same-report-${i}.pdf`);
      await fs.symlink(pdf, alias);
      aliases.push(alias);
    }
    try {
      const body = [...aliases, pdf].map(source => `[report](<${source}>)`).join(' ');
      const result = await prepareChatReplyFiles(body, 'lane', () => {});
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]!.name).toBe(path.basename(aliases[0]!));
      expect((await result.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
    } finally { for (const alias of aliases) await fs.unlink(alias); }
  });

  it('deduplicates real filesystem identities before applying the count limit', async () => {
    const source = path.join(work, 'CaseReport.pdf');
    await fs.writeFile(source, 'case report');
    const names = Array.from({ length: 32 }, (_, mask) => [...'casereport'].map((c, i) => mask & (1 << i) ? c.toUpperCase() : c).join('') + '.pdf');
    // Probe this actual volume; neither platform nor fs metadata is mocked.
    let insensitive = false;
    try { insensitive = (await fs.stat(path.join(work, names[0]!))).ino === (await fs.stat(source)).ino; } catch { /* case-sensitive volume */ }
    if (!insensitive) for (const name of names.slice(0, 2)) await fs.writeFile(path.join(work, name), 'case report');
    const refs = insensitive ? names : names.slice(0, 2);
    const result = await prepareChatReplyFiles(refs.map(name => `[report](${name})`).join(' '), 'lane', () => {});
    expect(result.attachments).toHaveLength(insensitive ? 1 : 2);
    for (const attachment of result.attachments) expect((await attachment.readBytes!()).toString()).toBe('case report');
  });

  it.each(['    ', '\t'])('never delivers an indented persisted code example (%j)', async indent => {
    scope.reply = { content: JSON.stringify({ text: `${indent}[example](<${pdf}>)` }) };
    const text = `[example](<${pdf}>)`;
    expect(await prepareChatReplyFiles(text, 'lane', () => {}, 'reply-client')).toEqual({ text, attachments: [] });
  });

  it('retains file positions relative to the body passed to image preparation', async () => {
    const image = '![chart](cindy-media://blobs/' + 'a'.repeat(64) + '.png)';
    const body = `[report](&lt;${pdf}&gt;) ${image} [data][r]\n\n[r]: <./ordered.json>`;
    await fs.writeFile(path.join(work, 'ordered.json'), '{}');
    const result = await prepareChatReplyFiles(body, 'lane', () => {});
    expect(result.attachments.map(a => a.sourceOffset)).toEqual([0, result.text.indexOf('data')]);
    expect(result.text.indexOf(image)).toBeGreaterThan(result.attachments[0]!.sourceOffset!);
    expect(result.text.indexOf(image)).toBeLessThan(result.attachments[1]!.sourceOffset!);
  });

  it('preserves persisted Markdown for an empty SDK result without changing ordinary text replies', async () => {
    scope.reply = { content: JSON.stringify({ text: `[报告][r]\n\n[r]: <${pdf}>` }) };
    const result = await prepareChatReplyFiles(`[报告][r] [r]: <${pdf}>`, 'lane', () => {}, 'reply-client');
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('%PDF-1.4\nreport');
    expect(result.text.trim()).toBe('报告');
    scope.reply = { content: JSON.stringify({ text: 'First\nSecond' }) };
    expect(await prepareChatReplyFiles('First Second', 'lane', () => {}, 'reply-client')).toEqual({ text: 'First Second', attachments: [] });
  });

  it.each(['pdf', 'html', 'md', 'json'])('delivers bare relative %s links through the production parser', async ext => {
    await fs.mkdir(path.join(work, 'documents'), { recursive: true });
    const name = `documents/报告.${ext}`;
    await fs.writeFile(path.join(work, name), 'report bytes');
    const result = await prepareChatReplyFiles(`[报告](${name})`, 'lane', () => {});
    expect(result.text).toBe('报告');
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('report bytes');
  });

  it.each(['local/', 'open'])('accepts canonical xdt-file %s query paths', async host => {
    const result = await prepareChatReplyFiles(`[报告](xdt-file://${host}?path=${encodeURIComponent(pdf)})`, 'lane', () => {});
    expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
  });

  it('accepts sandbox absolute paths within the task', async () => {
    const result = await prepareChatReplyFiles(`[报告](<sandbox:/${pdf.replaceAll('\\', '/')}>)`, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
  });

  it('accepts canonical paths when the task workdir is an alias and deduplicates spellings', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      scope.row.workingDir = alias;
      const result = await prepareChatReplyFiles(`[real](<${pdf}>) [alias](<${path.join(alias, path.basename(pdf))}>)`, 'lane', () => {});
      expect(result.attachments).toHaveLength(1);
      expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
    } finally { await fs.unlink(alias); }
  });

  it('keeps remote protocols and anchors out of local file delivery', async () => {
    scope.snapshot = null;
    const text = '[anchor](#report) [mail](mailto:a@example.test) [media](cindy-media://blobs/a) [web](https://example.test/report.pdf)';
    expect(await prepareChatReplyFiles(text, 'lane', () => {})).toEqual({ text, attachments: [] });
  });

  it('rejects remote xdt-file metadata even when its path exists locally', async () => {
    const url = `xdt-file://local/?path=${encodeURIComponent(pdf)}&remoteHostId=other-host`;
    await expect(prepareChatReplyFiles(`[report](${url})`, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('handles escaped relative links but still rejects traversal and missing files', async () => {
    const result = await prepareChatReplyFiles('[report](&lt;report 中文.pdf&gt;)', 'lane', () => {});
    expect((await result.attachments[0]!.readBytes!()).toString()).toContain('%PDF');
    await expect(prepareChatReplyFiles('[private](documents/../../private.pdf)', 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    const missing = await prepareChatReplyFiles('[missing](documents/missing.pdf)', 'lane', () => {});
    await expect(missing.attachments[0]!.readBytes!()).rejects.toThrow();
  });

  it('does not access session scope for ordinary text, remote links, fenced examples or images', async () => {
    scope.snapshot = null;
    const text = '```md\n[example](./x.pdf)\n```\n![img](cindy-media://blobs/example.png)\n[web](https://example.test)';
    expect(await prepareChatReplyFiles(text, 'lane', () => { throw new Error('unexpected'); })).toEqual({ text, attachments: [] });
  });

  it.each(['../private.pdf', 'file://server/private.pdf', 'file://server/100% done.pdf', 'file://user:secret@localhost/100% done.pdf', '//server/private.pdf'])('refuses an out-of-scope or network file %s', async url => {
    await expect(prepareChatReplyFiles(`[file](<${url}>)`, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('refuses a symlink escaping the task before reading its bytes', async () => {
    const link = path.join(work, 'escape');
    // A real directory junction also works on unprivileged Windows runners.
    await fs.symlink(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const result = await prepareChatReplyFiles('[file](./escape/private.pdf)', 'lane', () => {});
      await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    } finally { await fs.unlink(link); }
  });

  it('refuses an in-task hard link to an outside file before returning bytes', async () => {
    const link = path.join(work, 'hard-link.pdf');
    await fs.link(path.join(root, 'private.pdf'), link);
    try {
      const result = await prepareChatReplyFiles('[file](./hard-link.pdf)', 'lane', () => {});
      await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    } finally { await fs.unlink(link); }
  });

  it('refuses a new hard link created after the descriptor checks', async () => {
    const alias = path.join(root, 'during-read.pdf');
    let checks = 0;
    try {
      await expect(readReplyFile(pdf, work, () => {
        if (++checks === 2) linkSync(pdf, alias);
      })).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    } finally { await fs.rm(alias, { force: true }); }
  });

  it.each([':42', ':42:3', ':42-50', '#L42', '#L42-L50'])('delivers line-located file links %s once alongside a PDF', async suffix => {
    const source = path.join(work, 'source.ts');
    await fs.writeFile(source, 'export const answer = 42;');
    const result = await prepareChatReplyFiles(`[source](source.ts${suffix}) [again](./source.ts) [PDF](<${pdf}>)`, 'lane', () => {});
    expect(result.text).toBe('source again PDF');
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0]!.name).toBe('source.ts');
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('export const answer = 42;');
    expect((await result.attachments[1]!.readBytes!()).toString()).toContain('%PDF');
  });

  it('preserves literal line-like filenames in encoded file URLs and explicit query paths', async () => {
    const source = path.join(work, 'report#L42');
    await fs.writeFile(source, 'literal filename');
    const result = await prepareChatReplyFiles(`[file](${pathToFileURL(source).href}) [query](xdt-file://local/?path=${encodeURIComponent(source)})`, 'lane', () => {});
    expect(result.attachments).toHaveLength(1);
    expect((await result.attachments[0]!.readBytes!()).toString()).toBe('literal filename');
  });

  it.each([{ remoteHostId: 'ssh-host' }, { status: 'deleted' }, { workingDir: null }])('refuses a task without local authority %j', async change => {
    Object.assign(scope.row, change);
    await expect(prepareChatReplyFiles('[file](./report.pdf)', 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('rechecks ownership, task clearing and the execution after preparation', async () => {
    let valid = true;
    const result = await prepareChatReplyFiles(`[file](<${pdf}>)`, 'lane', () => { if (!valid) throw new Error('STALE_EXECUTOR'); });
    scope.row.clearedAt = 1;
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    scope.row.clearedAt = null;
    valid = false;
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('STALE_EXECUTOR');
    valid = true; scope.snapshot = null;
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('OWNER_CHANGED');
  });

  it('refuses changed bytes on retry instead of uploading a second version under the same reply', async () => {
    const result = await prepareChatReplyFiles(`[file](<${pdf}>)`, 'lane', () => {});
    const first = await result.attachments[0]!.readBytes!();
    expect(await result.attachments[0]!.readBytes!()).toEqual(first);
    await fs.writeFile(pdf, '%PDF-1.4\nchanged');
    await expect(result.attachments[0]!.readBytes!()).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });

  it('refuses too many files, empty files and directories', async () => {
    const text = Array.from({ length: 21 }, (_, i) => `[file](./${i}.pdf)`).join('\n');
    await expect(prepareChatReplyFiles(text, 'lane', () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    await fs.writeFile(pdf, '');
    await expect(readReplyFile(pdf, work, () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
    await expect(readReplyFile(work, root, () => {})).rejects.toThrow('ATTACHMENT_UNAVAILABLE');
  });
});
