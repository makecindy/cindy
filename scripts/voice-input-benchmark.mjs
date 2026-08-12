#!/usr/bin/env node
import { execFile as execFileCb, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import {
  desktopUserDataDirForRegion,
  resolveDesktopDevRegion,
} from './shared/desktop-dev-region.mjs';

const execFile = promisify(execFileCb);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = path.join(os.tmpdir(), 'xdt-voice-input-benchmark', 'fixture.wav');
const DEFAULT_REPORT_OUT = path.join(os.tmpdir(), 'xdt-voice-input-benchmark', 'last-report.json');
const DEFAULT_PHRASE =
  'Voice input benchmark. Today we test realtime transcription latency for Cindy.';
const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const DEFAULT_MODEL = 'gpt-realtime-whisper';
const DEFAULT_LITELLM_BASE_URL = process.env.VITE_XD_GATEWAY_BASE_URL?.trim() || '';
const DEFAULT_ASR_PROVIDERS = [
  'litellm-qwen3-asr-flash-realtime',
  'litellm-gpt-realtime-whisper',
  'litellm-volcengine-sauc-asr',
];
const DEFAULT_REFINER_MODELS = [
  'gpt-5.4-nano',
  'qwen/qwen3.6-plus',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.1',
  'moonshotai/kimi-k2.6',
];
const DEFAULT_REFINER_CASES = [
  {
    id: 'tech-terms',
    dictationText: '我们现在用来反映的 pump 的文字，看一下有没有缓存命中。',
    expectedText: '我们现在用来 refine 的 prompt 的文字，看一下有没有缓存命中。',
  },
  {
    id: 'filler-cleanup',
    dictationText: '嗯。然后那个我想看一下 litellm 这边是不是起作用。',
    expectedText: '我想看一下 LiteLLM 这边是不是起作用。',
  },
  {
    id: 'long-zh-mixed',
    dictationText: '你不要把它当成轨道,我们还是来当作资料来去进行整理。然后这套房子过去几年上市时候的照片你整理的不全，网上还有更多更高清的，你再去仔细找一找。 然后我看目录里现在还很多YouTube的链接，但是没有内容的。这个是什么情况？你应该装了YouTube视频下载相关的skill，可以把这些视频下载下来才好。',
    expectedText: '你不要把它当成轨道，我们还是来当作资料来进行整理。然后这套房子过去几年上市时候的照片你整理得不全，网上还有更多更高清的，你再去仔细找一找。然后我看目录里现在还有很多 YouTube 的链接，但是没有内容的。这个是什么情况？你应该装了 YouTube 视频下载相关的 skill，可以把这些视频下载下来才好。',
  },
];
const PCM_TARGET_RATE = 24_000;
const PCM_16K_RATE = 16_000;
const LOG_TAIL_BYTES = 8 * 1024 * 1024;
const VOLCENGINE_SAUC_MODEL_NAME = 'bigmodel';
const VOLCENGINE_SAUC_NONSTREAM_END_WINDOW_MS = 300;

const ASR_PROVIDER_SPECS = {
  'litellm-gpt-realtime-whisper': {
    id: 'litellm-gpt-realtime-whisper',
    label: 'GPT realtime whisper',
    protocol: 'openai-realtime',
    model: 'gpt-realtime-whisper',
    endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
    pcmSampleRate: 24_000,
    headers: { 'x-litellm-model': 'gpt-realtime-whisper' },
  },
  'litellm-qwen3-asr-flash-realtime': {
    id: 'litellm-qwen3-asr-flash-realtime',
    label: 'Qwen3 ASR flash realtime',
    protocol: 'qwen-realtime',
    model: 'qwen3-asr-flash-realtime',
    endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
    pcmSampleRate: 16_000,
    headers: {},
  },
  'litellm-volcengine-sauc-asr': {
    id: 'litellm-volcengine-sauc-asr',
    label: 'Volcengine SAUC ASR',
    protocol: 'volcengine-sauc',
    model: 'volcengine-sauc-asr',
    endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
    pcmSampleRate: 16_000,
    resourceId: 'volc.seedasr.sauc.duration',
    headers: {},
  },
};

function usage() {
  console.log(`Voice input benchmark

Usage:
  pnpm benchmark:voice-input -- fixture [options]
  pnpm benchmark:voice-input -- asr [options]
  pnpm benchmark:voice-input -- refine [options]
  pnpm benchmark:voice-input -- scenario [options]
  pnpm benchmark:voice-input -- replay [options]
  pnpm benchmark:voice-input -- report [options]

Fixture options:
  --audio <path>                    WAV fixture. Default: /tmp, copied from latest local recording
  --text <phrase>                   Fallback phrase if macOS say is used

Replay options:
  --mode cold|preconnected|both     Default: both
  --iterations <n>                  Default: 1
  --audio <path>                    WAV fixture. Default: /tmp, copied from latest local recording
  --text <phrase>                   Fallback phrase if macOS say is used
  --source-language <code|auto>     Default: auto
  --chunk-ms <n>                    Default: 40
  --timeout-ms <n>                  Default: 15000
  --paste off|frontmost             Default: off
  --out <path>                      JSON report path
  --json                            Print JSON only

ASR options:
  --providers <ids>                 Comma list. Default: ${DEFAULT_ASR_PROVIDERS.join(',')}
  --iterations <n>                  Default: 1
  --audio <path>                    WAV fixture. Default: /tmp, copied from latest local recording
  --source-language <code|auto>     Default: auto
  --chunk-ms <n>                    Default: 40
  --tail-silence-ms <n>             Append silence before final/commit. Default: 0; Volcengine still sends its production 300ms final silence marker
  --timeout-ms <n>                  Default: 15000
  --base-url <url>                  LiteLLM gateway. Default: VITE_XD_GATEWAY_BASE_URL
  --api-key <key>                   Optional. Otherwise env/App safeStorage is used
  --debug-events                    Print provider event/frame diagnostics to stderr
  --out <path>                      JSON report path
  --json                            Print JSON only

Refine options:
  --models <ids>                    Comma list. Default: ${DEFAULT_REFINER_MODELS.join(',')}
  --cases <path>                    JSON array of { id, dictationText, expectedText?, context? }
  --dictation-text <text>           Single ad-hoc case input
  --expected-text <text>            Expected output for the single ad-hoc case
  --context <path>                  JSON context merged into every case
  --region <cn|global|dev>          userData 区域 (默认读取 CINDY_AUTH_REGION, 再默认 global)
  --iterations <n>                  Default: 1
  --timeout-ms <n>                  Default: 15000
  --base-url <url>                  LiteLLM gateway. Default: VITE_XD_GATEWAY_BASE_URL
  --api-key <key>                   Optional. Otherwise env/App safeStorage is used
  --out <path>                      JSON report path
  --json                            Print JSON only

Scenario options:
  --shortcut <accelerator>          Default: option+space
  --target frontmost|textedit       Default: textedit
  --settle-ms <n>                   Extra wait after fixture duration. Default: 1200
  --timeout-ms <n>                  Default: 60000
  --log <path>                      Default: apps/desktop/logs/main.log
  --out <path>                      JSON report path
  --json                            Print JSON only

Report options:
  --log <path>                      Default: apps/desktop/logs/main.log
  --latest <n>                      Default: 5
  --out <path>                      JSON report path
  --json                            Print JSON only`);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--') args.shift();
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'replay';
  const opts = {
    command,
    mode: 'both',
    iterations: 1,
    audio: DEFAULT_FIXTURE,
    text: DEFAULT_PHRASE,
    sourceLanguage: 'auto',
    chunkMs: 40,
    tailSilenceMs: 0,
    timeoutMs: 15_000,
    paste: 'off',
    out: DEFAULT_REPORT_OUT,
    json: false,
    latest: 5,
    log: path.join(REPO_ROOT, 'apps', 'desktop', 'logs', 'main.log'),
    shortcut: 'option+space',
    target: 'textedit',
    settleMs: 1200,
    providers: DEFAULT_ASR_PROVIDERS.join(','),
    baseUrl: DEFAULT_LITELLM_BASE_URL,
    apiKey: '',
    debugEvents: false,
    models: DEFAULT_REFINER_MODELS.join(','),
    cases: '',
    dictationText: '',
    expectedText: '',
    context: '',
    region: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--mode':
        opts.mode = next();
        break;
      case '--iterations':
        opts.iterations = Math.max(1, Number.parseInt(next(), 10));
        break;
      case '--audio':
        opts.audio = path.resolve(next());
        break;
      case '--text':
        opts.text = next();
        break;
      case '--source-language':
        opts.sourceLanguage = next();
        break;
      case '--chunk-ms':
        opts.chunkMs = Math.max(10, Number.parseInt(next(), 10));
        break;
      case '--tail-silence-ms':
        opts.tailSilenceMs = Math.max(0, Number.parseInt(next(), 10));
        break;
      case '--timeout-ms':
        opts.timeoutMs = Math.max(1000, Number.parseInt(next(), 10));
        break;
      case '--paste':
        opts.paste = next();
        break;
      case '--out':
        opts.out = path.resolve(next());
        break;
      case '--log':
        opts.log = path.resolve(next());
        break;
      case '--latest':
        opts.latest = Math.max(1, Number.parseInt(next(), 10));
        break;
      case '--shortcut':
        opts.shortcut = next();
        break;
      case '--target':
        opts.target = next();
        break;
      case '--settle-ms':
        opts.settleMs = Math.max(0, Number.parseInt(next(), 10));
        break;
      case '--providers':
        opts.providers = next();
        break;
      case '--models':
        opts.models = next();
        break;
      case '--cases':
        opts.cases = path.resolve(next());
        break;
      case '--dictation-text':
        opts.dictationText = next();
        break;
      case '--expected-text':
        opts.expectedText = next();
        break;
      case '--context':
        opts.context = path.resolve(next());
        break;
      case '--region':
        opts.region = next();
        break;
      case '--base-url':
        opts.baseUrl = next();
        break;
      case '--api-key':
        opts.apiKey = next();
        break;
      case '--debug-events':
        opts.debugEvents = true;
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function ensureFixture(audioPath, text) {
  if (fs.existsSync(audioPath)) {
    try {
      if (readWavPcm16Mono(audioPath).durationMs >= 250) return;
    } catch {
      // Regenerate below.
    }
    await fsp.rm(audioPath, { force: true });
  }
  const latestRecording = findLatestVoiceInputRecording();
  if (latestRecording) {
    await fsp.mkdir(path.dirname(audioPath), { recursive: true });
    await fsp.copyFile(latestRecording, audioPath);
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error(`Audio fixture is missing: ${audioPath}. Pass --audio <wav> on non-macOS.`);
  }
  await fsp.mkdir(path.dirname(audioPath), { recursive: true });
  const aiffPath = `${audioPath}.aiff`;
  await execFile('/usr/bin/say', ['-o', aiffPath, text]);
  await execFile('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiffPath, audioPath]);
  await fsp.rm(aiffPath, { force: true });
  if (readWavPcm16Mono(audioPath).durationMs < 250) {
    await fsp.rm(audioPath, { force: true });
    throw new Error('Could not generate a usable speech fixture. Pass --audio <wav> or enable XDT_VOICE_INPUT_RECORD and run one dictation first.');
  }
}

function findLatestVoiceInputRecording() {
  const root = path.join(REPO_ROOT, 'apps', 'desktop', 'logs', 'voice-input-recordings');
  if (!fs.existsSync(root)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(root, entry.name, 'audio.wav');
    if (!fs.existsSync(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 44) candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // ignore broken recording folder
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath ?? null;
}

function readWavPcm16Mono(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Only RIFF/WAVE fixtures are supported: ${filePath}`);
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + size;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(bodyStart),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(bodyStart, bodyEnd);
    }
    offset = bodyEnd + (size % 2);
  }

  if (!fmt || !data) throw new Error(`Invalid WAV fixture: ${filePath}`);
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`Only PCM16 WAV fixtures are supported. Got format=${fmt.audioFormat}, bits=${fmt.bitsPerSample}`);
  }

  const samples = [];
  for (let i = 0; i + (fmt.channels * 2) <= data.length; i += fmt.channels * 2) {
    if (fmt.channels === 1) {
      samples.push(data.readInt16LE(i));
    } else {
      let sum = 0;
      for (let channel = 0; channel < fmt.channels; channel += 1) {
        sum += data.readInt16LE(i + channel * 2);
      }
      samples.push(Math.max(-32768, Math.min(32767, Math.round(sum / fmt.channels))));
    }
  }

  return {
    sampleRate: fmt.sampleRate,
    pcm16k: encodePcm16(resampleLinear(samples, fmt.sampleRate, PCM_16K_RATE)),
    pcm24k: encodePcm16(resampleLinear(samples, fmt.sampleRate, PCM_TARGET_RATE)),
    durationMs: samples.length / fmt.sampleRate * 1000,
  };
}

function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const nextLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const ratio = fromRate / toRate;
  const out = new Array(nextLength);
  for (let i = 0; i < nextLength; i += 1) {
    const src = i * ratio;
    const left = Math.floor(src);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = src - left;
    out[i] = Math.round(samples[left] * (1 - frac) + samples[right] * frac);
  }
  return out;
}

function encodePcm16(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, samples[i])), i * 2);
  }
  return out;
}

function resolveLanguageCode(sourceLanguage) {
  const raw = (sourceLanguage ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return undefined;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  return lower.split('-')[0];
}

async function readAccessToken() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const candidates = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : null,
    path.join(os.homedir(), '.codex', 'auth.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const auth = JSON.parse(await fsp.readFile(candidate, 'utf8'));
      const token = auth?.tokens?.access_token;
      if (typeof token === 'string' && token.length > 0) return token;
    } catch {
      // try next candidate
    }
  }
  throw new Error('No OpenAI/Codex token found. Set OPENAI_API_KEY or CODEX_HOME, or log in with Codex first.');
}

async function openRealtimeSession(opts, marks) {
  marks.authStart = performance.now();
  const token = await readAccessToken();
  marks.authReady = performance.now();

  const ws = new WebSocket(OPENAI_REALTIME_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const events = [];
  let firstDeltaAt;
  let completedAt;
  let completedTranscript = '';
  let sessionUpdatedAt;
  let rejectWaiters = () => {};

  ws.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    events.push({
      type: event.type,
      at: performance.now(),
      itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
      chars: typeof event.transcript === 'string'
        ? event.transcript.length
        : typeof event.delta === 'string'
          ? event.delta.length
          : undefined,
    });
    if (event.type === 'session.updated') {
      sessionUpdatedAt = performance.now();
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' && firstDeltaAt === undefined) {
      firstDeltaAt = performance.now();
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      completedAt = performance.now();
      completedTranscript += typeof event.transcript === 'string' ? event.transcript : '';
    }
    if (event.type === 'error') {
      rejectWaiters(new Error(event.error?.message ?? event.message ?? 'Realtime transcription error'));
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), opts.timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      marks.wsOpen = performance.now();
      resolve();
    });
    ws.once('error', reject);
  });

  const language = resolveLanguageCode(opts.sourceLanguage);
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: PCM_TARGET_RATE },
          transcription: {
            model: opts.model ?? DEFAULT_MODEL,
            ...(language ? { language } : {}),
          },
          turn_detection: null,
        },
      },
    },
  }));
  marks.sessionUpdateSent = performance.now();

  await waitFor(() => sessionUpdatedAt !== undefined, opts.timeoutMs, (reject) => {
    rejectWaiters = reject;
  });
  marks.sessionUpdated = sessionUpdatedAt;

  return {
    ws,
    events,
    get firstDeltaAt() { return firstDeltaAt; },
    get completedAt() { return completedAt; },
    get completedTranscript() { return completedTranscript.trim(); },
  };
}

async function waitFor(predicate, timeoutMs, registerRejecter) {
  const started = performance.now();
  await new Promise((resolve, reject) => {
    registerRejecter?.(reject);
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out after ${timeoutMs}ms`));
      }
    }, 10);
  });
}

