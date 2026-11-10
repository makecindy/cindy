// Replays recorded Claude Code and Codex turns through the app's speed
// measurement and compares what the speed panel would have shown with the real
// usage in the recording. Takes recordings from scripts/token-speed-capture.ts,
// raw (.jsonl) or compact (.json); with no argument it replays the fixtures the
// tests use.
//
// Run with: pnpm exec tsx scripts/token-speed-replay.ts [capture.jsonl | fixture.json ...]
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  newClaudeGenerationState,
  observeClaudeSpeedEvent,
  settleClaudeSpeedRequest,
  type ClaudeSpeedStreamEvent,
} from '../packages/maker-core/src/agents/claude-code/generation-timing.js';
import {
  expandRecordedStream,
  type RecordedStream,
} from '../packages/maker-core/src/agents/claude-code/recorded-stream-fixture.js';
import {
  expandCodexStream,
  type RecordedCodexStream,
} from '../packages/maker-core/src/agents/codex/recorded-stream-fixture.js';
import {
  beginCodexGenerationTurn,
  codexSpeedSnapshot,
  finalizeCodexGenerationTurn,
  newCodexRuntimeState,
  settleCodexSpeedUsage,
  translateAgentMessageDelta,
  translateItemNotification,
} from '../packages/maker-core/src/agents/codex/translator.js';
import { estimateWordTokens } from '../packages/maker-core/src/agents/shared/calibrated-token-speed.js';
import {
  emptyRateHistory,
  recordTokenSpeed,
  type TokenSpeedSnapshot,
} from '../packages/maker-shared/src/runningTokenRateHistory.js';

/** One recorded message with its arrival time: an Agent SDK message or a Codex notification. */
export interface CaptureLine {
  t: number;
  msg: Record<string, unknown>;
}

/** One model response as it really went, rebuilt from the usage it reported. */
interface Request {
  start: number;
  end: number;
  output: number;
  thinking: number;
  thinkingSpans: [number, number][];
  /** Arrival times and sizes of visible output; the real visible tokens are spread along them. */
  visible: [number, number][];
}

/** What measures the stream. The built-in ones run the code the app runs. */
export interface SpeedDriver {
  /** Feeds one message; returns true when the panel would refresh. */
  feed(line: CaptureLine): boolean;
  snapshot(now: number): TokenSpeedSnapshot | undefined;
}

interface Harness {
  model(lines: CaptureLine[]): string;
  requests(lines: CaptureLine[]): Request[];
  driver(): SpeedDriver;
}

interface ClaudeUsage { output_tokens?: number; output_tokens_details?: { thinking_tokens?: number } }
type ClaudeEvent = ClaudeSpeedStreamEvent & { usage?: ClaudeUsage };

function claudeEvent(line: CaptureLine): ClaudeEvent | undefined {
  return line.msg.type === 'stream_event' && !line.msg.parent_tool_use_id
    ? line.msg.event as ClaudeEvent | undefined : undefined;
}

