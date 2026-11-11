/**
 * Local history of the Cindy balance, used to estimate daily burn for the menu bar.
 *
 * The server only reports the current balance, so main records what it observes. Rises
 * (top-ups, grants) are ignored; only drops count as spending. Samples older than the
 * retention window are dropped on every write, and the file holds amounts only. It lives in
 * the signed-in account's own data folder, so another account never sees it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';

const log = createLogger('menubar:credit-samples');

const DAY_MS = 86_400_000;
export const CREDIT_SAMPLE_RETENTION_MS = 30 * DAY_MS;
export const CREDIT_BURN_WINDOW_MS = 7 * DAY_MS;
/** Burn needs at least this much observed history to say anything useful. */
export const CREDIT_BURN_MIN_SPAN_MS = DAY_MS;
/** Samples closer together than this replace each other instead of piling up. */
const MIN_SAMPLE_GAP_MS = 10 * 60_000;
const MAX_SAMPLES = 2_000;

export interface CreditSample {
  atMs: number;
  available: number;
}

interface CreditSampleFile {
  version: 1;
  /** Account scope plus currency; samples from another account or region are discarded. */
  key: string;
  samples: CreditSample[];
}

/** Adds a sample, keeping the list sorted, pruned and not denser than one per 10 minutes. */
export function appendCreditSample(samples: readonly CreditSample[], next: CreditSample, nowMs: number): CreditSample[] {
  const kept = samples.filter((sample) => nowMs - sample.atMs <= CREDIT_SAMPLE_RETENTION_MS && sample.atMs < next.atMs);
  // Measured from the sample before the newest one: the newest is the running tail of the current
  // 10 minutes and gets replaced, so frequent reads still leave one sample per 10 minutes.
  const anchor = kept[kept.length - 2];
  if (anchor && next.atMs - anchor.atMs < MIN_SAMPLE_GAP_MS) {
    kept[kept.length - 1] = next;
  } else {
    kept.push(next);
  }
  return kept.slice(-MAX_SAMPLES);
}

/** Average daily spending over the last week, or null without a day of history. */
export function estimateDailyBurn(samples: readonly CreditSample[], nowMs: number): number | null {
  const recent = samples.filter((sample) => nowMs - sample.atMs <= CREDIT_BURN_WINDOW_MS);
  if (recent.length < 2) return null;
  const span = recent[recent.length - 1].atMs - recent[0].atMs;
  if (span < CREDIT_BURN_MIN_SPAN_MS) return null;
  let spent = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const drop = recent[i - 1].available - recent[i].available;
    if (drop > 0) spent += drop;
  }
  return spent / (span / DAY_MS);
}

/** Largest balance seen recently, the fallback for "full" when the server has no pool totals. */
export function largestCreditSample(samples: readonly CreditSample[]): number | null {
  let largest: number | null = null;
  for (const sample of samples) {
    if (largest === null || sample.available > largest) largest = sample.available;
  }
  return largest;
}

export class CreditSampleStore {
  private cache: CreditSampleFile | null = null;
  /** File the cache was read from; the path follows the signed-in account. */
  private cachePath: string | null = null;

  constructor(private readonly filePath: () => string = () => ownerScopedUserDataPath('menubar-credit-samples.json')) {}

  /** Records an observation and returns the samples recorded under the same key. */
  record(key: string, available: number, atMs: number): CreditSample[] {
    const target = this.filePath();
    const file = this.load(target);
    // A region or currency change makes old amounts meaningless.
    const base = file.key === key ? file.samples : [];
    const samples = appendCreditSample(base, { atMs, available }, atMs);
    this.cache = { version: 1, key, samples };
    this.save(target, this.cache);
    return samples;
  }

  private load(target: string): CreditSampleFile {
    if (this.cache && this.cachePath === target) return this.cache;
    this.cachePath = target;
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<CreditSampleFile>;
      const samples = Array.isArray(parsed.samples)
        ? parsed.samples.filter(
            (sample): sample is CreditSample =>
              !!sample &&
              Number.isFinite((sample as CreditSample).atMs) &&
              Number.isFinite((sample as CreditSample).available),
          )
        : [];
      samples.sort((a, b) => a.atMs - b.atMs);
      this.cache = { version: 1, key: typeof parsed.key === 'string' ? parsed.key : '', samples };
    } catch {
      this.cache = { version: 1, key: '', samples: [] };
    }
    return this.cache;
  }

  private save(target: string, file: CreditSampleFile): void {
    const temp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(file), 'utf8');
      fs.renameSync(temp, target);
    } catch (error) {
      log.warn('could not save credit samples', { error: error instanceof Error ? error.message : String(error) });
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing else to clean up.
      }
    }
  }
}