async function streamAudio(ws, pcm24k, chunkMs, realtime) {
  const chunkBytes = Math.max(2, Math.round(PCM_TARGET_RATE * 2 * chunkMs / 1000));
  for (let offset = 0; offset < pcm24k.length; offset += chunkBytes) {
    const chunk = pcm24k.subarray(offset, Math.min(pcm24k.length, offset + chunkBytes));
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    }));
    if (realtime && offset + chunkBytes < pcm24k.length) {
      await sleep(chunkMs);
    }
  }
}

async function streamPcmAudio(pcm, sampleRate, chunkMs, sendChunk, realtime) {
  const chunkBytes = Math.max(2, Math.round(sampleRate * 2 * chunkMs / 1000));
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes));
    sendChunk(chunk);
    if (realtime && offset + chunkBytes < pcm.length) {
      await sleep(chunkMs);
    }
  }
}

function silencePcmForDuration(sampleRate, durationMs) {
  const sampleCount = Math.max(0, Math.round(sampleRate * durationMs / 1000));
  return Buffer.alloc(sampleCount * 2);
}

async function streamTailSilence(sampleRate, opts, sendChunk) {
  const silence = silencePcmForDuration(sampleRate, opts.tailSilenceMs);
  if (silence.length === 0) return;
  await streamPcmAudio(silence, sampleRate, opts.chunkMs, sendChunk, true);
}

function pcmForSampleRate(audio, sampleRate) {
  if (sampleRate === 16_000) return audio.pcm16k;
  if (sampleRate === 24_000) return audio.pcm24k;
  throw new Error(`Unsupported ASR benchmark sample rate: ${sampleRate}`);
}

function resolveAsrProviderSpecs(value) {
  const ids = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const selected = ids.length > 0 ? ids : DEFAULT_ASR_PROVIDERS;
  return selected.map((id) => {
    const spec = ASR_PROVIDER_SPECS[id];
    if (!spec) throw new Error(`Unknown ASR benchmark provider: ${id}`);
    return spec;
  });
}

async function resolveLiteLlmApiKey(opts) {
  const explicit = [
    opts.apiKey,
    process.env.XDT_VOICE_INPUT_BENCHMARK_API_KEY,
    process.env.XDT_LITELLM_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ].find((value) => value?.trim());
  if (explicit) return explicit.trim();
  const region = opts.region ?? resolveDesktopDevRegion([], process.env);
  const stored = await readXdGatewayApiKeyFromAppStorage(region);
  if (stored) return stored;
  throw new Error(
    'No LiteLLM/XD Gateway API key found. Pass --api-key, set XDT_VOICE_INPUT_BENCHMARK_API_KEY, or save an API key in Settings > API Key.',
  );
}

