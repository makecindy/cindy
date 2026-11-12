#!/usr/bin/env node
// Explicit live-model evaluation; never part of ordinary unit tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  validateCorpus,
  validResponse,
  scoreActions,
  aggregate,
} from './shared/voice-dictionary-eval.mjs';

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
    adapter: { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
    repeats: { type: 'string', default: '3' },
    advisor: { type: 'string' },
    split: { type: 'string' },
    help: { type: 'boolean' },
    concurrency: { type: 'string', default: '2' },
    'retry-from': { type: 'string' },
  },
});
if (values.help) {
  console.log(
    'node --experimental-strip-types scripts/voice-input-dictionary-eval.mjs --cases FILE --adapter MODULE --model ID --out NEW_DIRECTORY [--repeats 3] [--split dev] [--advisor BASELINE.ts] [--concurrency 2] [--retry-from PREVIOUS_DIRECTORY]',
  );
  process.exit(0);
}
if (!values.cases || !values.adapter || !values.model || !values.out)
  throw new Error('Missing required arguments; see --help');
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error('repeats must be 1–10');
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
  throw new Error('concurrency must be 1–3');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(values.out);
const relative = path.relative(
  await fs.realpath(root),
  path.join(await fs.realpath(path.dirname(out)), path.basename(out)),
);
if (!relative.startsWith(`..${path.sep}`) && relative !== '..')
  throw new Error('Results must be outside this repository');
const corpusText = await fs.readFile(values.cases, 'utf8');
const corpus = validateCorpus(JSON.parse(corpusText));
const cases = corpus.cases.filter((sample) => !values.split || sample.split === values.split);
if (!cases.length) throw new Error('No cases selected');
const advisorPath = path.resolve(
  values.advisor ?? path.join(root, 'packages/voice-input-core/src/DictationDictionaryAdvisor.ts'),
);
const advisorModule = await import(pathToFileURL(advisorPath));
const { requestJson } = await import(pathToFileURL(path.resolve(values.adapter)));
if (typeof requestJson !== 'function') throw new Error('Adapter must export requestJson(request)');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const advisorSha256 = sha(await fs.readFile(advisorPath));
const adapterSha256 = sha(await fs.readFile(values.adapter));
const scorerPath = path.join(root, 'scripts/shared/voice-dictionary-eval.mjs');
const scorerSha256 = sha(await fs.readFile(scorerPath));
const priorDir = values['retry-from'] && path.resolve(values['retry-from']);
if (priorDir) {
  const prior = JSON.parse(await fs.readFile(path.join(priorDir, 'manifest.json')));
  if (
    prior.corpusSha256 !== sha(corpusText) ||
    prior.advisorSha256 !== advisorSha256 ||
    prior.model !== values.model ||
    prior.repeats !== repeats ||
    prior.split !== (values.split ?? 'all') ||
    prior.adapterSha256 !== adapterSha256 ||
    prior.scorerSha256 !== scorerSha256
  ) {
    throw new Error(
      'Retry requires identical corpus, advisor, adapter, scorer, model, repeats and split',
    );
  }
}
await fs.mkdir(out); // Existing output is immutable: choose a new directory.
await fs.writeFile(path.join(out, 'corpus.json'), corpusText);
await fs.copyFile(advisorPath, path.join(out, 'Advisor.snapshot.ts'));
await fs.copyFile(scorerPath, path.join(out, 'scorer.snapshot.mjs'));
await fs.writeFile(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      corpusId: corpus.id,
      corpusSha256: sha(corpusText),
      advisorSha256,
      promptVersion: advisorModule.DEFAULT_DICTATION_DICTIONARY_ADVISOR_PROMPT_VERSION,
      promptSha256: sha(advisorModule.DEFAULT_DICTATION_DICTIONARY_ADVISOR_SYSTEM_PROMPT),
      adapterSha256,
      model: values.model,
      repeats,
      split: values.split ?? 'all',
      scorerSha256,
      concurrency,
      retryFrom: priorDir ?? null,
    },
    null,
    2,
  ),
);
const rows = [];
const jobs = Array.from({ length: repeats }, (_, repeat) =>
  cases.map((sample) => ({ sample, repeat: repeat + 1 })),
).flat();
let cursor = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < jobs.length) {
      const { sample, repeat } = jobs[cursor++];
      const row = { caseId: sample.id, repeat, category: sample.category, split: sample.split };
      if (priorDir) {
        const prior = JSON.parse(
          await fs.readFile(path.join(priorDir, `${sample.id}-${repeat}.json`)),
        );
        if (prior.caseId !== sample.id || prior.repeat !== repeat)
          throw new Error('Retry row identity mismatch');
        // Schema failures and semantic errors are model outcomes, not transport retries.
        if (!prior.error || prior.validSchema === false) {
          Object.assign(row, prior, {
            reusedFrom: priorDir,
            rawScore: scoreActions(sample, prior.response?.actions),
            acceptedScore: scoreActions(sample, prior.accepted),
          });
          rows.push(row);
          await fs.writeFile(
            path.join(out, `${sample.id}-${repeat}.json`),
            JSON.stringify(row, null, 2),
          );
          continue;
        }
        row.initialResult = prior.initialResult ?? prior;
        row.previousAttempt = {
          directory: priorDir,
          error: prior.error,
          validSchema: prior.validSchema,
        };
      }
      const advisor = new advisorModule.DictationDictionaryAdvisor({
        model: values.model,
        client: {
          async requestJson(request) {
            // Adapter envelope is deliberate: raw model JSON and metadata remain inspectable.
            const result = await requestJson(request);
            row.response = result.value;
            row.rawText = result.rawText;
            row.metadata = result.metadata;
            row.validSchema = validResponse(result.value);
            return result.value;
          },
        },
      });
      const started = performance.now();
      try {
        row.skipReason = advisorModule.getDictationDictionaryAdviceSkipReason(sample.input);
        row.accepted = (await advisor.advise(sample.input)).actions;
      } catch (error) {
        // Do not persist provider errors which might contain headers or credential-bearing URLs.
        row.error =
          error?.name === 'AbortError'
            ? 'timeout'
            : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
              ? `http_${error.status}`
              : 'request_or_advisor_failed';
        row.accepted = [];
      }
      row.elapsedMs = Math.round(performance.now() - started);
      row.rawScore = scoreActions(sample, row.response?.actions);
      row.acceptedScore = scoreActions(sample, row.accepted);
      rows.push(row);
      await fs.writeFile(
        path.join(out, `${sample.id}-${repeat}.json`),
        JSON.stringify(row, null, 2),
      );
      if (rows.length % 10 === 0 || rows.length === jobs.length)
        console.log(`${rows.length}/${jobs.length}`);
    }
  }),
);
const initialRows = rows.map((row) => row.initialResult ?? row);
// Primary scores always include the first failures. Recovery is a separate diagnostic.
const summary = {
  total: aggregate(initialRows),
  groups: {},
  recovery: priorDir ? aggregate(rows) : null,
};
for (const category of new Set(rows.map((row) => row.category))) {
  summary.groups[category] = aggregate(initialRows.filter((row) => row.category === category));
}
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.total, null, 2));
if (summary.total.errors || summary.total.schemaFailures) process.exitCode = 1;
