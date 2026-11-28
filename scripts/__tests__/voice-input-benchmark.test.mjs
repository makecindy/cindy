import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildOpenAiPromptFromHints,
  buildQwenCorpusTextFromHints,
  buildVolcengineCorpusContextFromHints,
  compareCoreEvalReports,
  computeCer,
  evaluateTermHits,
  percentile,
} from '../shared/voice-input-core-benchmark.mjs';
import {
  buildOpenAiTranscriptionSessionUpdate,
  buildQwenSessionUpdate,
  buildVolcengineFullClientRequestPayload,
  parseArgs,
} from '../voice-input-benchmark.mjs';

const execFile = promisify(execFileCb);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parseArgs supports core-eval, asr-hints, and asr hints flags', () => {
  const coreOpts = parseArgs([
    '--',
    'core-eval',
    '--baseline-core',
    'baseline-dir',
    '--candidate-core',
    'candidate-dir',
    '--latency-rounds',
    '12',
    '--json',
  ]);
  assert.equal(coreOpts.command, 'core-eval');
  assert.equal(coreOpts.baselineCore, path.resolve('baseline-dir'));
  assert.equal(coreOpts.candidateCore, path.resolve('candidate-dir'));
  assert.equal(coreOpts.latencyRounds, 12);
  assert.equal(coreOpts.json, true);

  const hintsOpts = parseArgs([
    'asr-hints',
    '--batch-models',
    'gpt-4o-transcribe',
    '--realtime-models',
    'none',
    '--include-history-in-prompt',
  ]);
  assert.equal(hintsOpts.command, 'asr-hints');
  assert.equal(hintsOpts.batchModels, 'gpt-4o-transcribe');
  assert.equal(hintsOpts.realtimeModels, 'none');
  assert.equal(hintsOpts.includeHistoryInPrompt, true);

  const asrOpts = parseArgs([
    'asr',
    '--providers',
    'litellm-volcengine-sauc-asr,litellm-gpt-4o-transcribe',
    '--hotwords',
    'LiteLLM,飞书多维表格',
    '--compare-hints',
  ]);
  assert.equal(asrOpts.command, 'asr');
  assert.equal(asrOpts.hotwords, 'LiteLLM,飞书多维表格');
  assert.equal(asrOpts.compareHints, true);
});

test('CER, term-hit scoring, and percentile metrics handle punctuation and spacing consistently', () => {
  assert.equal(computeCer('我们测一下 LiteLLM 和飞书多维表格。', '我们测一下LiteLLM和飞书多维表格'), 0);
  assert.ok(computeCer('我们测一下 LiteLLM', '我们测一下 Excel') > 0.3);

  const hits = evaluateTermHits('请检查 Sherpa-ONNX 和 ProsMirror。', ['Sherpa', 'ONNX', 'ProseMirror']);
  assert.deepEqual(hits, {
    hits: 2,
    total: 3,
    matched: ['Sherpa', 'ONNX'],
    missed: ['ProseMirror'],
  });

  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 30);
});

test('ASR hints wire payloads include provider-specific corpus/prompt fields and keep OpenAI prompt hotword-only by default', () => {
  const hints = {
    hotwords: ['LiteLLM', '飞书多维表格'],
    recentHistory: ['昨天把 LiteLLM 切到了新路由。'],
  };

  const volcWith = buildVolcengineFullClientRequestPayload('zh-CN', 16_000, hints);
  assert.equal(volcWith.request.language, 'zh');
  const volcCorpus = JSON.parse(volcWith.request.corpus.context);
  assert.deepEqual(volcCorpus.hotwords, [{ word: 'LiteLLM' }, { word: '飞书多维表格' }]);
  assert.equal(volcCorpus.context_type, 'dialog_ctx');
  assert.equal(volcCorpus.context_data[0].text, '昨天把 LiteLLM 切到了新路由。');
  assert.equal(buildVolcengineFullClientRequestPayload('zh-CN', 16_000, undefined).request.corpus, undefined);
  assert.equal(buildVolcengineCorpusContextFromHints(undefined), undefined);

  const qwenWith = buildQwenSessionUpdate('zh', 16_000, hints);
  assert.equal(
    qwenWith.session.input_audio_transcription.corpus.text,
    buildQwenCorpusTextFromHints(hints),
  );
  assert.equal(buildQwenSessionUpdate('zh', 16_000, undefined).session.input_audio_transcription.corpus, undefined);

  const openAiDefault = buildOpenAiTranscriptionSessionUpdate('gpt-4o-transcribe', 'zh', 24_000, hints);
  assert.equal(openAiDefault.session.audio.input.transcription.prompt, 'LiteLLM, 飞书多维表格');
  assert.ok(!openAiDefault.session.audio.input.transcription.prompt.includes('昨天把'));

  const openAiWithHistory = buildOpenAiPromptFromHints(hints, { includeRecentContext: true });
  assert.ok(openAiWithHistory.includes('昨天把'));
});

test('compareCoreEvalReports computes signed before/after deltas cleanly', () => {
  const base = {
    dictionaryGate: { validMultiEditFalseBlockRate: 0.625 },
    dictionaryMatching: { recall: 0.0625, trapFalsePositiveRate: 0 },
    acousticAndSpeaker: { silenceAccuracy: 0.5556, fanVoicedFalseChunkRate: 1 },
    longSpeech: {
      scenarios: [
        { scenario: '90s-paused-dictation', refineTotalInputChars: 2000 },
        { scenario: '150s-continuous-1050ch', refineTruncations: 1 },
        { scenario: '210s-paused-long-dictation', survived: false },
      ],
    },
  };
  const cand = {
    dictionaryGate: { validMultiEditFalseBlockRate: 0 },
    dictionaryMatching: { recall: 1, trapFalsePositiveRate: 0 },
    acousticAndSpeaker: { silenceAccuracy: 1, fanVoicedFalseChunkRate: 0.04 },
    longSpeech: {
      scenarios: [
        { scenario: '90s-paused-dictation', refineTotalInputChars: 370 },
        { scenario: '150s-continuous-1050ch', refineTruncations: 0 },
        { scenario: '210s-paused-long-dictation', survived: true },
      ],
    },
  };
  assert.deepEqual(compareCoreEvalReports(base, cand), {
    dictionaryGateFalseBlockRateDeltaPp: -62.5,
    dictionaryMatchingRecallDeltaPp: 93.8,
    dictionaryMatchingTrapFprDeltaPp: 0,
    silenceAccuracyDeltaPp: 44.4,
    fanVoicedFalseRateDeltaPp: -96,
    longSpeech90sRefineCharsDeltaPct: -81.5,
    longSpeech150sTruncationEliminated: true,
    longSpeech210sSurvivalGained: true,
  });
});

test('core-eval CLI executes real offline voice-input-core suites end-to-end', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-voice-bench-test-'));
  const outFile = path.join(tmpDir, 'report.json');
  try {
    const { stdout } = await execFile(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(REPO_ROOT, 'scripts', 'voice-input-benchmark.mjs'),
        'core-eval',
        '--latency-rounds',
        '5',
        '--out',
        outFile,
        '--json',
      ],
      { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.kind, 'voice-input-core-eval-benchmark');
    assert.ok(report.candidate.dictionaryGate.officialCasesTotal >= 100);
    assert.equal(report.candidate.dictionaryMatching.dictionaryEntries, 202);
    assert.equal(report.candidate.longSpeech.scenarios.length, 4);
    const persisted = JSON.parse(await fs.readFile(outFile, 'utf8'));
    assert.equal(persisted.kind, 'voice-input-core-eval-benchmark');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