async function readXdGatewayApiKeyFromAppStorage(region) {
  const electron = resolveElectronBinary();
  if (!electron) return null;
  const userDataDir = desktopUserDataDirForRegion(region);
  const helperPath = path.join(os.tmpdir(), `xdt-read-xd-gateway-key-${process.pid}-${Date.now()}.cjs`);
  await fsp.writeFile(helperPath, `
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');
// safeStorage service name remains Cindy for the shared packaged CN/Global keychain;
// the profile path is selected explicitly so Global reads CindyGlobal storage.
app.setName('Cindy');
app.setPath('userData', ${JSON.stringify(userDataDir)});
app.whenReady().then(() => {
  try {
    const file = path.join(app.getPath('userData'), 'safe-storage', 'api_key.enc');
    if (!safeStorage.isEncryptionAvailable() || !fs.existsSync(file)) {
      console.log(JSON.stringify({ ok: false }));
      return;
    }
    const value = safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf8'), 'base64'));
    console.log(JSON.stringify({ ok: true, value }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }));
  } finally {
    app.quit();
  }
});
`, 'utf8');
  try {
    const { stdout } = await execFile(electron, [helperPath], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}');
    return parsed.ok && typeof parsed.value === 'string' ? parsed.value : null;
  } catch {
    return null;
  } finally {
    await fsp.rm(helperPath, { force: true });
  }
}

function resolveElectronBinary() {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const candidates = [
    path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules', '.bin', `electron${suffix}`),
    path.join(REPO_ROOT, 'node_modules', '.bin', `electron${suffix}`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function buildProviderWebSocketUrl(baseUrl, endpointPath) {
  const base = new URL(baseUrl.trim().replace(/\/+$/, '/'));
  const endpoint = new URL(endpointPath, 'https://placeholder.invalid');
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${endpoint.pathname}`;
  base.search = endpoint.search;
  if (base.protocol === 'https:') base.protocol = 'wss:';
  else if (base.protocol === 'http:') base.protocol = 'ws:';
  return base.toString();
}

function joinProxyPath(baseUrl, pathname) {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}

function buildQwenSessionUpdate(sourceLanguage, sampleRate) {
  const language = resolveLanguageCode(sourceLanguage);
  return {
    event_id: `session_update_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: 'session.update',
    session: {
      modalities: ['text'],
      input_audio_format: 'pcm',
      sample_rate: sampleRate,
      input_audio_transcription: {
        ...(language ? { language } : {}),
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.0,
        silence_duration_ms: 400,
      },
    },
  };
}

function buildOpenAiTranscriptionSessionUpdate(model, sourceLanguage, sampleRate) {
  const language = resolveLanguageCode(sourceLanguage);
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: sampleRate },
          transcription: {
            model,
            ...(language ? { language } : {}),
          },
          turn_detection: null,
        },
      },
    },
  };
}

async function runOpenAiCompatibleAsrIteration(spec, audio, opts, apiKey, iteration) {
  const marks = { start: performance.now() };
  const events = [];
  const itemOrder = [];
  const partialsByItem = new Map();
  const finalsByItem = new Map();
  let firstPartialAt;
  let completedAt;
  let sessionUpdatedAt;
  let sessionFinishedAt;
  let rejectWaiters = () => {};
  const ws = new WebSocket(buildProviderWebSocketUrl(opts.baseUrl, spec.endpointPath), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...spec.headers,
    },
  });

  ws.on('message', (data) => {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    events.push({
      type: event.type,
      at: performance.now(),
      chars: typeof event.transcript === 'string'
        ? event.transcript.length
        : typeof event.text === 'string'
          ? event.text.length
          : typeof event.delta === 'string'
            ? event.delta.length
            : undefined,
    });
    if (opts.debugEvents) {
      console.error('[asr-debug]', spec.id, event.type, JSON.stringify({
        item_id: event.item_id,
        text: previewString(event.text),
        transcript: previewString(event.transcript),
        delta: previewString(event.delta),
        stash: previewString(event.stash),
        error: event.error?.message ?? event.message,
      }));
    }
    if (event.type === 'session.updated') {
      sessionUpdatedAt = performance.now();
      return;
    }
    const itemId = typeof event.item_id === 'string' ? event.item_id : '__default__';
    const registerItem = () => {
      if (!itemOrder.includes(itemId)) itemOrder.push(itemId);
    };
    const aggregateTranscript = () => itemOrder
      .map((id) => finalsByItem.get(id) ?? partialsByItem.get(id) ?? '')
      .filter(Boolean)
      .join(' ')
      .trim();
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      if (firstPartialAt === undefined) firstPartialAt = performance.now();
      registerItem();
      partialsByItem.set(itemId, `${partialsByItem.get(itemId) ?? ''}${typeof event.delta === 'string' ? event.delta : ''}`);
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.text') {
      if (firstPartialAt === undefined) firstPartialAt = performance.now();
      registerItem();
      partialsByItem.set(itemId, `${typeof event.text === 'string' ? event.text : ''}${typeof event.stash === 'string' ? event.stash : ''}`);
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      completedAt = performance.now();
      registerItem();
      const finalTranscript = typeof event.transcript === 'string'
        ? event.transcript
        : typeof event.text === 'string'
          ? event.text
          : partialsByItem.get(itemId) ?? '';
      finalsByItem.set(itemId, finalTranscript);
      partialsByItem.delete(itemId);
      return;
    }
    if (event.type === 'session.finished') {
      sessionFinishedAt = performance.now();
      if (completedAt === undefined && aggregateTranscript()) completedAt = sessionFinishedAt;
      return;
    }
    if (event.type === 'error') {
      rejectWaiters(new Error(event.error?.message ?? event.message ?? 'Realtime ASR error'));
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), opts.timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      marks.wsOpen = performance.now();
      resolve();
    });
    ws.once('error', reject);
  });

  ws.send(JSON.stringify(
    spec.protocol === 'qwen-realtime'
      ? buildQwenSessionUpdate(opts.sourceLanguage, spec.pcmSampleRate)
      : buildOpenAiTranscriptionSessionUpdate(spec.model, opts.sourceLanguage, spec.pcmSampleRate),
  ));
  marks.sessionUpdateSent = performance.now();
  await waitFor(() => sessionUpdatedAt !== undefined, opts.timeoutMs, (reject) => {
    rejectWaiters = reject;
  });
  marks.sessionUpdated = sessionUpdatedAt;

  const pcm = pcmForSampleRate(audio, spec.pcmSampleRate);
  const sendAudioChunk = (chunk) => {
    ws.send(JSON.stringify({
      ...(spec.protocol === 'qwen-realtime' ? { event_id: `append_${Date.now()}_${Math.random().toString(16).slice(2)}` } : {}),
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    }));
  };
  marks.audioStart = performance.now();
  await streamPcmAudio(pcm, spec.pcmSampleRate, opts.chunkMs, sendAudioChunk, true);
  marks.audioFinished = performance.now();
  await streamTailSilence(spec.pcmSampleRate, opts, sendAudioChunk);
  marks.tailSilenceFinished = performance.now();

  if (spec.protocol === 'qwen-realtime') {
    ws.send(JSON.stringify({
      event_id: `finish_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      type: 'session.finish',
    }));
  } else {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }
  marks.finishSent = performance.now();

  const aggregateTranscript = () => itemOrder
    .map((id) => finalsByItem.get(id) ?? partialsByItem.get(id) ?? '')
    .filter(Boolean)
    .join(' ')
    .trim();
  await waitFor(() => {
    if (spec.protocol === 'qwen-realtime') return sessionFinishedAt !== undefined && aggregateTranscript();
    return completedAt !== undefined;
  }, opts.timeoutMs, (reject) => {
    rejectWaiters = reject;
  });
  marks.completed = spec.protocol === 'qwen-realtime' ? sessionFinishedAt : completedAt;
  try {
    ws.close();
  } catch {
    // ignore
  }
  return buildAsrRunResult(spec, opts, audio, iteration, marks, firstPartialAt, events, aggregateTranscript());
}

async function runVolcengineSaucAsrIteration(spec, audio, opts, apiKey, iteration) {
  const marks = { start: performance.now() };
  const events = [];
  let firstPartialAt;
  let completedAt;
  let transcript = '';
  let fatalError;
  let rejectWaiters = () => {};
  let finalRequested = false;
  const ws = new WebSocket(buildProviderWebSocketUrl(opts.baseUrl, spec.endpointPath), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Api-Resource-Id': spec.resourceId,
      'X-Api-Connect-Id': `xdt-benchmark-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
  });

  ws.on('message', (data) => {
    let message;
    try {
      message = decodeVolcengineBenchmarkMessage(rawDataToBuffer(data));
    } catch (error) {
      rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    events.push({
      type: volcengineMessageTypeName(message.messageType),
      at: performance.now(),
      sequence: message.sequence,
      chars: extractBenchmarkTranscript(message.payload).length || undefined,
    });
    if (opts.debugEvents) {
      console.error('[asr-debug]', spec.id, volcengineMessageTypeName(message.messageType), JSON.stringify({
        flags: message.flags,
        sequence: message.sequence,
        transcript: previewString(extractBenchmarkTranscript(message.payload)),
        error: previewString(extractBenchmarkErrorMessage(message.payload) ?? message.payloadText),
        payloadKeys: isPlainRecord(message.payload) ? Object.keys(message.payload).slice(0, 12) : undefined,
        payload: previewJson(message.payload),
      }));
    }
    if (message.messageType === 0xf) {
      fatalError = new Error(extractBenchmarkErrorMessage(message.payload) ?? message.payloadText ?? 'Volcengine SAUC ASR error');
      rejectWaiters(fatalError);
      return;
    }
    const nextTranscript = extractBenchmarkTranscript(message.payload);
    if (nextTranscript) {
      transcript = nextTranscript;
      if (firstPartialAt === undefined) firstPartialAt = performance.now();
    }
    if (
      finalRequested
      && message.messageType === VOLC_MESSAGE_TYPE_FULL_SERVER_RESPONSE
      && message.flags === VOLC_FLAG_NEGATIVE_SEQUENCE
    ) {
      completedAt = performance.now();
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), opts.timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      marks.wsOpen = performance.now();
      resolve();
    });
    ws.once('error', reject);
  });

  ws.send(encodeVolcengineBenchmarkFullClientRequest({
    user: { uid: 'cindy-benchmark' },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: spec.pcmSampleRate,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: VOLCENGINE_SAUC_MODEL_NAME,
      result_type: 'full',
      show_utterances: true,
      enable_nonstream: true,
      end_window_size: VOLCENGINE_SAUC_NONSTREAM_END_WINDOW_MS,
      enable_punc: true,
      enable_itn: true,
      ...(resolveLanguageCode(opts.sourceLanguage) ? { language: resolveLanguageCode(opts.sourceLanguage) } : {}),
    },
  }));
  marks.sessionUpdateSent = performance.now();
  marks.sessionUpdated = marks.wsOpen;

  const pcm = pcmForSampleRate(audio, spec.pcmSampleRate);
  // The initial full client request is auto-assigned sequence 1 by
  // Volcengine SAUC, so audio-only requests begin at 2.
  let sequence = 1;
  let pendingFinalAudioChunk;
  const sendAudioChunk = (chunk) => {
    if (fatalError) return;
    if (pendingFinalAudioChunk) {
      sequence += 1;
      ws.send(encodeVolcengineBenchmarkAudioOnlyRequest(pendingFinalAudioChunk, sequence));
    }
    pendingFinalAudioChunk = chunk;
  };
  marks.audioStart = performance.now();
  await streamPcmAudio(pcm, spec.pcmSampleRate, opts.chunkMs, sendAudioChunk, true);
  if (fatalError) throw fatalError;
  marks.audioFinished = performance.now();
  await streamTailSilence(spec.pcmSampleRate, opts, sendAudioChunk);
  if (fatalError) throw fatalError;
  marks.tailSilenceFinished = performance.now();
  finalRequested = true;
  if (pendingFinalAudioChunk) {
    sequence += 1;
    ws.send(encodeVolcengineBenchmarkAudioOnlyRequest(pendingFinalAudioChunk, sequence));
  }
  pendingFinalAudioChunk = undefined;
  // Match production VolcengineSaucAsrProvider: the last real audio chunk is
  // sent normally, then a short silence packet carries the negative final
  // sequence so the final marker does not cut off the spoken tail.
  sequence += 1;
  ws.send(encodeVolcengineBenchmarkAudioOnlyRequest(
    silencePcmForDuration(spec.pcmSampleRate, VOLCENGINE_SAUC_NONSTREAM_END_WINDOW_MS),
    -sequence,
  ));
  marks.finishSent = performance.now();

  await waitFor(() => completedAt !== undefined, opts.timeoutMs, (reject) => {
    rejectWaiters = reject;
  });
  marks.completed = completedAt;
  try {
    ws.close();
  } catch {
    // ignore
  }
  return buildAsrRunResult(spec, opts, audio, iteration, marks, firstPartialAt, events, transcript.trim());
}

