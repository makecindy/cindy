import path from 'node:path';
import {utilityProcess} from 'electron';
import {createDocsOutputWriter,type createDocsOutputWriterHost} from '@cindy/app-runtime/docsOutputWriter';
type DocsOutputWriterChildLike=ReturnType<createDocsOutputWriterHost['fork']>;


function forkDocsOutputWriter(rootDir: string): DocsOutputWriterChildLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return utilityProcess.fork(path.join(__dirname, 'docsOutputWriterUtilityProcess.js'), [], {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    serviceName: 'cindy-docs-output-writer',
  });
}
const runtime=createDocsOutputWriter({fork:forkDocsOutputWriter});
export const {writeDocsOutput}=runtime;
