import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';

import {
  codexGlobalPluginsPaths,
  prepareCodexGlobalPluginsBridge,
  writeFileAtomicIfUnchanged,
} from '../maker-host/codex-global-plugins';

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-global-plugins-'));
  tmpDirs.push(dir);
  return dir;
}

/** 造一个 marketplace 缓存目录: <cache>/<marketplace>/<plugin>/<version>/plugin.json */
async function writePluginCache(
  cacheDir: string,
  marketplace: string,
  plugin: string,
  version = '1.0.0',
): Promise<void> {
  const dir = path.join(cacheDir, marketplace, plugin, version);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), `{"name":"${plugin}"}`, 'utf8');
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(ra) === normalize(rb);
}

function pluginsTableOf(tomlText: string): Record<string, unknown> {
  const parsed = parseToml(tomlText) as Record<string, unknown>;
  return (parsed['plugins'] as Record<string, unknown> | undefined) ?? {};
}

interface SetupResult {
  homeDir: string;
  codexHome: string;
  paths: ReturnType<typeof codexGlobalPluginsPaths>;
}

async function setup(): Promise<SetupResult> {
  const root = await makeTmpDir();
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(root, 'xdt-codex-home');
  await fs.mkdir(homeDir, { recursive: true });
  return { homeDir, codexHome, paths: codexGlobalPluginsPaths(codexHome, homeDir) };
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('prepareCodexGlobalPluginsBridge', () => {
  it('links marketplace cache dirs and appends missing [plugins] entries', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await writePluginCache(paths.sourceCacheDir, 'team-mkt', 'team-plugin');
    await fs.writeFile(
      paths.sourceConfigFile,
      [
        'model = "gpt-5.5"',
        '',
        '[plugins."superpowers@superpowers-dev"]',
        'enabled = true',
        '',
        '[plugins."team-plugin@team-mkt"]',
        'enabled = false',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.addedPluginEntries.sort()).toEqual([
      'superpowers@superpowers-dev',
      'team-plugin@team-mkt',
    ]);
    expect(
      await sameRealPath(
        path.join(paths.cacheDir, 'superpowers-dev'),
        path.join(paths.sourceCacheDir, 'superpowers-dev'),
      ),
    ).toBe(true);

    const destText = await fs.readFile(paths.configFile, 'utf8');
    // 新建的 config 不应以空行开头(与 codex 原生写出的格式一致)
    expect(destText.startsWith('\n')).toBe(false);
    const plugins = pluginsTableOf(destText);
    expect(plugins['superpowers@superpowers-dev']).toEqual({ enabled: true });
    expect(plugins['team-plugin@team-mkt']).toEqual({ enabled: false });
  });

  it('is idempotent: second run changes nothing and appends no duplicates', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );

    await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });
    const firstText = await fs.readFile(paths.configFile, 'utf8');
    const second = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(second.changed).toBe(false);
    expect(second.addedPluginEntries).toEqual([]);
    await expect(fs.readFile(paths.configFile, 'utf8')).resolves.toBe(firstText);
  });

  it('never overwrites an existing entry in the isolated config', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      paths.configFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = false\n',
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.addedPluginEntries).toEqual([]);
    const plugins = pluginsTableOf(await fs.readFile(paths.configFile, 'utf8'));
    expect(plugins['superpowers@superpowers-dev']).toEqual({ enabled: false });
  });

  it('preserves existing isolated config content when appending', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );
    await fs.mkdir(codexHome, { recursive: true });
    const existing = "[projects.'D:\\workspace\\demo']\ntrust_level = \"trusted\"\n";
    await fs.writeFile(paths.configFile, existing, 'utf8');

    await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    const destText = await fs.readFile(paths.configFile, 'utf8');
    expect(destText.startsWith(existing)).toBe(true);
    const parsed = parseToml(destText) as Record<string, unknown>;
    expect(parsed['projects']).toBeDefined();
    expect(pluginsTableOf(destText)['superpowers@superpowers-dev']).toEqual({ enabled: true });
  });

  it('keeps a real (codex-managed) marketplace dir intact as an expected conflict', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'openai-curated-remote', 'atlassian-rovo');
    const realDir = path.join(paths.cacheDir, 'openai-curated-remote');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'keep.txt'), 'do not remove', 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    const entry = result.marketplaces.find((m) => m.name === 'openai-curated-remote');
    expect(entry?.status).toBe('conflict');
    // conflict 是稳态,不应该刷 warning
    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(path.join(realDir, 'keep.txt'), 'utf8')).resolves.toBe(
      'do not remove',
    );
  });

  it('removes a dangling managed link when its source marketplace disappears', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');

    await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });
    const link = path.join(paths.cacheDir, 'superpowers-dev');
    expect(await sameRealPath(link, path.join(paths.sourceCacheDir, 'superpowers-dev'))).toBe(true);

    await fs.rm(path.join(paths.sourceCacheDir, 'superpowers-dev'), {
      recursive: true,
      force: true,
    });
    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(true);
    await expect(fs.lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips plugin entries whose marketplace has no cache dir', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      [
        '[plugins."superpowers@superpowers-dev"]',
        'enabled = true',
        '',
        // openai-bundled 的缓存不在 plugins/cache 下(bundled snapshot 随 home 自愈),不桥接
        '[plugins."sites@openai-bundled"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.addedPluginEntries).toEqual(['superpowers@superpowers-dev']);
    const plugins = pluginsTableOf(await fs.readFile(paths.configFile, 'utf8'));
    expect(plugins['sites@openai-bundled']).toBeUndefined();
  });

  it('is a no-op when the user has no ~/.codex plugins at all', async () => {
    const { homeDir, codexHome, paths } = await setup();

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.changed).toBe(false);
    expect(result.marketplaces).toEqual([]);
    expect(result.addedPluginEntries).toEqual([]);
    expect(result.warnings).toEqual([]);
    await expect(fs.lstat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still links caches but skips entry sync when the user config is unparsable', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(paths.sourceConfigFile, '[plugins."broken\n= oops', 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(
      await sameRealPath(
        path.join(paths.cacheDir, 'superpowers-dev'),
        path.join(paths.sourceCacheDir, 'superpowers-dev'),
      ),
    ).toBe(true);
    expect(result.addedPluginEntries).toEqual([]);
    expect(result.warnings.some((w) => w.includes('cannot read user codex config'))).toBe(true);
  });

  it('refuses to clobber a config modified after the merge snapshot (concurrent writer)', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'config.toml');
    await fs.writeFile(file, 'model = "a"\n', 'utf8');
    // 快照(expectedText)是旧内容,但文件已被"并发写入者"改成新内容
    const snapshot = 'model = "a"\n';
    await fs.writeFile(file, 'model = "a"\n\n[projects.x]\ntrust_level = "trusted"\n', 'utf8');

    const applied = await writeFileAtomicIfUnchanged(file, `${snapshot}\n[plugins."p@m"]\nenabled = true\n`, snapshot);

    expect(applied).toBe(false);
    // 并发写入者的内容原样保留,tmp 文件不残留
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(
      'model = "a"\n\n[projects.x]\ntrust_level = "trusted"\n',
    );
    const leftovers = (await fs.readdir(root)).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('applies the write when the config still matches the merge snapshot', async () => {
    const root = await makeTmpDir();
    const file = path.join(root, 'config.toml');
    const snapshot = 'model = "a"\n';
    await fs.writeFile(file, snapshot, 'utf8');

    const next = `${snapshot}\n[plugins."p@m"]\nenabled = true\n`;
    const applied = await writeFileAtomicIfUnchanged(file, next, snapshot);

    expect(applied).toBe(true);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(next);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a restrictive file mode across the atomic replace (POSIX)',
    async () => {
      const root = await makeTmpDir();
      const file = path.join(root, 'config.toml');
      const snapshot = 'model = "a"\n';
      await fs.writeFile(file, snapshot, 'utf8');
      await fs.chmod(file, 0o600);

      const applied = await writeFileAtomicIfUnchanged(file, `${snapshot}x = 1\n`, snapshot);

      expect(applied).toBe(true);
      const mode = (await fs.stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it('never appends when the isolated config itself is unparsable', async () => {
    const { homeDir, codexHome, paths } = await setup();
    await writePluginCache(paths.sourceCacheDir, 'superpowers-dev', 'superpowers');
    await fs.writeFile(
      paths.sourceConfigFile,
      '[plugins."superpowers@superpowers-dev"]\nenabled = true\n',
      'utf8',
    );
    await fs.mkdir(codexHome, { recursive: true });
    const broken = '[plugins."half\n';
    await fs.writeFile(paths.configFile, broken, 'utf8');

    const result = await prepareCodexGlobalPluginsBridge(codexHome, { homeDir });

    expect(result.addedPluginEntries).toEqual([]);
    expect(
      result.warnings.some((w) => w.includes('cannot parse isolated codex config')),
    ).toBe(true);
    await expect(fs.readFile(paths.configFile, 'utf8')).resolves.toBe(broken);
  });
});