function buildAsrRunResult(spec, opts, audio, iteration, marks, firstPartialAt, events, transcript) {
  const base = marks.start;
  return {
    iteration,
    provider: spec.id,
    label: spec.label,
    protocol: spec.protocol,
    model: spec.model,
    fixture: {
      audioPath: opts.audio,
      durationMs: Math.round(audio.durationMs),
      sourceSampleRate: audio.sampleRate,
      sentSampleRate: spec.pcmSampleRate,
      chunkMs: opts.chunkMs,
      tailSilenceMs: opts.tailSilenceMs,
    },
    timings: {
      wsOpenMs: delta(marks.wsOpen, base),
      sessionReadyMs: delta(marks.sessionUpdated, base),
      audioStartMs: delta(marks.audioStart, base),
      audioFinishedMs: delta(marks.audioFinished, base),
      tailSilenceFinishedMs: delta(marks.tailSilenceFinished, base),
      finishSentMs: delta(marks.finishSent, base),
      firstPartialMs: delta(firstPartialAt, base),
      completedMs: delta(marks.completed, base),
      afterAudioCompletedMs: delta(marks.completed, marks.audioFinished),
      afterTailSilenceCompletedMs: delta(marks.completed, marks.tailSilenceFinished),
    },
    transcript,
    eventTypes: events.map((event) => event.type),
  };
}

async function runAsrBenchmark(opts) {
  await ensureFixture(opts.audio, opts.text);
  const audio = readWavPcm16Mono(opts.audio);
  const apiKey = await resolveLiteLlmApiKey(opts);
  const specs = resolveAsrProviderSpecs(opts.providers);
  const runs = [];
  for (const spec of specs) {
    for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
      if (spec.protocol === 'volcengine-sauc') {
        runs.push(await runVolcengineSaucAsrIteration(spec, audio, opts, apiKey, iteration));
      } else {
        runs.push(await runOpenAiCompatibleAsrIteration(spec, audio, opts, apiKey, iteration));
      }
      await sleep(300);
    }
  }
  return {
    kind: 'voice-input-asr-provider-benchmark',
    generatedAt: new Date().toISOString(),
    options: {
      audio: opts.audio,
      durationMs: Math.round(audio.durationMs),
      providers: specs.map((spec) => spec.id),
      iterations: opts.iterations,
      sourceLanguage: opts.sourceLanguage,
      chunkMs: opts.chunkMs,
      tailSilenceMs: opts.tailSilenceMs,
      baseUrl: opts.baseUrl,
    },
    runs,
    summary: summarizeAsrRuns(runs),
  };
}

function summarizeAsrRuns(runs) {
  const byProvider = new Map();
  for (const run of runs) {
    const list = byProvider.get(run.provider) ?? [];
    list.push(run);
    byProvider.set(run.provider, list);
  }
  const summary = {};
  for (const [provider, list] of byProvider) {
    summary[provider] = {
      iterations: list.length,
      sessionReadyMsMedian: median(list.map((run) => run.timings.sessionReadyMs)),
      firstPartialMsMedian: median(list.map((run) => run.timings.firstPartialMs)),
      completedMsMedian: median(list.map((run) => run.timings.completedMs)),
      afterAudioCompletedMsMedian: median(list.map((run) => run.timings.afterAudioCompletedMs)),
      afterTailSilenceCompletedMsMedian: median(list.map((run) => run.timings.afterTailSilenceCompletedMs)),
      transcriptCharsMedian: median(list.map((run) => run.transcript.length)),
    };
  }
  return summary;
}

async function runRefineBenchmark(opts) {
  const apiKey = await resolveLiteLlmApiKey(opts);
  const models = resolveRefinerModels(opts.models);
  const cases = await resolveRefinerCases(opts);
  const { systemPrompt, promptVersion } = readProductionRefinerPrompt();
  const sharedContext = opts.context ? await readJsonFile(opts.context) : {};
  const runs = [];
  for (const model of models) {
    for (const testCase of cases) {
      for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
        runs.push(await runRefineIteration({
          model,
          testCase,
          iteration,
          apiKey,
          baseUrl: opts.baseUrl,
          timeoutMs: opts.timeoutMs,
          systemPrompt,
          promptVersion,
          sharedContext,
        }));
        await sleep(200);
      }
    }
  }
  return {
    kind: 'voice-input-refine-model-benchmark',
    generatedAt: new Date().toISOString(),
    options: {
      models,
      cases: cases.map((testCase) => testCase.id),
      iterations: opts.iterations,
      baseUrl: opts.baseUrl,
      promptVersion,
    },
    runs,
    summary: summarizeRefineRuns(runs),
  };
}

function resolveRefinerModels(value) {
  const models = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return models.length > 0 ? models : DEFAULT_REFINER_MODELS;
}

async function resolveRefinerCases(opts) {
  if (opts.cases) {
    const parsed = await readJsonFile(opts.cases);
    if (!Array.isArray(parsed)) throw new Error('--cases must be a JSON array');
    return parsed.map(normalizeRefinerCase);
  }
  if (opts.dictationText.trim()) {
    return [normalizeRefinerCase({
      id: 'ad-hoc',
      dictationText: opts.dictationText,
      expectedText: opts.expectedText,
    })];
  }
  return DEFAULT_REFINER_CASES.map(normalizeRefinerCase);
}

function normalizeRefinerCase(value, index = 0) {
  if (!isPlainRecord(value)) throw new Error(`Invalid refine case at index ${index}`);
  const dictationText = stringField(value, 'dictationText') ?? stringField(value, 'text') ?? stringField(value, 'input');
  if (!dictationText?.trim()) throw new Error(`Refine case ${value.id ?? index} is missing dictationText`);
  return {
    id: String(value.id ?? `case-${index + 1}`),
    dictationText: dictationText.trim(),
    expectedText: (stringField(value, 'expectedText') ?? stringField(value, 'expected') ?? '').trim(),
    context: isPlainRecord(value.context) ? value.context : {},
  };
}