const claude: Harness = {
  model: (lines) => lines.map((line) => claudeEvent(line)?.message?.model).find(Boolean) ?? '',
  requests(lines) {
    const requests: Request[] = [];
    let open: Request | null = null;
    let thinkingFrom: number | null = null;
    for (const line of lines) {
      const event = claudeEvent(line);
      if (!event) continue;
      const t = line.t;
      if (event.type === 'message_start') open = { start: t, end: t, output: 0, thinking: 0, thinkingSpans: [], visible: [] };
      if (!open) continue;
      if (event.type === 'content_block_start') thinkingFrom = event.content_block?.type === 'thinking' ? t : null;
      if (event.type === 'content_block_stop' && thinkingFrom !== null) {
        open.thinkingSpans.push([thinkingFrom, t]);
        thinkingFrom = null;
      }
      if (event.type === 'content_block_delta') {
        const text = event.delta?.text ?? event.delta?.partial_json;
        if (typeof text === 'string' && text.length > 0) open.visible.push([t, text.length]);
      }
      if (event.type === 'message_delta') {
        open.end = t;
        open.output = event.usage?.output_tokens ?? 0;
        open.thinking = Math.min(open.output, event.usage?.output_tokens_details?.thinking_tokens ?? 0);
        requests.push(open);
        open = null;
      }
    }
    return requests;
  },
  driver() {
    const state = newClaudeGenerationState();
    let turnOutput = 0;
    return {
      feed(line) {
        if (line.msg.type === 'result') state.tokenSpeed.stop(turnOutput, line.t);
        const event = claudeEvent(line);
        if (!event) return false;
        const due = observeClaudeSpeedEvent(state, event, line.t);
        if (event.type !== 'message_delta') return due;
        turnOutput += event.usage?.output_tokens ?? 0;
        state.tokenSpeed.pause(line.t);
        settleClaudeSpeedRequest(state, turnOutput, event.usage, line.t);
        return true;
      },
      snapshot: (now) => state.tokenSpeed.snapshot(now),
    };
  },
};

interface CodexItem { id?: string; type?: string }
interface CodexUsage { outputTokens?: number; reasoningOutputTokens?: number }
const codexItem = (line: CaptureLine): CodexItem | undefined =>
  (line.msg.params as { item?: CodexItem } | undefined)?.item;
const codexUsage = (line: CaptureLine): CodexUsage | undefined =>
  (line.msg.params as { tokenUsage?: { last?: CodexUsage } } | undefined)?.tokenUsage?.last;

const codex: Harness = {
  model: (lines) => String((lines.find((line) => line.msg.model)?.msg.model as string | undefined) ?? 'codex'),
  requests(lines) {
    const requests: Request[] = [];
    let open: Request | null = null;
    const thinkingFrom = new Map<string, number>();
    for (const line of lines) {
      const { t, msg } = line;
      const item = codexItem(line);
      const streams = item?.type === 'reasoning' || item?.type === 'agentMessage';
      if (msg.method === 'item/started' && streams) {
        open ??= { start: t, end: t, output: 0, thinking: 0, thinkingSpans: [], visible: [] };
        if (item?.type === 'reasoning' && item.id) thinkingFrom.set(item.id, t);
      }
      if (msg.method === 'item/completed' && streams && open) {
        open.end = t;
        const from = item?.id ? thinkingFrom.get(item.id) : undefined;
        if (from !== undefined) open.thinkingSpans.push([from, t]);
      }
      if (msg.method === 'item/agentMessage/delta' && open) {
        const words = estimateWordTokens(String((msg.params as { delta?: string }).delta ?? ''));
        if (words > 0) open.visible.push([t, words]);
        open.end = t;
      }
      const usage = codexUsage(line);
      if (msg.method === 'thread/tokenUsage/updated' && (usage?.outputTokens ?? 0) > 0) {
        // A response that only called a tool streams nothing: it has output and no stream time.
        const request = open ?? { start: t, end: t, output: 0, thinking: 0, thinkingSpans: [], visible: [] };
        request.output = usage?.outputTokens ?? 0;
        request.thinking = Math.min(request.output, usage?.reasoningOutputTokens ?? 0);
        requests.push(request);
        open = null;
      }
    }
    return requests;
  },
  driver() {
    const rt = newCodexRuntimeState();
    const log = { info() {}, warn() {}, debug() {}, error() {} };
    const queue = { push: () => true } as never;
    const ctx = { rt, log } as never;
    let lastRefresh = -Infinity;
    return {
      feed(line) {
        const { t, msg } = line;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const turnId = String((params.turn as { id?: string } | undefined)?.id ?? params.turnId ?? '');
        switch (msg.method) {
          case 'turn/started':
            beginCodexGenerationTurn(rt, turnId, t);
            return false;
          case 'item/started':
          case 'item/completed':
            translateItemNotification(msg.method === 'item/started' ? 'started' : 'completed', params as never, queue, ctx);
            return false;
          case 'item/agentMessage/delta':
            translateAgentMessageDelta(params as never, queue, ctx);
            // The agent refreshes its status after a delta, a few times a second at most.
            if (t - lastRefresh < 250) return false;
            lastRefresh = t;
            return true;
          case 'thread/tokenUsage/updated': {
            const last = codexUsage(line);
            if (!last || !((last.outputTokens ?? 0) > 0)) return false;
            settleCodexSpeedUsage(rt, { outputTokens: last.outputTokens ?? 0, reasoningOutputTokens: last.reasoningOutputTokens }, t);
            return true;
          }
          case 'turn/completed':
            finalizeCodexGenerationTurn(rt, turnId, t);
            rt.tokenSpeed.stop(undefined, t);
            return false;
          default:
            return false;
        }
      },
      snapshot: (now) => codexSpeedSnapshot(rt, now),
    };
  },
};

