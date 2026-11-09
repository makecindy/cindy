import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { CINDY_SUBAGENT_RUNNER_SOURCE } from '../cindy-subagent-runner-source.js';

const require = createRequire(import.meta.url);
let entryUrl: Promise<string> | undefined;

function moduleUrl(text: string): string {
  return 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
}

/** Real host entry and parser in Node fixtures, without Electron or a second parser. */
function runtimeEntryUrl(): Promise<string> {
  entryUrl ??= (async () => {
    const compile = (text: string) => ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const parser = compile(await readFile(new URL('../hy4-inline-thinking.ts', import.meta.url), 'utf8'))
      .replace(/from '([^']+)'/g, (_match, specifier: string) =>
        'from ' + JSON.stringify(pathToFileURL(require.resolve(specifier)).href));
    const entry = compile(await readFile(new URL('../pi-subagent-runner-entry.ts', import.meta.url), 'utf8'))
      .replace("'./hy4-inline-thinking.js'", JSON.stringify(moduleUrl(parser)));
    return moduleUrl(entry);
  })();
  return entryUrl;
}

export async function subagentRunnerFixtureSource(): Promise<string> {
  return CINDY_SUBAGENT_RUNNER_SOURCE + '\nimport(' + JSON.stringify(await runtimeEntryUrl())
    + ').then(entry => entry.startPiSubagentRunner(module.exports));\n';
}

/** Node stand-in for the fixed Electron utility entry, loading the actual staged file. */
export async function subagentRunnerFixtureBootstrap(): Promise<string> {
  return 'import(' + JSON.stringify(await runtimeEntryUrl())
    + ').then(entry => entry.startPiSubagentRunner(require(process.argv[1])));';
}