async function readJsonFile(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

function readProductionRefinerPrompt() {
  const sourcePath = path.join(REPO_ROOT, 'packages', 'voice-input-core', 'src', 'DictationRefiner.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const version = source.match(/DEFAULT_DICTATION_REFINER_PROMPT_VERSION\s*=\s*'([^']+)'/)?.[1];
  const prompt = source.match(/DEFAULT_DICTATION_REFINER_SYSTEM_PROMPT:\s*string\s*=\s*`([\s\S]*?)`\s*\.trim\(\)/)?.[1];
  if (!version || !prompt) throw new Error(`Could not extract production refiner prompt from ${sourcePath}`);
  return { promptVersion: version, systemPrompt: prompt.trim() };
}

async function runRefineIteration(input) {
  const startedAt = performance.now();
  const context = buildBenchmarkRefinementContext(input.sharedContext, input.testCase.context);
  const userPayload = {
    promptVersion: input.promptVersion,
    context,
    dictationText: input.testCase.dictationText,
  };
  const requestBody = {
    model: input.model,
    response_format: { type: 'json_object' },
    prompt_cache_key: makeRefinerPromptCacheKey({
      model: input.model,
      schemaName: 'dictation_refinement',
      promptVersion: input.promptVersion,
      systemPrompt: input.systemPrompt,
      scope: 'voice-input-refine-benchmark',
    }),
    messages: [
      { role: 'system', content: input.systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          schemaName: 'dictation_refinement',
          input: userPayload,
        }),
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  let headersAt;
  let bodyAt;
  try {
    const response = await fetch(joinProxyPath(input.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    headersAt = performance.now();
    const raw = await response.text();
    bodyAt = performance.now();
    const parsed = parseJsonObject(raw);
    if (!response.ok) {
      throw new Error(textModelErrorMessage(parsed, raw, response.status));
    }
    const content = extractChatMessageContent(parsed);
    const output = parseJsonObject(content);
    const refinedText = typeof output.text === 'string' ? normalizeBenchmarkText(output.text) : '';
    const elapsedMs = Math.round(performance.now() - startedAt);
    return {
      iteration: input.iteration,
      model: input.model,
      caseId: input.testCase.id,
      ok: Boolean(refinedText),
      timings: {
        headersMs: delta(headersAt, startedAt),
        bodyMs: delta(bodyAt, startedAt),
        totalMs: elapsedMs,
      },
      usage: extractChatUsage(parsed),
      dictationText: input.testCase.dictationText,
      expectedText: input.testCase.expectedText || undefined,
      refinedText,
      quality: input.testCase.expectedText
        ? compareBenchmarkText(refinedText, input.testCase.expectedText)
        : undefined,
    };
  } catch (error) {
    return {
      iteration: input.iteration,
      model: input.model,
      caseId: input.testCase.id,
      ok: false,
      timings: {
        headersMs: delta(headersAt, startedAt),
        bodyMs: delta(bodyAt, startedAt),
        totalMs: Math.round(performance.now() - startedAt),
      },
      dictationText: input.testCase.dictationText,
      expectedText: input.testCase.expectedText || undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildBenchmarkRefinementContext(sharedContext, caseContext) {
  return {
    uiLanguage: 'zh-CN',
    sourceLanguage: 'zh-CN',
    userRefinementInstructions: '',
    userDictionary: [
      'Codex',
      'LiteLLM',
      'AI Gateway',
      'prompt',
      'refine',
      'ASR',
      'gpt-realtime-whisper',
      'qwen3-asr-flash-realtime',
      'Volcengine SAUC ASR',
      'YouTube',
      'skill',
      'Vibe Coding',
      'Claude Code',
      'OpenClaw',
      'GitLab',
      'MR',
    ].join('\n'),
    voiceInputHistory: [
      '以下是较早到较新的语音输入历史，只用于参考术语和表达习惯：',
      '- 我们现在语音输入的 refine prompt 要尽量保持 cache 命中。',
      '- 看一下 LiteLLM gateway 支持的 ASR 模型和 refine 模型。',
      '- 这个 MR 需要说明清楚发生了什么，以及为什么这样改。',
    ].join('\n'),
    selectionBefore: '',
    selectedText: '',
    selectionAfter: '',
    ...filterContextRecord(sharedContext),
    ...filterContextRecord(caseContext),
  };
}

function filterContextRecord(value) {
  if (!isPlainRecord(value)) return {};
  const out = {};
  for (const key of [
    'uiLanguage',
    'sourceLanguage',
    'userRefinementInstructions',
    'userDictionary',
    'voiceInputHistory',
    'selectionBefore',
    'selectedText',
    'selectionAfter',
    'replyToMessage',
    'userDictionaryMatches',
  ]) {
    if (typeof value[key] === 'string') out[key] = value[key];
  }
  return out;
}

function makeRefinerPromptCacheKey(input) {
  return [
    'voice-refine',
    shortHash(input.model),
    shortHash(input.schemaName),
    shortHash(input.promptVersion),
    shortHash(input.systemPrompt),
    shortHash(input.scope ?? ''),
  ].join(':');
}

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function parseJsonObject(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('Expected JSON object');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Invalid JSON response: ${trimmed.slice(0, 160)}`);
    parsed = JSON.parse(match[0]);
  }
  if (!isPlainRecord(parsed)) throw new Error('Expected JSON object');
  return parsed;
}

function extractChatMessageContent(parsed) {
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  const content = choice?.message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  throw new Error('Empty refinement response');
}

function extractChatUsage(parsed) {
  const usage = isPlainRecord(parsed.usage) ? parsed.usage : {};
  const promptDetails = isPlainRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const inputDetails = isPlainRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    promptTokens: firstNumber(usage.prompt_tokens, usage.input_tokens),
    completionTokens: firstNumber(usage.completion_tokens, usage.output_tokens),
    totalTokens: firstNumber(usage.total_tokens),
    cachedTokens: firstNumber(
      promptDetails.cached_tokens,
      inputDetails.cached_tokens,
      usage.cached_tokens,
      usage.cache_read_input_tokens,
      usage.cache_read_tokens,
    ),
  };
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function textModelErrorMessage(parsed, raw, status) {
  const message = isPlainRecord(parsed.error) && typeof parsed.error.message === 'string'
    ? parsed.error.message
    : typeof parsed.message === 'string'
      ? parsed.message
      : raw.slice(0, 500);
  return `LiteLLM refine failed (${status}): ${message}`;
}

function normalizeBenchmarkText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function compareBenchmarkText(actual, expected) {
  const normalizedActual = normalizeBenchmarkText(actual);
  const normalizedExpected = normalizeBenchmarkText(expected);
  const distance = levenshteinDistance(normalizedActual, normalizedExpected);
  const maxLength = Math.max(normalizedActual.length, normalizedExpected.length, 1);
  return {
    exact: normalizedActual === normalizedExpected,
    editDistance: distance,
    similarity: Number((1 - distance / maxLength).toFixed(4)),
  };
}

function levenshteinDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function summarizeRefineRuns(runs) {
  const byModel = new Map();
  for (const run of runs) {
    const list = byModel.get(run.model) ?? [];
    list.push(run);
    byModel.set(run.model, list);
  }
  const summary = {};
  for (const [model, list] of byModel) {
    const okRuns = list.filter((run) => run.ok);
    const qualityRuns = okRuns.filter((run) => run.quality);
    summary[model] = {
      iterations: list.length,
      ok: okRuns.length,
      totalMsMedian: median(okRuns.map((run) => run.timings.totalMs)),
      headersMsMedian: median(okRuns.map((run) => run.timings.headersMs)),
      cachedTokensMedian: median(okRuns.map((run) => run.usage?.cachedTokens)),
      similarityMedian: median(qualityRuns.map((run) => run.quality.similarity)),
      exact: qualityRuns.filter((run) => run.quality.exact).length,
    };
  }
  return summary;
}

function stringField(value, key) {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

const VOLC_PROTOCOL_VERSION = 0x1;
const VOLC_HEADER_SIZE_WORDS = 0x1;
const VOLC_SERIALIZATION_NONE = 0x0;
const VOLC_SERIALIZATION_JSON = 0x1;
const VOLC_COMPRESSION_NONE = 0x0;
const VOLC_COMPRESSION_GZIP = 0x1;
const VOLC_MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1;
const VOLC_MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2;
const VOLC_MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0x9;
const VOLC_FLAG_NO_SEQUENCE = 0x0;
const VOLC_FLAG_POSITIVE_SEQUENCE = 0x1;
const VOLC_FLAG_NEGATIVE_SEQUENCE = 0x3;

function encodeVolcengineBenchmarkFullClientRequest(payload) {
  return encodeVolcengineBenchmarkRequest({
    messageType: VOLC_MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    flags: VOLC_FLAG_NO_SEQUENCE,
    serialization: VOLC_SERIALIZATION_JSON,
    compression: VOLC_COMPRESSION_GZIP,
    payload: Buffer.from(JSON.stringify(payload), 'utf8'),
  });
}

function encodeVolcengineBenchmarkAudioOnlyRequest(pcm, sequence) {
  const hasPayload = pcm.length > 0;
  return encodeVolcengineBenchmarkRequest({
    messageType: VOLC_MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    flags: sequence < 0
      ? VOLC_FLAG_NEGATIVE_SEQUENCE
      : VOLC_FLAG_POSITIVE_SEQUENCE,
    sequence,
    serialization: VOLC_SERIALIZATION_NONE,
    compression: hasPayload ? VOLC_COMPRESSION_GZIP : VOLC_COMPRESSION_NONE,
    payload: pcm,
  });
}

function encodeVolcengineBenchmarkRequest(input) {
  const payload = input.compression === VOLC_COMPRESSION_GZIP ? gzipSync(input.payload) : input.payload;
  const header = Buffer.from([
    (VOLC_PROTOCOL_VERSION << 4) | VOLC_HEADER_SIZE_WORDS,
    (input.messageType << 4) | input.flags,
    (input.serialization << 4) | input.compression,
    0x00,
  ]);
  const sequence = input.flags === VOLC_FLAG_NO_SEQUENCE ? Buffer.alloc(0) : Buffer.alloc(4);
  if (sequence.length > 0) sequence.writeInt32BE(input.sequence ?? 0, 0);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, sequence, payloadSize, payload]);
}

function decodeVolcengineBenchmarkMessage(data) {
  if (data.length < 4) return { messageType: 0, flags: 0 };
  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let offset = headerSize;
  let sequence;
  if (messageType === 0xf) {
    if (data.length < offset + 8) return { messageType, flags };
    const code = data.readInt32BE(offset);
    offset += 4;
    const payloadSize = data.readUInt32BE(offset);
    offset += 4;
    if (payloadSize <= 0 || data.length < offset + payloadSize) {
      return { messageType, flags, payload: { code } };
    }
    let payloadBuffer = data.subarray(offset, offset + payloadSize);
    if (compression === VOLC_COMPRESSION_GZIP) payloadBuffer = gunzipSync(payloadBuffer);
    const payloadText = payloadBuffer.toString('utf8');
    return { messageType, flags, payload: { code, message: payloadText }, payloadText };
  }
  if (
    flags === VOLC_FLAG_POSITIVE_SEQUENCE
    || flags === VOLC_FLAG_NEGATIVE_SEQUENCE
  ) {
    if (data.length < offset + 4) return { messageType, flags };
    sequence = data.readInt32BE(offset);
    offset += 4;
  }
  if (data.length < offset + 4) return { messageType, flags, sequence };
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  if (payloadSize <= 0 || data.length < offset + payloadSize) return { messageType, flags, sequence };
  let payloadBuffer = data.subarray(offset, offset + payloadSize);
  if (compression === VOLC_COMPRESSION_GZIP) payloadBuffer = gunzipSync(payloadBuffer);
  const payloadText = payloadBuffer.toString('utf8');
  if (serialization === VOLC_SERIALIZATION_JSON || looksLikeJson(payloadText)) {
    try {
      return { messageType, flags, sequence, payload: JSON.parse(payloadText), payloadText };
    } catch {
      return { messageType, flags, sequence, payloadText };
    }
  }
  return { messageType, flags, sequence, payloadText };
}

function rawDataToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function volcengineMessageTypeName(messageType) {
  switch (messageType) {
    case 0x9:
      return 'full_server_response';
    case 0xb:
      return 'server_ack';
    case 0xf:
      return 'server_error';
    default:
      return `message_${messageType}`;
  }
}

function extractBenchmarkTranscript(payload) {
  const values = collectBenchmarkStringFields(payload, new Set(['text', 'transcript', 'sentence', 'asr_text']));
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] ?? '';
}

function extractBenchmarkErrorMessage(payload) {
  const values = collectBenchmarkStringFields(payload, new Set(['message', 'error', 'reason']));
  return values.map((value) => value.trim()).find(Boolean);
}

function collectBenchmarkStringFields(value, keys) {
  if (typeof value === 'string') return [];
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => collectBenchmarkStringFields(item, keys));
  const result = [];
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof child === 'string') {
      result.push(child);
    }
    result.push(...collectBenchmarkStringFields(child, keys));
  }
  return result;
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeJson(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function previewString(value, max = 120) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function previewJson(value, max = 600) {
  if (value === undefined) return undefined;
  try {
    return previewString(JSON.stringify(value), max);
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runReplayIteration(mode, audio, opts, iteration) {
  const marks = {};
  let session;
  let preconnectMs;

  if (mode === 'preconnected') {
    marks.preconnectStart = performance.now();
    session = await openRealtimeSession(opts, marks);
    marks.preconnectReady = performance.now();
    preconnectMs = marks.preconnectReady - marks.preconnectStart;
  }

  marks.press = performance.now();
  if (!session) {
    session = await openRealtimeSession(opts, marks);
  }

  marks.audioStart = performance.now();
  await streamAudio(session.ws, audio.pcm24k, opts.chunkMs, true);
  marks.audioFinished = performance.now();
  session.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  marks.commitSent = performance.now();

  await waitFor(() => session.completedAt !== undefined, opts.timeoutMs);
  marks.completed = session.completedAt;

  let paste = null;
  if (opts.paste !== 'off') {
    marks.pasteStart = performance.now();
    paste = await pasteIntoFrontmostTarget(session.completedTranscript);
    marks.pasteFinished = performance.now();
  }

  try {
    session.ws.close();
  } catch {
    // ignore
  }

  const base = marks.press;
  return {
    iteration,
    mode,
    fixture: {
      audioPath: opts.audio,
      durationMs: Math.round(audio.durationMs),
      sampleRate: audio.sampleRate,
      chunkMs: opts.chunkMs,
    },
    preconnectMs: round(preconnectMs),
    timings: {
      authReadyMs: delta(marks.authReady, base),
      wsOpenMs: delta(marks.wsOpen, base),
      sessionUpdatedMs: delta(marks.sessionUpdated, base),
      audioStartMs: delta(marks.audioStart, base),
      audioFinishedMs: delta(marks.audioFinished, base),
      commitSentMs: delta(marks.commitSent, base),
      firstDeltaMs: delta(session.firstDeltaAt, base),
      completedMs: delta(marks.completed, base),
      pasteStartMs: delta(marks.pasteStart, base),
      pasteFinishedMs: delta(marks.pasteFinished, base),
    },
    transcript: session.completedTranscript,
    eventTypes: session.events.map((event) => event.type),
    paste,
  };
}

function delta(value, base) {
  return value === undefined ? undefined : round(Math.max(0, value - base));
}

function round(value) {
  return value === undefined ? undefined : Math.round(value);
}

// helper 可以在最终结果之前先流式吐出进度行（capture-target 会先单独吐一行前台
// 窗口 frame，好让浮窗尽早选屏），所以结果一律取最后一行非空 JSON。
function parseHelperResult(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) throw new Error('Empty helper response');
  return JSON.parse(lastLine);
}

async function pasteIntoFrontmostTarget(text) {
  if (process.platform !== 'darwin') {
    throw new Error('--paste is currently supported only on macOS');
  }
  const helper = await buildMacTextInsertionHelper();
  const capture = parseHelperResult(await execFileStdout(helper, ['--command', 'capture-target']));
  if (!capture.ok || !capture.target) {
    throw new Error(capture.error ?? 'Could not capture frontmost paste target');
  }
  const args = [
    '--command', 'paste-verified',
    '--target-pid', String(capture.target.pid ?? ''),
    '--target-bundle-id', capture.target.bundleId ?? '',
    '--target-name', capture.target.processName ?? '',
  ];
  const stdout = await spawnWithInput(helper, args, text, 5000);
  return parseHelperResult(stdout);
}

async function buildMacTextInsertionHelper() {
  const source = path.join(REPO_ROOT, 'apps', 'desktop', 'native', 'voice-input', 'macos-text-insertion-helper.swift');
  const out = path.join(os.tmpdir(), 'xdt-voice-input-benchmark', 'xdt-macos-text-insertion-helper');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const needsBuild = !fs.existsSync(out)
    || fs.statSync(out).mtimeMs < fs.statSync(source).mtimeMs;
  if (needsBuild) {
    await execFile('/usr/bin/swiftc', [source, '-O', '-o', out]);
  }
  return out;
}

async function execFileStdout(file, args) {
  const { stdout } = await execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout;
}

async function spawnWithInput(file, args, input, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `Process exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function runReplay(opts) {
  if (!['cold', 'preconnected', 'both'].includes(opts.mode)) {
    throw new Error('--mode must be cold, preconnected, or both');
  }
  if (!['off', 'frontmost'].includes(opts.paste)) {
    throw new Error('--paste must be off or frontmost');
  }

  await ensureFixture(opts.audio, opts.text);
  const audio = readWavPcm16Mono(opts.audio);
  const modes = opts.mode === 'both' ? ['cold', 'preconnected'] : [opts.mode];
  const runs = [];
  for (const mode of modes) {
    for (let i = 1; i <= opts.iterations; i += 1) {
      runs.push(await runReplayIteration(mode, audio, opts, i));
    }
  }
  return {
    kind: 'voice-input-replay-benchmark',
    generatedAt: new Date().toISOString(),
    options: {
      mode: opts.mode,
      iterations: opts.iterations,
      audio: opts.audio,
      sourceLanguage: opts.sourceLanguage,
      chunkMs: opts.chunkMs,
      paste: opts.paste,
    },
    runs,
    summary: summarizeReplayRuns(runs),
  };
}

function summarizeReplayRuns(runs) {
  const byMode = new Map();
  for (const run of runs) {
    const list = byMode.get(run.mode) ?? [];
    list.push(run);
    byMode.set(run.mode, list);
  }
  const summary = {};
  for (const [mode, list] of byMode) {
    summary[mode] = {
      iterations: list.length,
      sessionUpdatedMsMedian: median(list.map((run) => run.timings.sessionUpdatedMs)),
      firstDeltaMsMedian: median(list.map((run) => run.timings.firstDeltaMs)),
      completedMsMedian: median(list.map((run) => run.timings.completedMs)),
      pasteFinishedMsMedian: median(list.map((run) => run.timings.pasteFinishedMs)),
    };
  }
  return summary;
}

function median(values) {
  const clean = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (clean.length === 0) return undefined;
  return clean[Math.floor(clean.length / 2)];
}

function parseTimestamp(line) {
  const match = line.match(/^\[([^\]]+)\]/);
  return match ? Date.parse(match[1]) : undefined;
}

function readBraceBlock(lines, startIndex) {
  let block = lines[startIndex];
  let depth = (lines[startIndex].match(/\{/g) ?? []).length - (lines[startIndex].match(/\}/g) ?? []).length;
  let i = startIndex + 1;
  while (i < lines.length && depth > 0) {
    block += `\n${lines[i]}`;
    depth += (lines[i].match(/\{/g) ?? []).length;
    depth -= (lines[i].match(/\}/g) ?? []).length;
    i += 1;
  }
  return { block, nextIndex: i - 1 };
}

function extractQuoted(block, key) {
  const match = block.match(new RegExp(`${key}: '([^']*)'`));
  return match?.[1];
}

function extractNumber(block, key) {
  const match = block.match(new RegExp(`${key}: (-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : undefined;
}

function extractJsonNumber(line, key) {
  const match = line.match(new RegExp(`"${key}":(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : undefined;
}

function parseVoiceInputReport(logPath, latest) {
  const text = readTextTail(logPath, LOG_TAIL_BYTES);
  const lines = text.split(/\r?\n/);
  const sessions = [];
  let pendingMic = {};
  let pendingShortcutAt;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const ts = parseTimestamp(line);
    if (!ts) continue;

    if (line.includes('global shortcut invoked')) {
      pendingShortcutAt = ts;
      continue;
    }
    if (line.includes('microphone start requested')) {
      pendingMic.requestedAt = ts;
      pendingMic.requestedElapsedMs = extractJsonNumber(line, 'elapsedMs');
      continue;
    }
    if (line.includes('microphone started')) {
      pendingMic.startedAt = ts;
      pendingMic.startedElapsedMs = extractJsonNumber(line, 'elapsedMs');
      continue;
    }
    if (line.includes('first pcm16k chunk')) {
      const currentSession = sessions[sessions.length - 1];
      if (currentSession && ts >= currentSession.startAt && ts - currentSession.startAt < 10_000) {
        currentSession.mic = { ...(currentSession.mic ?? {}), firstPcmAt: ts };
      } else {
        pendingMic.firstPcmAt = ts;
      }
      continue;
    }
    if (line.includes('benchmark_fixture_ready')) {
      const currentSession = sessions[sessions.length - 1];
      if (currentSession) {
        currentSession.mic = {
          ...(currentSession.mic ?? {}),
          fixtureReadyAt: ts,
          fixtureDurationMs: extractJsonNumber(line, 'durationMs'),
        };
      }
      continue;
    }
    if (line.includes('benchmark_fixture_finished')) {
      const currentSession = sessions[sessions.length - 1];
      if (currentSession) {
        currentSession.mic = {
          ...(currentSession.mic ?? {}),
          fixtureFinishedAt: ts,
          fixtureDurationMs: extractJsonNumber(line, 'durationMs') ?? currentSession.mic?.fixtureDurationMs,
        };
      }
      continue;
    }

    if (line.includes('[voice-input] timeline {')) {
      const { block, nextIndex } = readBraceBlock(lines, i);
      i = nextIndex;
      const type = extractQuoted(block, 'type');
      const runId = extractQuoted(block, 'runId');
      if (!type || !runId) continue;
      if (type === 'start_clicked') {
        const session = {
          runId,
          startAt: ts,
          shortcutToStartMs: pendingShortcutAt ? ts - pendingShortcutAt : undefined,
          mic: pendingMic,
          timeline: {},
        };
        sessions.push(session);
        pendingMic = {};
        pendingShortcutAt = undefined;
      }
      const session = [...sessions].reverse().find((candidate) => candidate.runId === runId);
      if (!session) continue;
      session.timeline[type] = {
        at: ts,
        elapsedMs: extractNumber(block, 'elapsedMs'),
        textChars: extractNumber(block, 'textChars'),
        refinedTextChars: extractNumber(block, 'refinedTextChars'),
      };
      continue;
    }

    if (line.includes('global background paste started')) {
      const session = sessions[sessions.length - 1];
      if (session) {
        session.paste = {
          ...(session.paste ?? {}),
          startedAt: ts,
          chars: extractJsonNumber(line, 'chars'),
        };
      }
      continue;
    }

    if (line.includes('native global voice input paste result')) {
      const { block, nextIndex } = readBraceBlock(lines, i);
      i = nextIndex;
      const session = sessions[sessions.length - 1];
      if (session) {
        session.paste = {
          ...(session.paste ?? {}),
          resultAt: ts,
          outcome: extractQuoted(block, 'outcome'),
          totalMs: extractNumber(block, 'totalMs'),
          commandVMs: extractNumber(block, 'commandVMs'),
          timeToCommandVMs: extractNumber(block, 'timeToCommandVMs'),
          waitPasteboardMs: extractNumber(block, 'waitPasteboardMs'),
          postPasteDelayMs: extractNumber(block, 'postPasteDelayMs'),
        };
      }
    }
  }

  const selected = sessions.slice(-latest).map((session) => ({
    runId: session.runId,
    startedAt: new Date(session.startAt).toISOString(),
    shortcutToStartMs: session.shortcutToStartMs,
    micStartRequestedElapsedMs: session.mic?.requestedElapsedMs,
    micStartedElapsedMs: session.mic?.startedElapsedMs,
    firstPcmAfterStartMs: session.mic?.firstPcmAt ? session.mic.firstPcmAt - session.startAt : undefined,
    fixtureReadyAfterStartMs: session.mic?.fixtureReadyAt ? session.mic.fixtureReadyAt - session.startAt : undefined,
    fixtureFinishedAfterStartMs: session.mic?.fixtureFinishedAt ? session.mic.fixtureFinishedAt - session.startAt : undefined,
    fixtureDurationMs: session.mic?.fixtureDurationMs,
    asrConnectedElapsedMs: session.timeline.asr_connected?.elapsedMs,
    firstAudioChunkElapsedMs: session.timeline.first_audio_chunk?.elapsedMs,
    firstPartialElapsedMs: session.timeline.first_partial?.elapsedMs,
    stableReceivedAfterStartMs: session.timeline.stable_received
      ? session.timeline.stable_received.at - session.startAt
      : undefined,
    submittedAfterStartMs: session.timeline.submitted
      ? session.timeline.submitted.at - session.startAt
      : undefined,
    refineDoneAfterStartMs: (session.timeline.refine_accepted ?? session.timeline.refine_rejected)
      ? (session.timeline.refine_accepted ?? session.timeline.refine_rejected).at - session.startAt
      : undefined,
    refineResult: session.timeline.refine_accepted
      ? 'accepted'
      : session.timeline.refine_rejected
        ? 'rejected'
        : undefined,
    refineElapsedMs: (session.timeline.refine_accepted ?? session.timeline.refine_rejected)?.elapsedMs,
    pasteStartAfterStartMs: session.paste?.startedAt ? session.paste.startedAt - session.startAt : undefined,
    pasteResultAfterStartMs: session.paste?.resultAt ? session.paste.resultAt - session.startAt : undefined,
    pasteOutcome: session.paste?.outcome,
    pasteTotalMs: session.paste?.totalMs,
    pasteTimeToCommandVMs: session.paste?.timeToCommandVMs,
  }));

  return {
    kind: 'voice-input-log-report',
    generatedAt: new Date().toISOString(),
    logPath,
    sessions: selected,
  };
}

function readTextTail(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const start = stat.size - bytesToRead;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, start);
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

async function runScenario(opts) {
  if (process.platform !== 'darwin') {
    throw new Error('scenario benchmark currently supports macOS only.');
  }
  if (!['frontmost', 'textedit'].includes(opts.target)) {
    throw new Error('--target must be frontmost or textedit');
  }

  await ensureFixture(opts.audio, opts.text);
  const audio = readWavPcm16Mono(opts.audio);
  let scenarioStartedAt = Date.now();
  if (opts.target === 'textedit') {
    await focusTextEditScratchpad();
  }
  scenarioStartedAt = Date.now();
  await pressMacShortcutReliably(opts.shortcut);
  await sleep(Math.round(audio.durationMs + opts.settleMs));
  await pressMacShortcutReliably(opts.shortcut);

  const report = await waitForScenarioReport(opts.log, scenarioStartedAt, opts.timeoutMs);
  return {
    kind: 'voice-input-scenario-benchmark',
    generatedAt: new Date().toISOString(),
    options: {
      audio: opts.audio,
      audioDurationMs: Math.round(audio.durationMs),
      shortcut: opts.shortcut,
      target: opts.target,
      settleMs: opts.settleMs,
    },
    session: report,
  };
}

async function waitForScenarioReport(logPath, scenarioStartedAt, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const report = parseVoiceInputReport(logPath, 5);
    const session = [...report.sessions].reverse().find((candidate) => {
      const startedAt = Date.parse(candidate.startedAt);
      return Number.isFinite(startedAt) && startedAt >= scenarioStartedAt - 1000;
    });
    if (session?.pasteResultAfterStartMs !== undefined || session?.pasteOutcome) {
      return session;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for scenario result in ${logPath}`);
}

async function focusTextEditScratchpad() {
  // Reuse the front document across iterations instead of opening a new one
  // each time — the latter litters the desktop with 8+ empty docs after a
  // benchmark run. Clear its content so each iteration starts from the same
  // blank state.
  await execFile('/usr/bin/osascript', [
    '-e',
    [
      'tell application "TextEdit"',
      '  activate',
      '  if (count documents) = 0 then',
      '    make new document',
      '  end if',
      '  set text of front document to ""',
      'end tell',
    ].join('\n'),
  ]);
  await sleep(300);
}

async function pressMacShortcutReliably(shortcut) {
  await releaseMacShortcut(shortcut);
  await sleep(200);
  await pressMacShortcut(shortcut);
}

async function pressMacShortcut(shortcut) {
  const parsed = parseMacShortcut(shortcut);
  const script = ['tell application "System Events"', ...macShortcutEventLines(parsed), 'end tell'].join('\n');
  await execFile('/usr/bin/osascript', ['-e', script]);
}

async function releaseMacShortcut(shortcut) {
  const parsed = parseMacShortcut(shortcut);
  const lines = ['tell application "System Events"'];
  if (parsed.keyCode !== undefined) {
    lines.push(`  key up ${parsed.keyCode}`);
  }
  for (const modifier of [...parsed.modifiers].reverse()) {
    lines.push(`  key up ${modifier}`);
  }
  lines.push('end tell');
  const script = lines.join('\n');
  await execFile('/usr/bin/osascript', ['-e', script]);
}

function macShortcutEventLines(parsed) {
  const keyLine = parsed.keyCode !== undefined
    ? `key code ${parsed.keyCode}`
    : `keystroke "${parsed.key}"`;
  const scriptLines = [];
  if (parsed.keyCode !== undefined) {
    scriptLines.push(`  key up ${parsed.keyCode}`);
  }
  for (const modifier of [...parsed.modifiers].reverse()) {
    scriptLines.push(`  key up ${modifier}`);
  }
  for (const modifier of parsed.modifiers) {
    scriptLines.push(`  key down ${modifier}`);
  }
  scriptLines.push(`  ${keyLine}`);
  if (parsed.keyCode !== undefined) {
    scriptLines.push(`  key up ${parsed.keyCode}`);
  }
  for (const modifier of [...parsed.modifiers].reverse()) {
    scriptLines.push(`  key up ${modifier}`);
  }
  return scriptLines;
}

function parseMacShortcut(shortcut) {
  const functionKeyCodes = new Map([
    ['f1', 122],
    ['f2', 120],
    ['f3', 99],
    ['f4', 118],
    ['f5', 96],
    ['f6', 97],
    ['f7', 98],
    ['f8', 100],
    ['f9', 101],
    ['f10', 109],
    ['f11', 103],
    ['f12', 111],
    ['f13', 105],
    ['f14', 107],
    ['f15', 113],
    ['f16', 106],
    ['f17', 64],
    ['f18', 79],
    ['f19', 80],
    ['f20', 90],
  ]);
  const parts = shortcut
    .toLowerCase()
    .replaceAll('cmd', 'command')
    .replaceAll('meta', 'command')
    .replaceAll('opt', 'option')
    .replaceAll('alt', 'option')
    .replaceAll('ctrl', 'control')
    .split(/[+ ]+/)
    .filter(Boolean);
  const modifiers = [];
  let key = '';
  for (const part of parts) {
    if (['command', 'option', 'control', 'shift'].includes(part)) {
      modifiers.push(part);
    } else {
      key = part;
    }
  }
  if (!key) throw new Error(`Invalid shortcut: ${shortcut}`);
  if (key === 'space') return { modifiers, keyCode: 49 };
  if (functionKeyCodes.has(key)) return { modifiers, keyCode: functionKeyCodes.get(key) };
  if (/^[a-z0-9]$/.test(key)) return { modifiers, key };
  throw new Error(`Unsupported shortcut key for scenario benchmark: ${key}`);
}

async function writeReport(report, outPath) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

function printReplay(report) {
  console.log(`Voice input replay benchmark (${report.generatedAt})`);
  console.log(`fixture: ${report.options.audio}`);
  for (const run of report.runs) {
    const t = run.timings;
    console.log(
      [
        `#${run.iteration}`,
        run.mode,
        `preconnect=${formatMs(run.preconnectMs)}`,
        `session=${formatMs(t.sessionUpdatedMs)}`,
        `firstDelta=${formatMs(t.firstDeltaMs)}`,
        `completed=${formatMs(t.completedMs)}`,
        `paste=${formatMs(t.pasteFinishedMs)}`,
        `chars=${run.transcript.length}`,
      ].join('  '),
    );
  }
  console.log('summary:', JSON.stringify(report.summary));
}

function printAsrReport(report) {
  console.log(`Voice input ASR provider benchmark (${report.generatedAt})`);
  console.log(
    `fixture: ${report.options.audio} duration=${report.options.durationMs}ms tailSilence=${report.options.tailSilenceMs ?? 0}ms`,
  );
  for (const run of report.runs) {
    const t = run.timings;
    console.log(
      [
        `#${run.iteration}`,
        run.provider,
        `ws=${formatMs(t.wsOpenMs)}`,
        `ready=${formatMs(t.sessionReadyMs)}`,
        `firstPartial=${formatMs(t.firstPartialMs)}`,
        `completed=${formatMs(t.completedMs)}`,
        `afterAudio=${formatMs(t.afterAudioCompletedMs)}`,
        `afterTail=${formatMs(t.afterTailSilenceCompletedMs)}`,
        `chars=${run.transcript.length}`,
      ].join('  '),
    );
    console.log(`  transcript: ${run.transcript}`);
  }
  console.log('summary:', JSON.stringify(report.summary));
}

function printRefineReport(report) {
  console.log(`Voice input refine model benchmark (${report.generatedAt})`);
  console.log(`models: ${report.options.models.join(', ')}`);
  console.log(`cases: ${report.options.cases.join(', ')}`);
  for (const run of report.runs) {
    const quality = run.quality
      ? `similarity=${run.quality.similarity} edit=${run.quality.editDistance} exact=${run.quality.exact ? 'yes' : 'no'}`
      : 'similarity=-';
    console.log(
      [
        `#${run.iteration}`,
        run.model,
        run.caseId,
        run.ok ? 'ok' : 'failed',
        `headers=${formatMs(run.timings.headersMs)}`,
        `total=${formatMs(run.timings.totalMs)}`,
        `cached=${run.usage?.cachedTokens ?? '-'}`,
        quality,
      ].join('  '),
    );
    if (run.error) {
      console.log(`  error: ${run.error}`);
    } else {
      console.log(`  input:    ${run.dictationText}`);
      if (run.expectedText) console.log(`  expected: ${run.expectedText}`);
      console.log(`  refined:  ${run.refinedText}`);
    }
  }
  console.log('summary:', JSON.stringify(report.summary));
}

function printLogReport(report) {
  console.log(`Voice input log report (${report.generatedAt})`);
  console.log(`log: ${report.logPath}`);
  for (const session of report.sessions) {
    console.log(
      [
        session.startedAt,
        session.runId.slice(0, 8),
        `mic=${formatMs(session.micStartedElapsedMs)}`,
        `firstPcm=${formatMs(session.firstPcmAfterStartMs)}`,
        `asr=${formatMs(session.asrConnectedElapsedMs)}`,
        `partial=${formatMs(session.firstPartialElapsedMs)}`,
        `submitted=${formatMs(session.submittedAfterStartMs)}`,
        `refine=${formatMs(session.refineElapsedMs)}${session.refineResult ? `/${session.refineResult}` : ''}`,
        `pasteCmd=${formatMs(session.pasteTimeToCommandVMs)}`,
        `paste=${formatMs(session.pasteTotalMs)}`,
        `outcome=${session.pasteOutcome ?? '-'}`,
      ].join('  '),
    );
  }
}

function printScenario(report) {
  const session = report.session;
  console.log(`Voice input scenario benchmark (${report.generatedAt})`);
  console.log(`audio=${report.options.audio} duration=${report.options.audioDurationMs}ms shortcut=${report.options.shortcut} target=${report.options.target}`);
  console.log(
    [
      session.startedAt,
      session.runId.slice(0, 8),
      `mic=${formatMs(session.micStartedElapsedMs)}`,
      `fixtureReady=${formatMs(session.fixtureReadyAfterStartMs)}`,
      `fixtureDone=${formatMs(session.fixtureFinishedAfterStartMs)}`,
      `asr=${formatMs(session.asrConnectedElapsedMs)}`,
      `partial=${formatMs(session.firstPartialElapsedMs)}`,
      `submitted=${formatMs(session.submittedAfterStartMs)}`,
      `refine=${formatMs(session.refineElapsedMs)}${session.refineResult ? `/${session.refineResult}` : ''}`,
      `pasteCmd=${formatMs(session.pasteTimeToCommandVMs)}`,
      `paste=${formatMs(session.pasteTotalMs)}`,
      `outcome=${session.pasteOutcome ?? '-'}`,
    ].join('  '),
  );
}

function formatMs(value) {
  return typeof value === 'number' ? `${Math.round(value)}ms` : '-';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  if ((opts.command === 'asr' || opts.command === 'refine') && !opts.baseUrl) {
    throw new Error('缺少 LiteLLM gateway: 请传 --base-url 或设置 VITE_XD_GATEWAY_BASE_URL');
  }

  let report;
  if (opts.command === 'replay') {
    report = await runReplay(opts);
    await writeReport(report, opts.out);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printReplay(report);
  } else if (opts.command === 'asr') {
    report = await runAsrBenchmark(opts);
    await writeReport(report, opts.out);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printAsrReport(report);
  } else if (opts.command === 'refine') {
    report = await runRefineBenchmark(opts);
    await writeReport(report, opts.out);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printRefineReport(report);
  } else if (opts.command === 'scenario') {
    report = await runScenario(opts);
    await writeReport(report, opts.out);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printScenario(report);
  } else if (opts.command === 'fixture') {
    await ensureFixture(opts.audio, opts.text);
    const audio = readWavPcm16Mono(opts.audio);
    report = {
      kind: 'voice-input-fixture',
      generatedAt: new Date().toISOString(),
      audioPath: opts.audio,
      sampleRate: audio.sampleRate,
      durationMs: Math.round(audio.durationMs),
      pcm16kBytes: audio.pcm16k.length,
      pcm24kBytes: audio.pcm24k.length,
    };
    await writeReport(report, opts.out);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`fixture: ${opts.audio}`);
      console.log(`duration=${Math.round(audio.durationMs)}ms sourceRate=${audio.sampleRate} pcm24kBytes=${audio.pcm24k.length}`);
    }
  } else if (opts.command === 'report') {
    report = parseVoiceInputReport(opts.log, opts.latest);
    await writeReport(report, opts.out);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printLogReport(report);
  } else {
    throw new Error(`Unknown command: ${opts.command}`);
  }
  if (!opts.json) console.log(`wrote ${opts.out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
