import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  validateCorpus,
  scoreActions,
  validResponse,
  aggregate,
} from '../shared/voice-dictionary-eval.mjs';

const sample = {
  id: 'slack',
  category: 'correction',
  split: 'dev',
  rationale: 'Product correction',
  input: { beforeText: 'Slate 机器人用 CPU。', afterText: 'Slack 机器人用 CPU。' },
  terms: [{ accept: ['Slack'], required: true }],
  aliases: [{ term: 'Slack', alias: 'Slate', required: true }],
};
const action = {
  action: 'add_entry',
  term: 'Slack',
  aliases: [],
  type: 'product_name',
  confidence: 'high',
};

test('correct vocabulary and wrong alias are scored independently', () => {
  const score = scoreActions(sample, [{ ...action, aliases: ['CPU'] }]);
  assert.equal(score.termHit, 1);
  assert.equal(score.termWrong, 0);
  assert.equal(score.aliasWrong, 1);
  assert.equal(score.aliasMiss, 1);
});
test('addition needs no alias; candidate does not count as directly learned', () => {
  const addition = { ...sample, aliases: [] };
  assert.equal(scoreActions(addition, [action]).aliasMiss, 0);
  assert.equal(scoreActions(addition, [{ ...action, action: 'add_candidate' }]).entryHit, 0);
});
test('optional judgments are not recall targets and spelling is not silently collapsed', () => {
  const optional = { ...sample, terms: [{ accept: ['Slack'], required: false }], aliases: [] };
  assert.equal(scoreActions(optional, []).termMiss, 0);
  assert.equal(scoreActions(sample, [{ ...action, term: 'Slack机器人' }]).termWrong, 1);
});
test('duplicates do not inflate counts', () => {
  const score = scoreActions(sample, [{ ...action, aliases: ['Slate', 'Slate'] }, action]);
  assert.equal(score.termHit, 1);
  assert.equal(score.aliasAllowed, 1);
});
test('formal admission wins over duplicate candidate actions regardless of order', () => {
  const candidate = { ...action, action: 'add_candidate', aliases: ['Slate'] };
  for (const actions of [
    [action, candidate],
    [candidate, action],
  ]) {
    const score = scoreActions(sample, actions);
    assert.equal(score.entryHit, 1);
    assert.equal(score.aliasAllowed, 1);
  }
});
test('response schema is measured separately from lenient program acceptance', () => {
  assert.equal(validResponse({ actions: [action] }), true);
  assert.equal(validResponse({ actions: [{ ...action, aliases: undefined }] }), false);
  assert.equal(
    validResponse({ actions: [{ ...action, aliases: [{ text: 'Slate', count: 1 }] }] }),
    false,
  );
  assert.equal(validResponse({ actions: [{ ...action, confidence: 'low' }] }), false);
  assert.equal(validResponse({}), false);
});
test('failed requests remain in the recall denominator', () => {
  const score = scoreActions(sample, []);
  const summary = aggregate([
    { caseId: 'slack', error: 'timeout', rawScore: score, acceptedScore: score },
  ]);
  assert.equal(summary.errors, 1);
  assert.equal(summary.accepted.termMiss, 1);
  assert.equal(summary.allRepeatsCleanCases, 0);
});
test('fixtures have unique grounded labels; unrelated aliases fail validation', () => {
  for (const version of ['v1', 'v2', 'v3', 'v4']) {
    const corpus = JSON.parse(
      fs.readFileSync(new URL(`../fixtures/voice-dictionary-${version}.json`, import.meta.url)),
    );
    validateCorpus(corpus);
  }
  assert.throws(() => validateCorpus({ version: 1, id: 'bad', cases: [sample, sample] }));
  assert.throws(() =>
    validateCorpus({
      version: 1,
      id: 'bad',
      cases: [{ ...sample, aliases: [{ term: 'Slack', alias: 'missing', required: true }] }],
    }),
  );
});