function harnessOf(lines: CaptureLine[]): Harness {
  return lines.some((line) => typeof line.msg.method === 'string') ? codex : claude;
}

export function readCapture(path: string): CaptureLine[] {
  const content = readFileSync(path, 'utf8');
  if (!path.endsWith('.json')) return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as CaptureLine);
  const recorded = JSON.parse(content) as RecordedStream | RecordedCodexStream;
  if (recorded.format === 'codex-stream-timing/1') {
    return [{ t: 0, msg: { model: recorded.model } }, ...expandCodexStream(recorded) as CaptureLine[]];
  }
  return expandRecordedStream(recorded) as CaptureLine[];
}

/** Real output received by `now`, and the stream time (first byte to last) that carried it. */
function truthOf(requests: Request[]) {
  const at = (now: number): { tokens: number; clockMs: number } => {
    let tokens = 0;
    let clockMs = 0;
    for (const request of requests) {
      if (now < request.start) break;
      clockMs += Math.min(now, request.end) - request.start;
      if (now >= request.end) {
        tokens += request.output;
        continue;
      }
      const thinkingMs = request.thinkingSpans.reduce((sum, [from, to]) => sum + (to - from), 0);
      const thinkingDone = request.thinkingSpans.reduce(
        (sum, [from, to]) => sum + Math.max(0, Math.min(now, to) - from), 0);
      if (thinkingMs > 0) tokens += request.thinking * (thinkingDone / thinkingMs);
      const visibleSize = request.visible.reduce((sum, [, size]) => sum + size, 0);
      const visibleDone = request.visible.reduce((sum, [time, size]) => sum + (time <= now ? size : 0), 0);
      if (visibleSize > 0) tokens += (request.output - request.thinking) * (visibleDone / visibleSize);
    }
    return { tokens, clockMs };
  };
  /** The wall time at which the stream clock read `clockMs`. */
  const whenClock = (clockMs: number): number => {
    let remaining = clockMs;
    for (const request of requests) {
      const span = request.end - request.start;
      if (remaining <= span) return request.start + remaining;
      remaining -= span;
    }
    return requests.at(-1)?.end ?? 0;
  };
  return { at, whenClock };
}

const WINDOW_MS = 5_000;

export interface ReplayResult {
  model: string;
  requests: number;
  realTokens: number;
  streamMs: number;
  /** Shown value divided by the real value, at every status update while running. */
  rate: number[];
  tokens: number[];
  average: number[];
  firstReadingMs: number | null;
  final: TokenSpeedSnapshot | undefined;
  chart: number[];
  peak: number;
}

