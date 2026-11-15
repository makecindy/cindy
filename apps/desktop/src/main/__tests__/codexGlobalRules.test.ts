import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';

import {
  CODEX_GLOBAL_RULES_MARKER_FILE_NAME,
  codexGlobalRulesPaths,
  prepareCodexGlobalRulesCopy,
} from '../maker-host/codex-global-rules';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-rules-'));
  tmpDirs.push(dir);
  return dir;
}

async function setupPaths(managedHome = 'xdt-codex-home') {
  const root = await makeTmpDir();
  const homeDir = path.join(root, 'home with spaces 中文#% &copy;');
  const codexHome = path.join(root, managedHome);
  return { homeDir, ...codexGlobalRulesPaths(codexHome, homeDir) };
}

function ruleLinks(document: string): string[] {
  const urls: string[] = [];
  visit(unified().use(remarkParse).parse(document), (node) => {
    if (node.type === 'link' || node.type === 'definition') urls.push(node.url);
  });
  return urls;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function writeMarker(markerFile: string): Promise<void> {
  await fs.mkdir(path.dirname(markerFile), { recursive: true });
  await fs.writeFile(markerFile, '');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalRulesCopy', () => {
  it('case 1: noops when source, destination, and marker are all missing', async () => {
    const paths = await setupPaths();

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('missing');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(await exists(paths.managedRulesFile)).toBe(false);
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 2: removes an orphan marker when source and destination are missing', async () => {
    const paths = await setupPaths();
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('marker-removed');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await exists(paths.managedRulesFile)).toBe(false);
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 3: keeps an unmarked destination when source is missing', async () => {
    const paths = await setupPaths();
    await writeFile(paths.managedRulesFile, 'user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('user-kept');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 4: removes the managed destination and marker when source is missing', async () => {
    const paths = await setupPaths();
    await writeFile(paths.managedRulesFile, 'managed rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('removed');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await exists(paths.managedRulesFile)).toBe(false);
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 5: copies source to an empty custom CODEX_HOME and writes the marker', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'global user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('copied');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('global user rules');
    expect(await exists(paths.markerFile)).toBe(true);
    expect(path.basename(paths.markerFile)).toBe(CODEX_GLOBAL_RULES_MARKER_FILE_NAME);
  });

  it('case 6: clears an orphan marker before copying source rules', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'global user rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('copied');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('global user rules');
    expect(await exists(paths.markerFile)).toBe(true);
  });

  it('case 7: keeps an unmarked destination even when source exists', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'global user rules');
    await writeFile(paths.managedRulesFile, 'local user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('user-kept');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('local user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('case 8: keeps an unchanged managed destination', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'same rules');
    await writeFile(paths.managedRulesFile, 'same rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('kept');
    expect(result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('same rules');
    expect(await exists(paths.markerFile)).toBe(true);
  });

  it('case 9: updates a changed managed destination from source', async () => {
    const paths = await setupPaths();
    await writeFile(paths.sourceRulesFile, 'new global rules');
    await writeFile(paths.managedRulesFile, 'old managed rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('updated');
    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('new global rules');
    expect(await exists(paths.markerFile)).toBe(true);
  });

  it.each(['xdt-codex-home', path.join('codex-accounts', 'secondary')])(
    'keeps referenced documents readable after importing rules into %s', async (managedHome) => {
    const paths = await setupPaths(managedHome);
    const nativeHome = path.dirname(paths.sourceRulesFile);
    const executionRules = 'execution rules\n[Next](nested/next.md)\n';
    const document = '\uFEFF' + [
      '# Global rules',
      '[**Execution**](guides/execution.md "Required")',
      '[](./guides/execution.md)',
      '[Spaces](<guides/协作 notes.md#checks>)',
      '[Parent](../shared/notes%23one.md?view=1&mode=full#checks)',
      '[Escaped](guides/check\\(one\\).md)',
      '[Percent](guides/100%.md)',
      '[Encoded percent](guides/literal%2523.md)',
      '[Entity](guides/a&#38;b.md)',
      '[Literal entity](guides/literal&amp;copy;.md)',
      '[Label with `](` inside](guides/execution.md)',
      '[Reference][guide]',
      '[Literal reference][literal]',
      '[guide][] and [guide]',
      '',
      '[guide]: guides/execution.md "Reference title"',
      '[literal]: guides/literal&amp;copy;.md',
      '',
      '> [Quoted][quoted]',
      '>',
      '> [quoted]:',
      ">   <guides/execution.md> 'Quoted title'",
      '',
    ].join('\r\n');
    await writeFile(paths.sourceRulesFile, document);
    await fs.chmod(paths.sourceRulesFile, 0o600);
    await writeFile(path.join(nativeHome, 'guides/execution.md'), executionRules);
    await writeFile(path.join(nativeHome, 'guides/nested/next.md'), '[Leaf](../leaf.md)');
    await writeFile(path.join(nativeHome, 'guides/leaf.md'), 'deep rules');
    await writeFile(path.join(nativeHome, 'guides/协作 notes.md'), 'collaboration rules');
    await writeFile(path.join(nativeHome, '../shared/notes#one.md'), 'shared rules');
    await writeFile(path.join(nativeHome, 'guides/check(one).md'), 'check rules');
    await writeFile(path.join(nativeHome, 'guides/100%.md'), 'literal percent');
    await writeFile(path.join(nativeHome, 'guides/literal%23.md'), 'encoded percent');
    await writeFile(path.join(nativeHome, 'guides/a&b.md'), 'entity rules');
    await writeFile(path.join(nativeHome, 'guides/literal&copy;.md'), 'literal entity rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });
    const imported = await fs.readFile(paths.managedRulesFile, 'utf8');
    const urls = ruleLinks(imported);

    expect(result.status).toBe('copied');
    expect(urls).toHaveLength(13);
    expect((await fs.stat(paths.managedRulesFile)).mode & 0o777)
      .toBe((await fs.stat(paths.sourceRulesFile)).mode & 0o777);
    const contents = await Promise.all(urls.map((url) =>
      fs.readFile(fileURLToPath(new URL(url, pathToFileURL(paths.managedRulesFile))), 'utf8'),
    ));
    expect(contents).toEqual([
      executionRules, executionRules, 'collaboration rules', 'shared rules', 'check rules',
      'literal percent', 'encoded percent', 'entity rules', 'literal entity rules',
      executionRules, executionRules, 'literal entity rules', executionRules,
    ]);
    const nextUrl = new URL(ruleLinks(contents[0])[0], urls[0]);
    const next = await fs.readFile(fileURLToPath(nextUrl), 'utf8');
    const leafUrl = new URL(ruleLinks(next)[0], nextUrl);
    await expect(fs.readFile(fileURLToPath(leafUrl), 'utf8')).resolves.toBe('deep rules');
    expect(urls[2]).toMatch(/#checks$/);
    expect(urls[3]).toMatch(/\?view=1&mode=full#checks$/);
    expect(imported.startsWith('\uFEFF# Global rules\r\n')).toBe(true);
    expect(imported).toContain('[**Execution**](');
    expect(imported).toContain(' "Required")\r\n');
    expect(imported).toContain('[Reference][guide]\r\n');
    expect(imported).toContain(' "Reference title"\r\n');
    expect(imported).toContain(" 'Quoted title'\r\n");
    await expect(fs.readFile(paths.sourceRulesFile, 'utf8')).resolves.toBe(document);
    expect(await exists(path.join(paths.codexHome, 'guides'))).toBe(false);
  });

  it('leaves absolute links, anchors and code examples unchanged', async () => {
    const paths = await setupPaths();
    const document = [
      '[Web](https://example.com/rules)',
      '[File](file:///tmp/rules.md)',
      '[POSIX](/opt/rules.md)',
      '[Windows](C:/rules.md)',
      '[UNC](//server/share/rules.md)',
      '[Home](~/guides/rules.md)',
      '[Anchor](#local)',
      '[Query](?view=1)',
      '[Empty]()',
      'guides/plain-path.md',
      '[Malformed](guides/unescaped space.md)',
      '`[Inline](guides/example.md)`',
      '```md',
      '[Fenced](guides/example.md)',
      '[fenced]: guides/example.md',
      '```',
      '',
      '    [Indented](guides/example.md)',
      '',
      '<!-- [Comment](guides/example.md) -->',
      '',
    ].join('\n');
    await writeFile(paths.sourceRulesFile, document);

    await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe(document);
  });

  it('upgrades old managed copies and keeps generated links stable across refreshes', async () => {
    const paths = await setupPaths();
    const document = '[Execution](guides/execution.md)\n';
    await writeFile(paths.sourceRulesFile, document);
    await writeFile(paths.managedRulesFile, document);
    await writeMarker(paths.markerFile);

    const upgraded = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });
    const imported = await fs.readFile(paths.managedRulesFile, 'utf8');
    const refreshed = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(upgraded.status).toBe('updated');
    expect(imported).not.toBe(document);
    expect(refreshed.status).toBe('kept');
    expect(refreshed.changed).toBe(false);
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe(imported);

    await writeFile(paths.sourceRulesFile, '[Other](guides/other.md)\n');
    await fs.chmod(paths.sourceRulesFile, 0o640);
    const referencedFile = path.join(path.dirname(paths.sourceRulesFile), 'guides/other.md');
    await writeFile(referencedFile, 'new rules');
    const changed = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });
    expect(changed.status).toBe('updated');
    expect((await fs.stat(paths.managedRulesFile)).mode & 0o777)
      .toBe((await fs.stat(paths.sourceRulesFile)).mode & 0o777);
    const target = fileURLToPath(ruleLinks(await fs.readFile(paths.managedRulesFile, 'utf8'))[0]);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('new rules');

    await writeFile(referencedFile, 'updated reference');
    const unchanged = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });
    expect(unchanged.status).toBe('kept');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('updated reference');
  });

  it('does not overwrite or delete an unmarked destination across source states', async () => {
    const paths = await setupPaths();
    await writeFile(paths.managedRulesFile, 'local user rules');

    await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });
    await writeFile(paths.sourceRulesFile, 'global user rules');
    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('user-kept');
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('local user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('warns without touching destination when source exists but is not a file', async () => {
    const paths = await setupPaths();
    await fs.mkdir(paths.sourceRulesFile, { recursive: true });
    await writeFile(paths.managedRulesFile, 'local user rules');

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('error');
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toContain('source is not a file');
    await expect(fs.readFile(paths.managedRulesFile, 'utf8')).resolves.toBe('local user rules');
    expect(await exists(paths.markerFile)).toBe(false);
  });

  it('warns without recursively deleting a managed destination directory', async () => {
    const paths = await setupPaths();
    await fs.mkdir(paths.managedRulesFile, { recursive: true });
    await writeFile(path.join(paths.managedRulesFile, 'keep.txt'), 'do not remove');
    await writeFile(paths.sourceRulesFile, 'global user rules');
    await writeMarker(paths.markerFile);

    const result = await prepareCodexGlobalRulesCopy(paths.codexHome, { homeDir: paths.homeDir });

    expect(result.status).toBe('error');
    expect(result.changed).toBe(false);
    expect(result.warnings[0]).toContain('destination is not a file');
    await expect(fs.readFile(path.join(paths.managedRulesFile, 'keep.txt'), 'utf8')).resolves.toBe('do not remove');
    expect(await exists(paths.markerFile)).toBe(true);
  });
});
