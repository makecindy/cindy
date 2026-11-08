import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSkillEmbeddingAdapter } from './embedding.js';
import { discoverySkill, loadIndex, readConfig, readSkill, syncLibrary, syncLibraryUnlocked, withLibraryWrite, writeJson, type LibraryConfig } from './library.js';

export const HELP = `cindy-skill-index — task-driven local Skill discovery

init      --library <directory> --source <skill-root> [--source <another-root>]
add       --library <directory> --source <skill-root>
sync      --library <directory> [--rebuild]
search    --library <directory> --query <task> [--limit <number>]
read      --library <directory> --id <skill-id> [--offset <number> --sha256 <hash>] [--chars <number>]
embedding --library <directory> --base-url <URL> --model <model> --key-env <variable> [--dimensions <number>]
embedding --library <directory> --off
gateway   --library <directory> --output <skill-folder> [--name <skill-name>]

Keep library data and source Skills outside native auto-discovery roots.
Install only the generated gateway in Cindy's shared .agents/skills directory.
API keys are read from the selected environment variable, never written to the library.
`;

export async function runCli(args: string[], executable: string): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      help: { type: 'boolean' }, library: { type: 'string' }, source: { type: 'string', multiple: true },
      query: { type: 'string' }, limit: { type: 'string' }, id: { type: 'string' },
      offset: { type: 'string' }, chars: { type: 'string' }, sha256: { type: 'string' },
      output: { type: 'string' }, name: { type: 'string' },
      'base-url': { type: 'string' }, model: { type: 'string' }, 'key-env': { type: 'string' },
      dimensions: { type: 'string' }, off: { type: 'boolean' }, rebuild: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length === 0) return HELP;
  if (positionals.length !== 1) throw new Error('Pass one command; put the task text in --query');
  const required = (value: string | undefined, option: string): string => {
    if (!value?.trim()) throw new Error(`Missing --${option}`);
    return value;
  };
  const integer = (value: string | undefined, option: string): number | undefined => {
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`--${option} must be a non-negative integer`);
    return number;
  };
  const library = path.resolve(required(values.library, 'library'));
  const configPath = path.join(library, 'library.json');
  const command = positionals[0];

  if (command === 'init' || command === 'add') {
    if (!values.source?.length) throw new Error('Specify at least one --source directory');
    const sources = await Promise.all(values.source.map(async directory => {
      const sourcePath = await fs.realpath(path.resolve(directory));
      if (!(await fs.stat(sourcePath)).isDirectory()) throw new Error(`Source must be a directory: ${directory}`);
      return { name: path.basename(sourcePath), path: sourcePath };
    }));
    return withLibraryWrite(library, async () => {
      if (command === 'init') {
        const config: LibraryConfig = { version: 1, sources };
        await fs.mkdir(library, { recursive: true });
        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } else {
        const config = await readConfig(library);
        for (const source of sources) {
          if (!config.sources.some(existing => existing.path === source.path)) config.sources.push(source);
        }
        await writeJson(configPath, config);
      }
      return syncLibraryUnlocked(library);
    });
  }
  if (command === 'sync') return syncLibrary(library, { rebuild: values.rebuild });
  if (command === 'embedding') {
    return withLibraryWrite(library, async () => {
      const config = await readConfig(library);
      if (values.off) delete config.embedding;
      else {
        config.embedding = {
          baseUrl: required(values['base-url'], 'base-url'), model: required(values.model, 'model'),
          apiKeyEnv: required(values['key-env'], 'key-env'),
          ...(values.dimensions ? { dimensions: integer(values.dimensions, 'dimensions') } : {}),
        };
        // Resolve the configuration before persisting it; no request is made here.
        createSkillEmbeddingAdapter(config.embedding);
      }
      await writeJson(configPath, config);
      return syncLibraryUnlocked(library);
    });
  }
  if (command === 'search') {
    const config = await readConfig(library);
    const index = await loadIndex(library);
    return index.search(required(values.query, 'query'), {
      limit: integer(values.limit, 'limit'),
      ...(config.embedding ? { embedding: createSkillEmbeddingAdapter(config.embedding) } : {}),
    });
  }
  if (command === 'read') return readSkill(await loadIndex(library), required(values.id, 'id'), {
    offset: integer(values.offset, 'offset'), chars: integer(values.chars, 'chars'), expectedSha256: values.sha256,
  });
  if (command === 'gateway') {
    await readConfig(library);
    const output = path.resolve(required(values.output, 'output'));
    const content = discoverySkill(library, path.resolve(executable), values.name);
    await fs.mkdir(output, { recursive: true });
    const filePath = path.join(output, 'SKILL.md');
    await fs.writeFile(filePath, content, { flag: 'wx' });
    return { filePath, library };
  }
  throw new Error(`Unknown command: ${command}. Use --help.`);
}