test('offline runner uses the actual advisor, preserves evidence and never sends labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-vocabulary-eval-test-'));
  try {
    const corpus = {
      version: 1,
      id: 'offline',
      cases: [
        {
          ...sample,
          aliases: [],
          input: { beforeText: '检查机器人。', afterText: '检查 Slack 机器人。' },
        },
      ],
    };
    fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(corpus));
    fs.writeFileSync(
      path.join(dir, 'adapter.mjs'),
      `
      export async function requestJson(request) {
        if ('terms' in request.user || 'rationale' in request.user) throw new Error('Gold leaked');
        return { value: { actions: [${JSON.stringify(action)}] }, metadata: { returnedModel: 'offline' } };
      }
    `,
    );
    const runner = fileURLToPath(new URL('../voice-input-dictionary-eval.mjs', import.meta.url));
    const args = [
      '--experimental-strip-types',
      runner,
      '--cases',
      path.join(dir, 'cases.json'),
      '--adapter',
      path.join(dir, 'adapter.mjs'),
      '--model',
      'offline',
      '--out',
      path.join(dir, 'result'),
      '--repeats',
      '1',
    ];
    execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 15_000 });
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'result/slack-1.json')));
    assert.equal(row.acceptedScore.termHit, 1);
    assert.deepEqual(row.accepted[0].aliases, []);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'result/manifest.json')));
    assert.equal(manifest.promptVersion, 'dictation-dictionary-learning.zh.v8-phonetic');
    assert.equal(manifest.scorerSha256.length, 64);
    const alteredManifest = { ...manifest, scorerSha256: 'different-scorer' };
    fs.writeFileSync(path.join(dir, 'result/manifest.json'), JSON.stringify(alteredManifest));
    const wrongScorerArgs = args.map((arg) =>
      arg === path.join(dir, 'result') ? path.join(dir, 'wrong-scorer') : arg,
    );
    wrongScorerArgs.push('--retry-from', path.join(dir, 'result'));
    assert.throws(() =>
      execFileSync(process.execPath, wrongScorerArgs, { stdio: 'pipe', timeout: 15_000 }),
    );
    assert.equal(fs.existsSync(path.join(dir, 'wrong-scorer')), false);
    fs.writeFileSync(path.join(dir, 'result/manifest.json'), JSON.stringify(manifest));
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe', timeout: 15_000 }));
    const retryArgs = args.map((arg) =>
      arg === path.join(dir, 'result') ? path.join(dir, 'retried') : arg,
    );
    retryArgs.push('--retry-from', path.join(dir, 'result'));
    execFileSync(process.execPath, retryArgs, { stdio: 'pipe', timeout: 15_000 });
    const retryRow = JSON.parse(fs.readFileSync(path.join(dir, 'retried/slack-1.json')));
    assert.equal(retryRow.reusedFrom, path.join(dir, 'result'));
    fs.appendFileSync(path.join(dir, 'adapter.mjs'), '\n// changed transport\n');
    const changedArgs = retryArgs.map((arg) =>
      arg === path.join(dir, 'retried') ? path.join(dir, 'changed') : arg,
    );
    assert.throws(() =>
      execFileSync(process.execPath, changedArgs, { stdio: 'pipe', timeout: 15_000 }),
    );

    fs.writeFileSync(
      path.join(dir, 'adapter.mjs'),
      `
      import fs from 'node:fs';
      export async function requestJson() {
        const flag = new URL('./once', import.meta.url);
        if (!fs.existsSync(flag)) {
          fs.writeFileSync(flag, 'failed');
          throw Object.assign(new Error('temporary failure'), { status: 503 });
        }
        return { value: { actions: [${JSON.stringify(action)}] } };
      }
    `,
    );
    const failedArgs = args.map((arg) =>
      arg === path.join(dir, 'result') ? path.join(dir, 'failed') : arg,
    );
    assert.throws(() =>
      execFileSync(process.execPath, failedArgs, { stdio: 'pipe', timeout: 15_000 }),
    );
    const recoveryArgs = failedArgs.map((arg) =>
      arg === path.join(dir, 'failed') ? path.join(dir, 'recovered') : arg,
    );
    recoveryArgs.push('--retry-from', path.join(dir, 'failed'));
    // Primary score still fails even though the explicit diagnostic retry succeeds.
    assert.throws(() =>
      execFileSync(process.execPath, recoveryArgs, { stdio: 'pipe', timeout: 15_000 }),
    );
    const recovered = JSON.parse(fs.readFileSync(path.join(dir, 'recovered/summary.json')));
    assert.equal(recovered.total.errors, 1);
    assert.equal(recovered.total.accepted.termMiss, 1);
    assert.equal(recovered.recovery.errors, 0);
    assert.equal(recovered.recovery.accepted.termHit, 1);
    const original = JSON.parse(fs.readFileSync(path.join(dir, 'failed/slack-1.json')));
    assert.equal(original.error, 'http_503');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