export function replay(lines: CaptureLine[], driver?: SpeedDriver): ReplayResult {
  const harness = harnessOf(lines);
  const requests = harness.requests(lines);
  const truth = truthOf(requests);
  const measure = driver ?? harness.driver();
  const result: ReplayResult = {
    model: harness.model(lines),
    requests: requests.length,
    realTokens: requests.reduce((sum, request) => sum + request.output, 0),
    streamMs: requests.reduce((sum, request) => sum + (request.end - request.start), 0),
    rate: [], tokens: [], average: [], firstReadingMs: null, final: undefined, chart: [], peak: 0,
  };
  let history = emptyRateHistory(null);
  let lastRate = 0;
  const firstStart = requests[0]?.start ?? 0;
  // The Codex translator reads the clock itself: let it read the recording's.
  const realNow = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    for (const line of lines) {
      clock = line.t;
      if (!measure.feed(line)) continue;
      const shown = measure.snapshot(line.t);
      if (!shown) continue;
      history = recordTokenSpeed(history, { startedAt: 1, speed: shown, now: line.t });
      const real = truth.at(line.t);
      if (real.clockMs < 1_000 || real.tokens < 20) continue;
      result.tokens.push(shown.tokens / real.tokens);
      if (shown.average > 0) result.average.push(shown.average / ((real.tokens * 1_000) / real.clockMs));
      if (!shown.streaming) continue;
      const before = truth.at(truth.whenClock(Math.max(0, real.clockMs - WINDOW_MS)));
      const realRate = ((real.tokens - before.tokens) * 1_000) / (real.clockMs - before.clockMs);
      // Only a reading that changed is a new measurement; a held one was judged when it was taken.
      if (shown.rate > 0 && shown.rate !== lastRate && realRate > 0) {
        result.rate.push(shown.rate / realRate);
        result.firstReadingMs ??= line.t - firstStart;
      }
      lastRate = shown.rate;
    }
    const end = lines.at(-1)?.t ?? 0;
    result.final = measure.snapshot(end);
    if (result.final) history = recordTokenSpeed(history, { startedAt: 1, speed: result.final, now: end });
  } finally {
    Date.now = realNow;
  }
  result.chart = history.samples.map((sample) => sample.rate);
  result.peak = history.peak;
  return result;
}

function quantiles(values: number[]): string {
  if (values.length === 0) return 'no readings';
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number): string => sorted[Math.floor(p * (sorted.length - 1))].toFixed(2);
  return `p10 ${q(0.1)}  p50 ${q(0.5)}  p90 ${q(0.9)}  (n=${sorted.length})`;
}

export function printReport(name: string, result: ReplayResult): void {
  const realTps = (result.realTokens * 1_000) / result.streamMs;
  console.log(`\n${name}: ${result.model}, ${result.requests} requests, ${result.realTokens} real output tokens over ` +
    `${(result.streamMs / 1_000).toFixed(1)}s of stream = ${realTps.toFixed(1)} tok/s`);
  console.log('  shown / real while the turn runs (1.00 = exact)');
  console.log(`    recent speed   ${quantiles(result.rate)}` +
    (result.firstReadingMs !== null ? `, first reading after ${(result.firstReadingMs / 1_000).toFixed(1)}s` : ''));
  console.log(`    output so far  ${quantiles(result.tokens)}`);
  console.log(`    turn average   ${quantiles(result.average)}`);
  const final = result.final;
  console.log(final
    ? `  when the turn ended: ${final.tokens} tokens (real ${result.realTokens}), average ${final.average.toFixed(1)} tok/s ` +
      `(real ${realTps.toFixed(1)}), peak ${result.peak.toFixed(0)} tok/s`
    : '  when the turn ended: nothing shown');
  if (result.chart.length > 0) {
    console.log(`  chart: ${result.chart.length} points, ${Math.min(...result.chart).toFixed(0)}–${Math.max(...result.chart).toFixed(0)} tok/s`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtures = ['claude-code', 'codex'].map((agent) =>
    fileURLToPath(new URL(`../packages/maker-core/src/agents/${agent}/fixtures`, import.meta.url)));
  const paths = process.argv.length > 2 ? process.argv.slice(2) : fixtures.flatMap((dir) => {
    try {
      return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
    } catch {
      return [];
    }
  });
  for (const path of paths) printReport(basename(path), replay(readCapture(path)));
}
