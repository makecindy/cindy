import os from 'node:os';
import path from 'node:path';
import {utilityProcess} from 'electron';
import {createReviewPdfProcess,type ReviewPdfUtilityChildLike} from '@cindy/app-runtime/reviewPdfProcess';
export type {ReviewPdfInspectProcessResult,ReviewPdfPageInspection,ReviewPdfTextProcessResult} from '@cindy/app-runtime/reviewPdfProcess';


function forkReviewPdfUtilityProcess(): ReviewPdfUtilityChildLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return utilityProcess.fork(path.join(__dirname, 'reviewPdfUtilityProcess.js'), [], {
    serviceName: 'cindy-review-pdf-extractor',
    env,
    cwd: os.tmpdir(),
    execArgv: ['--max-old-space-size=128', '--max-semi-space-size=8'],
    stdio: 'ignore',
  });
}
const runtime=createReviewPdfProcess({fork:forkReviewPdfUtilityProcess});
export const {extractReviewPdfTextInChild,inspectPdfPagesInChild}=runtime;
export type {ReviewPdfUtilityChildLike,ReviewPdfTextProcessOptions,ReviewPdfInspectProcessOptions} from '@cindy/app-runtime/reviewPdfProcess';
